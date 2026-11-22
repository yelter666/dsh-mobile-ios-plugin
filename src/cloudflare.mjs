// cloudflare.mjs — Pro 固定地址：一个 tunnel + 一个子域 + 一份 token 的自动开通
//
// 三种凭证必须先分清，否则一定会把 zone 权限塞进客户端：
//   · Zone API Token：能建/删整个 matrixboard.cn 的 DNS。**只能待在运营方**，
//     一旦随桌面端分发，任何用户都能把域名迁走。
//   · Tunnel Token：只对单个 tunnel 有效的 JWT，给 cloudflared 用，可在主机落盘。
//   · 子域名：由安装标识派生，稳定、不可猜、可回收。
//
// 因此这里提供两条同构路径，REST 层与 UI 不需要知道背后是谁：
//   CloudflareProvisioner —— 自托管 / 运营调试：主机侧直连 CF API（需 zone token）
//   HostedProvisioner     —— 产品形态：主机拿 enroll 凭证向开通服务换三件套
//
// 共同语义（不可放松）：
//   1. 幂等：重复 ensure 不重建 tunnel、不重复写 DNS；
//   2. token 只落盘 0600，永不出现在 status()/日志/诊断包里；
//   3. 端口变了要重写 ingress（端口会因占用顺延，写死会指向空气）；
//   4. 失败要能定位：CF 的错误码原样带上，但不带 token。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fail } from './protocol.mjs';
import { deriveSubdomain, isValidLabel } from './dns-label.mjs';
import { DNS_PENDING_HINT, DNS_TAMPER_HINT, dnsWarningFor, evaluateDnsAnswer, probeDns } from './dns-probe.mjs';
import { LocalProvisioner, LocalStateProvisioner, sanitizeZone } from './provision-local.mjs';
import { diagnoseZone, findDnsOwner, verifyCertAccess, ZONE_STATUS_HINT } from './zone-health.mjs';

// 兼容既有调用方与测试：子域规则从 dns-label.mjs 来，这里一并导出
export { deriveSubdomain, isValidLabel };

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const STATE_VERSION = 1;

function loadState(file, log) {
  if (!file) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STATE_VERSION) throw new Error('结构不符');
    if (!parsed.hostname || !parsed.tunnelId) throw new Error('缺少 hostname/tunnelId');
    return parsed;
  } catch (err) {
    // 与设备注册表同一取舍：插件跑在宿主进程内，坏文件不该带崩宿主。
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(file, backup);
      log?.(`tunnel 开通状态损坏，已备份到 ${path.basename(backup)}（${err.message}）`);
    } catch {
      log?.(`tunnel 开通状态损坏且备份失败（${err.message}）`);
    }
    return null;
  }
}

function saveState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = JSON.stringify({ version: STATE_VERSION, ...state }, null, 2);
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* 刚写即 0600 */ }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* rename 成功时已不存在 */ }
  }
}

class BaseProvisioner {
  constructor({ stateFile = null, log = () => {}, baseDomain = 'matrixboard.cn', probe = null, zoneDiagnose = null } = {}) {
    this.stateFile = stateFile;
    this.log = log;
    this.baseDomain = String(baseDomain).replace(/^\./, '').toLowerCase();
    this._state = undefined; // undefined=未读；null=没有
    // 可注入：测试里不该真发 DNS 查询（依赖外网且要等重试）
    this.probe = probe || probeDns;
    // 解析失败时进一步归因（moved / pending / ns-mismatch）；不注入就只报「解析不到」
    this.zoneDiagnose = zoneDiagnose;
    this._zone = null;
  }

  /**
   * 复核固定域名的公网解析，结论写回状态。
   *
   * 只做一次就够：确认可解析后 `dnsOk=true` 会被持久化，后续启动不再查；
   * 没确认过（null，例如老状态文件）或上次失败（false）才复查——
   * 否则「域名不可用」会因为状态文件存在而被永久固化，NS 改好了也发现不了。
   */
  async verifyDns(hostname = this.state?.hostname) {
    if (!hostname) return { ok: false, kind: null, records: [] };
    const check = await this.probe(hostname);
    const current = this.state;
    // 防劫持：CNAME 必须仍指向**本机**隧道（评估逻辑在 dns-probe.evaluateDnsAnswer）。
    // 记录若被人改指到别的隧道/服务器，解析照样「成功」，流量却会落到对方 ingress——
    // 这时按「地址不可用」处理，绝不下发。
    const verdict = evaluateDnsAnswer(check, current?.tunnelId);
    // 解析不到时再问一句「这域名现在归谁」：moved（被别的账号接管）与 pending（NS 还没指过来）
    // 的修法完全不同，笼统一句「等 NS 生效」会让人白等。
    let zone = null;
    if (!verdict.ok && typeof this.zoneDiagnose === 'function') {
      try {
        zone = sanitizeZone(await this.zoneDiagnose({ baseDomain: this.baseDomain, dnsOk: false }));
      } catch {
        zone = null;
      }
      this._zone = zone;
    }
    if (current && current.hostname === hostname) {
      this.#persist({
        ...current,
        dnsOk: verdict.ok,
        dnsTampered: verdict.tampered,
        dnsCheckedAt: new Date().toISOString(),
        zone,
      });
    }
    if (verdict.tampered) {
      this.log(`tunnel 警告 固定地址解析被改指 ${hostname} → ${verdict.target}（期望 ${verdict.expected}），拒绝下发该地址`);
    } else if (verdict.ok) {
      this.log(`tunnel 固定地址已可解析 ${hostname}（${verdict.kind} ${verdict.records.join(',')}）`);
    } else {
      this.log(`tunnel 警告 固定地址公网解析不到 ${hostname}`);
    }
    return verdict;
  }

  /**
   * 面板「重新检测解析」：强制重探一次并写回状态，不做缓存短路。
   * 与 LocalProvisioner.recheckDns 同一契约，面板对两种开通形态一视同仁。
   */
  async recheckDns() {
    const s = this.state;
    if (!s?.hostname) return { provisioned: false, ok: false, tampered: false, warning: null, zone: null };
    const verdict = await this.verifyDns(s.hostname);
    const now = this.state;
    return {
      provisioned: true,
      hostname: now.hostname,
      ok: Boolean(verdict.ok),
      tampered: Boolean(verdict.tampered),
      expected: verdict.expected ?? null,
      target: verdict.target ?? null,
      warning: dnsWarningFor(now),
      checkedAt: now.dnsCheckedAt ?? null,
      zone: now.zone ?? this._zone ?? null,
    };
  }

  /** 状态文件里的缓存（读一次后常驻；写穿时同步更新）。 */
  get state() {
    if (this._state === undefined) this._state = loadState(this.stateFile, this.log);
    return this._state;
  }

  #persist(next) {
    this._state = next;
    try {
      saveState(this.stateFile, next);
    } catch (err) {
      // 落盘失败不该阻断本次开通（重启后重开会再换一份 token，仍是幂等的）
      this.log(`tunnel 开通状态写入失败（本次仍可用）：${err.message}`);
    }
    return next;
  }

  get url() {
    return this.state ? `https://${this.state.hostname}` : null;
  }

  /** 对外可播报的信息：绝不含 token。 */
  status() {
    const s = this.state;
    if (!s) return { kind: this.kind, provisioned: false, hostname: null, url: null, tunnelId: null };
    return {
      kind: this.kind,
      provisioned: true,
      hostname: s.hostname,
      url: `https://${s.hostname}`,
      tunnelId: s.tunnelId,
      port: s.port ?? null,
      // null = 还没验过；true/false = 验过且结论明确
      dnsOk: s.dnsOk ?? null,
      dnsCheckedAt: s.dnsCheckedAt ?? null,
      zone: s.zone ?? this._zone ?? null,
      warning: dnsWarningFor(s),
      createdAt: s.createdAt ?? null,
      updatedAt: s.updatedAt ?? null,
    };
  }

  /**
   * 开通/复用固定地址。返回 `{ hostname, url, tunnelId, created, changed }`。
   *
   * `port` 一定要传当前监听端口：端口被占用时网关会顺延，ingress 写死旧端口
   * 会让公网地址 502，而用户完全看不出原因。
   */
  async ensure({ port, force = false } = {}) {
    if (!this.configured) throw fail(4021, this.notConfiguredMessage, { detail: this.notConfiguredDetail });
    if (!Number.isInteger(port) || port <= 0) throw fail(4400, '开通隧道需要有效端口');

    const cached = this.state;
    // hosted 形态的旧版状态文件只有 hostname/tunnelId/credentialsFile，没有 token
    // （0.3.3 之前的 local 形态落的状态）。短路必须要求 token 在手，否则起不了
    // cloudflared 还报「token 缺失」——这种状态要走一次重新开通（子域回传，地址不漂移）。
    const shortCircuit = cached && cached.port === port
      && (this.kind !== 'hosted' || cached.token);
    if (!force && shortCircuit) {
      // 已确认可解析就不再查；否则现场验一次，避免把「未生效」固化在状态里
      if (cached.dnsOk !== true) await this.verifyDns(cached.hostname);
      const s = this.state;
      return {
        hostname: s.hostname,
        url: `https://${s.hostname}`,
        tunnelId: s.tunnelId,
        created: false,
        changed: false,
        dnsOk: s.dnsOk ?? null,
        warning: dnsWarningFor(s),
      };
    }

    const fresh = await this.provision({ port, cached });
    const now = new Date().toISOString();
    const next = this.#persist({
      ...cached,
      ...fresh,
      port,
      createdAt: cached?.createdAt ?? now,
      updatedAt: now,
    });
    this.log(`tunnel 固定地址就绪 ${next.hostname}（${fresh.created ? '新建' : '复用'}）`);
    // 开通即自检：写成功 ≠ 公网能解析
    if (next.dnsOk !== true) await this.verifyDns(next.hostname);
    const done = this.state;
    return {
      hostname: done.hostname,
      url: `https://${done.hostname}`,
      tunnelId: done.tunnelId,
      created: Boolean(fresh.created),
      changed: Boolean(cached && cached.hostname !== next.hostname),
      dnsOk: done.dnsOk ?? null,
      warning: dnsWarningFor(done),
    };
  }

  /**
   * 取 cloudflared 要用的 `{ hostname, token }`。**仅供网关进程内部调用**，
   * REST 层不得把它序列化出去。
   */
  async credential({ port }) {
    await this.ensure({ port });
    if (!this.state?.token) throw fail(4500, '隧道 token 缺失，请重新开通固定地址');
    return { hostname: this.state.hostname, token: this.state.token };
  }

  /** 主机侧要用的一次性凭证/配置是否齐备。 */
  get configured() {
    return false;
  }

  get notConfiguredMessage() {
    return '主机未配置隧道开通凭据';
  }

  get notConfiguredDetail() {
    return null;
  }

  /** 非本地形态没有 cert.pem 可预检；面板统一按「无凭据信息」处理。 */
  get credentials() {
    return null;
  }

  /** 重置本机状态：token 形态由状态文件承载，删掉即「重新开通」。 */
  async reset() {
    let removed = [];
    try {
      if (this.stateFile && fs.statSync(this.stateFile).isFile()) {
        fs.unlinkSync(this.stateFile);
        removed = [path.basename(this.stateFile)];
      }
    } catch { /* 不存在即目标状态 */ }
    const hadState = Boolean(this.state?.hostname);
    this._state = null;
    this._zone = null;
    return { reset: true, hadState, removed, hostname: null, provisioned: false };
  }
}

/**
 * 直连 Cloudflare API 的开通器（运营/自托管）。
 *
 * 需要的权限（最小集）：
 *   · Account → Cloudflare Tunnel: Edit
 *   · Zone(matrixboard.cn) → DNS: Edit
 *   · Zone(matrixboard.cn) → Zone: Read（用于把域名解析成 zoneId）
 */
export class CloudflareProvisioner extends BaseProvisioner {
  constructor({
    apiToken = null,
    accountId = null,
    zoneId = null,
    baseDomain = 'matrixboard.cn',
    prefix = 'dsh',
    stateFile = null,
    seed = null,
    fetchImpl = globalThis.fetch,
    apiBase = CF_API_BASE,
    log = () => {},
    probe = null,
    zoneDiagnose = null,
  } = {}) {
    super({ stateFile, log, baseDomain, probe, zoneDiagnose });
    this.apiToken = apiToken;
    this.accountId = accountId;
    this.zoneId = zoneId;
    this.prefix = prefix;
    this.seed = seed;
    this.fetchImpl = fetchImpl;
    this.apiBase = String(apiBase).replace(/\/$/, '');
    // API 形态本身就有 zone 级凭据，不必借 cert.pem：解析失败时直接问清 zone 现状
    this.zoneDiagnose = zoneDiagnose || ((args = {}) => diagnoseZone({
      ...args,
      apiToken: this.apiToken,
      zoneId: this.zoneId,
      baseDomain: args.baseDomain || this.baseDomain,
      fetchImpl: this.fetchImpl,
      apiBase: this.apiBase,
    }));
  }

  get kind() {
    return 'cloudflare';
  }

  get configured() {
    // accountId 不强制：一个 Token 往往只属于一个账号，让 API 自己说到底是谁，
    // 比要求用户去面板抄一串 32 位十六进制更不容易出错。
    return Boolean(this.apiToken && this.baseDomain && typeof this.fetchImpl === 'function');
  }

  get notConfiguredMessage() {
    return '主机未配置 Cloudflare 凭据，无法开通固定地址';
  }

  get notConfiguredDetail() {
    return '需要一个带 Account → Cloudflare Tunnel: Edit、Zone → DNS: Edit/Zone: Read 的 API Token；'
      + '也可改用 hosted 开通服务（见 config.tunnel.provisioner）';
  }

  async #api(method, pathname, body) {
    let res;
    try {
      res = await this.fetchImpl(`${this.apiBase}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw fail(4500, `无法连接 Cloudflare API：${err.message}`);
    }
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw fail(4500, `Cloudflare API 返回了非 JSON 响应（HTTP ${res.status}）`);
    }
    if (!payload || payload.success !== true) {
      const first = payload?.errors?.[0];
      // 只透出 CF 自己的话，不带 Authorization
      throw fail(4500, `Cloudflare 拒绝了请求：${first?.message || `HTTP ${res.status}`}`, {
        status: res.status,
        cfCode: first?.code ?? null,
      });
    }
    return payload.result;
  }

  /**
   * 确定 accountId。Token 能看见几个账号就用几个：
   * 恰好一个 → 直接用它（绝大多数情况）；多个 → 必须显式指定，否则可能开到别人的账号里。
   */
  async #ensureAccount() {
    if (this.accountId) return this.accountId;
    const raw = await this.#api('GET', '/accounts');
    const list = (Array.isArray(raw) ? raw : []).filter((a) => a && a.id);
    if (list.length === 1) {
      this.accountId = list[0].id;
      this.log?.(`tunnel 账号自动识别为 ${list[0].name || list[0].id}`);
      return this.accountId;
    }
    if (!list.length) {
      throw fail(4021, 'API Token 看不到任何 Cloudflare 账号', {
        detail: 'Token 需要 Account → Cloudflare Tunnel: Edit 权限',
      });
    }
    throw fail(4021, 'API Token 可见多个 Cloudflare 账号，请显式指定 accountId', {
      detail: list.map((a) => a.name || a.id).join(' / '),
    });
  }

  async #ensureZone() {
    if (this.zoneId) return this.zoneId;
    const zones = await this.#api('GET', `/zones?name=${encodeURIComponent(this.baseDomain)}`);
    const zone = Array.isArray(zones) ? zones.find((z) => z.name === this.baseDomain) : null;
    if (!zone) {
      throw fail(4021, `Cloudflare 账号里找不到域名 ${this.baseDomain}`, {
        detail: '确认该域名已接入当前账号；若用子账号，API Token 需要能看到这个 zone',
      });
    }
    if (zone.status && zone.status !== 'active') {
      // 状态不同，修法完全不同：moved 说明域名已被另一个 Cloudflare 账号接管，
      // 在本账号重试一万次也不会生效；pending 只是 NS 还没指过来。
      const hint = ZONE_STATUS_HINT[zone.status] || `状态 ${zone.status}`;
      const ns = (zone.name_servers || []).join(' / ') || '(当前账号未分配)';
      throw fail(4021, `域名 ${this.baseDomain} 未生效：${hint}`, {
        detail: zone.status === 'moved'
          ? `本账号分配的公网 NS 是 ${ns}。域名现在被另一个 Cloudflare 账号接管，本账号写入的记录不会下发——`
            + '要么在注册商把 NS 改回这一对，要么统一只用同一个 Cloudflare 账号登录（两边互斥，只能二选一）。'
          : `本账号分配的公网 NS 是 ${ns}；到域名注册商把 NS 改成这一对，生效后再开通。`,
        zoneStatus: zone.status,
        expectedNs: zone.name_servers || [],
      });
    }
    this.zoneId = zone.id;
    this._zone = zone; // 供 requiredNameservers() 复用，避免为了一句提示再查一次
    return zone.id;
  }

  /**
   * 这个 zone 要求域名指向的 NS。用于「名称服务器无效」时的可执行提示：
   * 用户拿到这两个名字去注册商改，比让他理解 pending zone 的概念有效得多。
   */
  async requiredNameservers() {
    if (this._zone?.name_servers?.length) return this._zone.name_servers;
    try {
      const zones = await this.#api('GET', `/zones?name=${encodeURIComponent(this.baseDomain)}`);
      const zone = (Array.isArray(zones) ? zones : []).find((z) => z.name === this.baseDomain);
      if (zone) {
        this._zone = zone;
        return zone.name_servers || [];
      }
    } catch {
      /* 权限不足时只是少一句提示，不该让开通失败 */
    }
    return [];
  }

  async #ensureTunnel(name) {
    const list = await this.#api(
      'GET',
      `/accounts/${this.accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
    );
    // REST 这边未删除给的是 null，与 CLI 的 "0001-01-01T00:00:00Z" 不同；
    // 两种都按「没删」处理，免得两条开通路径对同一条隧道得出相反结论。
    const hit = (Array.isArray(list) ? list : []).find((t) => t && t.name === name
      && (!t.deleted_at || String(t.deleted_at).startsWith('0001-01-01')));
    if (hit) {
      // 本地管理型 tunnel 不接受远端 ingress 下发，拿 token 跑起来会没有路由。
      if (hit.remote_config === false) {
        throw fail(4021, `已存在同名本地管理隧道 ${name}`, {
          detail: '在 Cloudflare 面板删掉它，或换一个开通前缀；本方案只用 remotely-managed tunnel',
        });
      }
      return { id: hit.id, created: false };
    }
    const created = await this.#api('POST', `/accounts/${this.accountId}/cfd_tunnel`, {
      name,
      config_src: 'cloudflare',
    });
    return { id: created.id, created: true };
  }

  async #putIngress(tunnelId, hostname, port) {
    await this.#api('PUT', `/accounts/${this.accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      config: {
        ingress: [
          { hostname, service: `http://127.0.0.1:${port}` },
          // 兜底规则是 CF 的硬要求：最后一条必须无 hostname，否则保存被拒。
          { service: 'http_status:404' },
        ],
      },
    });
  }

  async #upsertDns(zoneId, fqdn, tunnelId) {
    const target = `${tunnelId}.cfargotunnel.com`;
    const list = await this.#api(
      'GET',
      `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(fqdn)}`,
    );
    const existing = (Array.isArray(list) ? list : [])[0];
    const record = { type: 'CNAME', name: fqdn, content: target, proxied: true, ttl: 1 };
    if (existing) {
      if (String(existing.content || '').toLowerCase() === target) return { created: false };
      await this.#api('PUT', `/zones/${zoneId}/dns_records/${existing.id}`, record);
      return { created: false, updated: true };
    }
    await this.#api('POST', `/zones/${zoneId}/dns_records`, { ...record, comment: 'dsh-mobile pro tunnel' });
    return { created: true };
  }

  async provision({ port, cached }) {
    const installationId = cached?.installationId || crypto.randomBytes(16).toString('hex');
    await this.#ensureAccount();
    const zoneId = await this.#ensureZone();
    const label = cached?.subdomain || deriveSubdomain(this.seed || installationId, { prefix: this.prefix });
    const hostname = `${label}.${this.baseDomain}`;
    const tunnel = await this.#ensureTunnel(label);
    // token 只在第一次（或状态文件丢失）时取；CF 侧 token 不会因为重启而变。
    let token = cached?.token;
    if (!token || cached.tunnelId !== tunnel.id) {
      token = await this.#api('GET', `/accounts/${this.accountId}/cfd_tunnel/${tunnel.id}/token`);
    }
    await this.#putIngress(tunnel.id, hostname, port);
    await this.#upsertDns(zoneId, hostname, tunnel.id);
    return {
      installationId,
      subdomain: label,
      hostname,
      tunnelId: tunnel.id,
      token,
      created: tunnel.created,
    };
  }
}

/**
 * 通过开通服务换三件套（产品形态）。
 *
 * 合约（服务端实现同样语义即可）：
 *   POST {endpoint}/v1/tunnel
 *   Authorization: Bearer <enroll token>
 *   { "hostId": "...", "port": 3081, "subdomain": "dsh-xxxx"|null }
 *   → { "hostname": "dsh-xxxx.matrixboard.cn", "tunnelId": "...", "token": "eyJ..." }
 *
 * 主机侧只保存 enroll 凭证与换回来的 tunnel token，永远看不到 zone 级权限。
 */
export class HostedProvisioner extends BaseProvisioner {
  constructor({
    endpoint = null,
    enrollToken = null,
    hostId = null,
    baseDomain = 'matrixboard.cn',
    stateFile = null,
    fetchImpl = globalThis.fetch,
    log = () => {},
    probe = null,
  } = {}) {
    super({ stateFile, log, baseDomain, probe });
    this.endpoint = endpoint ? String(endpoint).replace(/\/$/, '') : null;
    this.enrollToken = enrollToken;
    this.hostId = hostId;
    this.fetchImpl = fetchImpl;
  }

  get kind() {
    return 'hosted';
  }

  get configured() {
    return Boolean(this.endpoint && this.enrollToken && typeof this.fetchImpl === 'function');
  }

  get notConfiguredMessage() {
    return '主机未加入固定地址开通服务';
  }

  get notConfiguredDetail() {
    return '需要 config.tunnel.endpoint 与 enrollToken（Pro 订阅后由账号体系下发）';
  }

  async provision({ port, cached }) {
    let res;
    try {
      res = await this.fetchImpl(`${this.endpoint}/v1/tunnel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.enrollToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          hostId: this.hostId,
          port,
          subdomain: cached?.subdomain ?? null,
        }),
      });
    } catch (err) {
      throw fail(4500, `无法连接固定地址开通服务：${err.message}`);
    }
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw fail(4500, `开通服务返回了非 JSON 响应（HTTP ${res.status}）`);
    }
    if (!res.ok || !body) {
      throw fail(4500, `开通服务拒绝了请求：${body?.message || body?.error?.message || `HTTP ${res.status}`}`, {
        status: res.status,
      });
    }
    const hostname = String(body.hostname || '').toLowerCase();
    // 服务端被攻陷时也不能把用户手机引到别的域名去。
    if (!hostname.endsWith(`.${this.baseDomain}`)) {
      throw fail(4500, `开通服务返回的域名不在 ${this.baseDomain} 下，已拒绝`);
    }
    if (!body.tunnelId || !body.token) throw fail(4500, '开通服务返回内容不完整（缺 tunnelId/token）');
    return {
      installationId: cached?.installationId || crypto.randomBytes(16).toString('hex'),
      subdomain: hostname.slice(0, -(this.baseDomain.length + 1)),
      hostname,
      tunnelId: String(body.tunnelId),
      token: String(body.token),
      created: true,
    };
  }
}

/**
 * 只读现有开通状态（kind=state）。
 *
 * 用途：**已经开通过的机器日常启动**。此时主机不该再持有 zone 级凭据——
 * token 与固定域名在 0600 状态文件里就够了，cloudflared 也只认 token。
 * 这也正是产品形态：开通是一次性的服务端动作，之后本机离线也能起隧道。
 *
 * 唯一代价：端口顺延后无法自行改写 CF 侧 ingress（那需要 API 凭据）。
 * 这种情况必须**如实报错**，而不是让公网地址 502 给用户一个「连上了但没数据」。
 */
export class StateProvisioner extends BaseProvisioner {
  constructor({ stateFile = null, baseDomain = 'matrixboard.cn', log = () => {}, probe = null } = {}) {
    super({ stateFile, log, baseDomain, probe });
  }

  get kind() {
    return 'state';
  }

  get configured() {
    return Boolean(this.state?.hostname && this.state?.token);
  }

  get notConfiguredMessage() {
    return '这台主机还没有开通固定地址';
  }

  get notConfiguredDetail() {
    return '先配置 Cloudflare 凭据或开通服务跑一次开通；之后日常启动只需状态文件';
  }

  async provision({ port, cached }) {
    if (!cached?.token || !cached?.hostname) throw fail(4021, this.notConfiguredMessage);
    if (cached.port && port && cached.port !== port) {
      throw fail(4021, `固定地址目前指向端口 ${cached.port}，当前监听 ${port}`, {
        detail: '端口变化需要带上 Cloudflare 凭据重新开通一次（改写 ingress），否则公网地址会 502',
      });
    }
    return { ...cached, created: false };
  }
}

/** 按配置挑一个开通器；都不满足时返回 null（隧道退化成 Quick Tunnel）。 */
export function createProvisioner(config = {}, { log = () => {}, stateFile = null, hostId = null } = {}) {
  // 没显式指定时按凭据推断：有开通服务地址就走 hosted，否则直连 CF。
  // 硬性默认 cloudflare 会让「只配了 endpoint」的主机静默退回 Quick Tunnel。
  const kind = String(config.provisioner || (config.endpoint ? 'hosted' : 'cloudflare')).toLowerCase();
  if (kind === 'cloudflare') {
    const provisioner = new CloudflareProvisioner({
      apiToken: config.apiToken || null,
      accountId: config.accountId || null,
      zoneId: config.zoneId || null,
      baseDomain: config.baseDomain || 'matrixboard.cn',
      prefix: config.prefix || 'dsh',
      seed: config.seed || null,
      stateFile,
      log,
    });
    return provisioner.configured ? provisioner : null;
  }
  if (kind === 'local') {
    return new LocalProvisioner({
      baseDomain: config.baseDomain || 'matrixboard.cn',
      prefix: config.prefix || 'dsh',
      executable: config.executable || 'cloudflared',
      stateFile,
      configFile: config.configFile || null,
      seed: config.seed || null,
      // 默认当前用户；显式传入便于测试与「非标准 home」的宿主环境
      homeDir: config.homeDir || os.homedir(),
      log,
      // 生产路径才接真实探测：测试直接 new LocalProvisioner 时保持零网络依赖
      zoneDiagnose: diagnoseZone,
      ownerLookup: findDnsOwner,
      // 开通前凭据预检：跨账号的 cert.pem 必须在写 DNS **之前**被识别出来
      verifyAccess: verifyCertAccess,
      hostname: os.hostname(),
    });
  }
  if (kind === 'state') {
    // 先按 token 形态找；找不到再按**本地管理型**状态找（cert.pem 被删了也能继续用固定地址）。
    // 返回 null 的语义是「这台机器确实没有可复用的固定地址」，而不是「凭据不全就降级成随机地址」。
    const byToken = new StateProvisioner({
      stateFile,
      baseDomain: config.baseDomain || 'matrixboard.cn',
      log,
    });
    if (byToken.configured) return byToken;
    const byLocal = new LocalStateProvisioner({
      stateFile,
      configFile: config.configFile || null,
      baseDomain: config.baseDomain || 'matrixboard.cn',
      homeDir: config.homeDir || os.homedir(),
      log,
    });
    return byLocal.configured ? byLocal : null;
  }
  if (kind === 'hosted') {
    const provisioner = new HostedProvisioner({
      endpoint: config.endpoint || null,
      enrollToken: config.enrollToken || null,
      hostId,
      baseDomain: config.baseDomain || 'matrixboard.cn',
      stateFile,
      log,
    });
    return provisioner.configured ? provisioner : null;
  }
  return null;
}
