// test/tunnel-named.mjs — Pro 固定地址：开通、token 边界、named 隧道生命周期、隧道来源请求
//
// 立场：
//   1. **不真的打 Cloudflare**。用假 fetch 把「建 tunnel / 取 token / 下发 ingress /
//      写 DNS」四次调用的请求体逐字断言——这些字段写错在真实 API 上是 400，靠人眼看不出来。
//   2. **token 是不可外泄项**。status、REST 响应、诊断文本、argv 都要验一遍，
//      而不是只验「能连上」。
//   3. **隧道会让公网请求看起来来自 127.0.0.1**。这条必须用请求级测试锁住，
//      否则管理面（生成配对码/撤销设备/开通地址）会被整条搬到公网上。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../src/server.mjs';
import { makeHostAllow } from '../src/server.mjs';
import { TunnelManager } from '../src/tunnel.mjs';
import {
  CloudflareProvisioner,
  HostedProvisioner,
  StateProvisioner,
  createProvisioner,
  deriveSubdomain,
  isValidLabel,
} from '../src/cloudflare.mjs';
import { LocalProvisioner, renderConfig } from '../src/provision-local.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { httpJson } from './lib/wsclient.mjs';
import { fakeTunnel, FAKE_SCRIPT } from './lib/fake-tunnel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 这些用例都用自制 spawnImpl 模拟子进程，只需要「文件存在」让发现链命中；
// 指向跨平台的 node 假二进制，不再依赖只能在 POSIX 执行的 .sh。
const FAKE_NAMED = FAKE_SCRIPT;
const TOKEN = 'eyJhIjoiZmFrZSIsInQiOiJmYWtlIiwicyI6ImZha2UifQ==';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const tmpDirs = [];
function tmpState(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-named-${name}-`));
  tmpDirs.push(dir);
  return path.join(dir, 'state.json');
}

/**
 * 假 Cloudflare：内部维护一份最小状态（tunnel 是否已建、DNS 记录是否存在），
 * 记录每次调用，并允许按需注入错误。真实 API 的 envelope（success/errors/result）照抄。
 */
function fakeCloudflare({ zones = [{ id: 'zone_1', name: 'matrixboard.cn', status: 'active' }], existingTunnel = null, existingDns = [], failOn = null } = {}) {
  const calls = [];
  let tunnel = existingTunnel;
  let dns = [...existingDns];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname + u.search, body, headers: init?.headers || {} });
    const reply = (result, ok = true, status = 200, errors = []) => ({
      ok,
      status,
      text: async () => JSON.stringify({ success: ok, errors, messages: [], result }),
    });
    if (failOn && failOn.method === method && u.pathname.includes(failOn.pathIncludes)) {
      return reply(null, false, failOn.status || 400, [{ code: failOn.cfCode || 1000, message: failOn.message }]);
    }
    if (u.pathname === '/client/v4/zones') return reply(zones);
    if (u.pathname === '/client/v4/accounts/acc_1/cfd_tunnel' && method === 'GET') {
      return reply(tunnel ? [tunnel] : []);
    }
    if (u.pathname === '/client/v4/accounts/acc_1/cfd_tunnel' && method === 'POST') {
      tunnel = {
        id: 'tun_1',
        name: body.name,
        config_src: body.config_src,
        remote_config: body.config_src === 'cloudflare',
        deleted_at: null,
      };
      return reply(tunnel);
    }
    if (u.pathname === '/client/v4/accounts/acc_1/cfd_tunnel/tun_1/token') return reply(TOKEN);
    if (u.pathname === '/client/v4/accounts/acc_1/cfd_tunnel/tun_1/configurations') return reply({});
    if (u.pathname === '/client/v4/zones/zone_1/dns_records' && method === 'GET') return reply(dns);
    if (u.pathname === '/client/v4/zones/zone_1/dns_records' && method === 'POST') {
      dns = [{ id: 'dns_1', ...body }];
      return reply({ id: 'dns_1' });
    }
    if (u.pathname === '/client/v4/zones/zone_1/dns_records/dns_1' && method === 'PUT') {
      dns = [{ id: 'dns_1', ...body }];
      return reply({ id: 'dns_1' });
    }
    return reply(null, false, 404, [{ code: 7000, message: `未覆盖的假路由 ${method} ${u.pathname}` }]);
  };
  return { fetchImpl, calls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ---- 1. 子域派生 ----
  console.log('\n▶ 子域派生：稳定、可读、过 DNS');
  {
    const a = deriveSubdomain('install-abc');
    check('形如 dsh-<10 位十六进制>', /^dsh-[0-9a-f]{10}$/.test(a), a);
    check('同输入稳定', deriveSubdomain('install-abc') === a);
    check('不同输入不同子域', deriveSubdomain('install-abd') !== a);
    check('自定义前缀生效', deriveSubdomain('install-abc', { prefix: 'pro' }).startsWith('pro-'));
    check('长度可控', deriveSubdomain('install-abc', { hashLen: 8 }).length === 12);
    check('合法 label 通过校验', isValidLabel(a));
    check('大写被拒（DNS 不区分大小写，写错会生成两条记录）', !isValidLabel('Dsh-ABC'));
    check('首尾中划线被拒', !isValidLabel('-dsh-') && !isValidLabel('dsh-'));
    check('空 label 被拒', !isValidLabel(''));
  }

  // ---- 2. Cloudflare 开通：请求体逐字断言 ----
  console.log('\n▶ 开通：一个 tunnel + 一个子域 + 一份 token');
  const stateFile = tmpState('cf');
  const cf = fakeCloudflare();
  const prov = new CloudflareProvisioner({
    apiToken: 'cf-api-token',
    accountId: 'acc_1',
    baseDomain: 'matrixboard.cn',
    seed: 'install-abc',
    stateFile,
    fetchImpl: cf.fetchImpl,
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_1.cfargotunnel.com'] }),
  });

  const first = await prov.ensure({ port: 3081 });
  check('返回固定地址', /^https:\/\/dsh-[0-9a-f]{10}\.matrixboard\.cn$/.test(first.url), first.url);
  check('首次为新建', first.created === true);
  check('hostname 与 url 一致', first.url === `https://${first.hostname}`);

  const createCall = cf.calls.find((c) => c.method === 'POST' && c.path.endsWith('/cfd_tunnel'));
  check('建 tunnel 用 remotely-managed', createCall?.body?.config_src === 'cloudflare', JSON.stringify(createCall?.body));
  check('tunnel 名就是子域 label', createCall?.body?.name === first.hostname.split('.')[0], createCall?.body?.name);

  const ingress = cf.calls.find((c) => c.method === 'PUT' && c.path.includes('/configurations'));
  const rules = ingress?.body?.config?.ingress || [];
  check('ingress 指向本机当前端口', rules[0]?.service === 'http://127.0.0.1:3081', JSON.stringify(rules));
  check('ingress 绑定固定域名', rules[0]?.hostname === first.hostname, JSON.stringify(rules[0]));
  check('ingress 末条是兜底规则', rules.length === 2 && !rules[1].hostname && rules[1].service === 'http_status:404');

  const dnsCall = cf.calls.find((c) => c.method === 'POST' && c.path.includes('/dns_records'));
  check('DNS 建 CNAME 到 tunnel', dnsCall?.body?.type === 'CNAME' && dnsCall.body.content === 'tun_1.cfargotunnel.com',
    JSON.stringify(dnsCall?.body));
  check('DNS 记录走 Cloudflare 代理', dnsCall?.body?.proxied === true);
  check('DNS 记录名是完整域名', dnsCall?.body?.name === first.hostname);

  check('Authorization 用 Bearer', cf.calls[0]?.headers?.Authorization === 'Bearer cf-api-token');

  // 对外状态不能带 token
  const pub = JSON.stringify(prov.status());
  check('status 不含 token', !pub.includes(TOKEN) && !pub.includes('eyJ'), pub);
  check('status 标识已开通', prov.status().provisioned === true && prov.status().url === first.url);

  // 落盘：0600，且 token 在里面（cloudflared 要用）
  const raw = fs.readFileSync(stateFile, 'utf8');
  check('状态文件含 token', raw.includes(TOKEN));
  // Windows 无 POSIX 权限位（stat.mode 恒 0666），只对 POSIX 断言
  if (process.platform === 'win32') {
    console.log('  · 跳过「状态文件权限 0600」：Windows 无 POSIX 权限位');
    pass += 1;
  } else {
    check('状态文件权限 0600', (fs.statSync(stateFile).mode & 0o777) === 0o600,
      (fs.statSync(stateFile).mode & 0o777).toString(8));
  }

  // 幂等：第二次不再打任何 API
  const before = cf.calls.length;
  const second = await prov.ensure({ port: 3081 });
  check('重复开通返回同一地址', second.url === first.url && second.created === false);
  check('重复开通零 API 调用', cf.calls.length === before, `多了 ${cf.calls.length - before} 次`);

  // 端口顺延：只重写 ingress，不重建 tunnel、不换 token
  const beforePort = cf.calls.length;
  const moved = await prov.ensure({ port: 3082 });
  const portCalls = cf.calls.slice(beforePort);
  check('端口变化后地址不变', moved.url === first.url);
  check('端口变化重建 tunnel 次数为 0',
    portCalls.filter((c) => c.method === 'POST' && c.path.endsWith('/cfd_tunnel')).length === 0);
  check('端口变化不重取 token', portCalls.filter((c) => c.path.endsWith('/token')).length === 0);
  const reIngress = portCalls.find((c) => c.method === 'PUT' && c.path.includes('/configurations'));
  check('端口变化重写 ingress 到新端口',
    reIngress?.body?.config?.ingress?.[0]?.service === 'http://127.0.0.1:3082',
    JSON.stringify(reIngress?.body?.config?.ingress));

  // 状态文件丢了也能复用同名 tunnel（不新建第二份）
  const cf2 = fakeCloudflare({ existingTunnel: { id: 'tun_1', name: first.hostname.split('.')[0], remote_config: true, deleted_at: null } });
  const prov2 = new CloudflareProvisioner({
    apiToken: 'cf-api-token', accountId: 'acc_1', seed: 'install-abc',
    stateFile: tmpState('cf-recover'), fetchImpl: cf2.fetchImpl,
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_1.cfargotunnel.com'] }),
  });
  const recovered = await prov2.ensure({ port: 3081 });
  check('状态丢失后复用既有 tunnel', recovered.hostname === first.hostname && recovered.created === false,
    JSON.stringify(recovered));
  check('复用时不新建 tunnel',
    cf2.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cfd_tunnel')).length === 0);

  // token 只取一次：credential 内部会 ensure，缓存后不再打 API
  const cred = await prov2.credential({ port: 3081 });
  check('credential 返回 hostname 与 token', cred.hostname === first.hostname && cred.token === TOKEN);

  // 错误路径：CF 拒绝 → 4500，且带 CF 的 message、不带 token
  console.log('\n▶ 开通：错误路径不伪装成功');
  {
    const failing = fakeCloudflare({ failOn: { method: 'POST', pathIncludes: '/cfd_tunnel', status: 403, message: 'Authentication error' } });
    const p = new CloudflareProvisioner({
      apiToken: 'bad', accountId: 'acc_1', seed: 'seed-x', stateFile: tmpState('cf-fail'), fetchImpl: failing.fetchImpl,
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_1.cfargotunnel.com'] }),
    });
    try {
      await p.ensure({ port: 3081 });
      check('CF 拒绝时应抛错', false, 'ensure() 竟然成功了');
    } catch (err) {
      check('CF 拒绝 → 4500', err.code === 4500, `code=${err.code}`);
      check('错误里带 CF 原始信息', String(err.message).includes('Authentication error'), err.message);
      check('错误里没有 token', !JSON.stringify(err).includes(TOKEN));
    }
  }

  {
    const inactive = fakeCloudflare({ zones: [{ id: 'zone_1', name: 'matrixboard.cn', status: 'pending' }] });
    const p = new CloudflareProvisioner({
      apiToken: 't', accountId: 'acc_1', seed: 'seed-y', stateFile: tmpState('cf-zone'), fetchImpl: inactive.fetchImpl,
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_1.cfargotunnel.com'] }),
    });
    try {
      await p.ensure({ port: 3081 });
      check('域名未生效应拒绝开通', false, '竟然成功了');
    } catch (err) {
      check('域名 pending → 4021', err.code === 4021, `code=${err.code}`);
      check('提示里说清是 zone 状态', String(err.message).includes('pending'), err.message);
    }
  }

  {
    const localManaged = fakeCloudflare({ existingTunnel: { id: 'tun_local', name: deriveSubdomain('seed-z'), remote_config: false, deleted_at: null } });
    const p = new CloudflareProvisioner({
      apiToken: 't', accountId: 'acc_1', seed: 'seed-z', stateFile: tmpState('cf-local'), fetchImpl: localManaged.fetchImpl,
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_1.cfargotunnel.com'] }),
    });
    try {
      await p.ensure({ port: 3081 });
      check('同名本地管理 tunnel 应拒绝', false, '竟然成功了');
    } catch (err) {
      check('本地管理 tunnel → 4021', err.code === 4021, `code=${err.code}`);
      check('提示指向 remotely-managed', String(err.message).includes('本地管理'), err.message);
    }
  }

  // ---- 3. hosted 开通服务（产品形态） ----
  console.log('\n▶ 开通服务（hosted）：主机看不到 zone 权限');
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          hostname: 'dsh-abcdef1234.matrixboard.cn',
          tunnelId: 'tun_remote',
          token: TOKEN,
        }),
      };
    };
    const p = new HostedProvisioner({
      endpoint: 'https://probe.example.com/', enrollToken: 'enroll-1', hostId: 'host_cordis',
      stateFile: tmpState('hosted'), fetchImpl,
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_remote.cfargotunnel.com'] }),
    });
    const r = await p.ensure({ port: 3081 });
    check('hosted 返回固定地址', r.url === 'https://dsh-abcdef1234.matrixboard.cn', r.url);
    check('请求打到 /v1/tunnel', calls[0]?.url === 'https://probe.example.com/v1/tunnel', calls[0]?.url);
    check('enroll 凭证放 Bearer', calls[0]?.auth === 'Bearer enroll-1');
    check('上报端口与 hostId', calls[0]?.body?.port === 3081 && calls[0]?.body?.hostId === 'host_cordis');
    check('hosted 同样不把 token 放进 status', !JSON.stringify(p.status()).includes(TOKEN));
  }

  {
    // 0.3.3 之前 local 形态落的状态文件没有 token 字段；升级到 hosted 后
    // ensure() 不得拿这种状态短路，必须重新开通一次（子域回传，地址不漂移）。
    const stateFile = tmpState('hosted-legacy');
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      subdomain: 'dsh-1f7361d2da',
      hostname: 'dsh-1f7361d2da.matrixboard.cn',
      tunnelId: 'tun_old_local',
      credentialsFile: '/Users/x/.cloudflared/tun_old_local.json',
      port: 3081,
    }));
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          hostname: 'dsh-1f7361d2da.matrixboard.cn',
          tunnelId: 'tun_migrated',
          token: TOKEN,
        }),
      };
    };
    const p = new HostedProvisioner({
      endpoint: 'https://probe.example.com', enrollToken: 'enroll-1', hostId: 'host_cordis',
      stateFile, fetchImpl,
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_migrated.cfargotunnel.com'] }),
    });
    const cred = await p.credential({ port: 3081 });
    check('旧形态状态（无 token）不短路 → 重新开通', calls.length === 1, `calls=${calls.length}`);
    check('重新开通回传缓存的子域（地址不漂移）', calls[0]?.body?.subdomain === 'dsh-1f7361d2da', calls[0]?.body?.subdomain);
    check('credential 返回新 token', cred.token === TOKEN && cred.hostname === 'dsh-1f7361d2da.matrixboard.cn');
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    check('状态文件补写 token 与新 tunnelId', st.token === TOKEN && st.tunnelId === 'tun_migrated');
  }

  {
    const p = new HostedProvisioner({
      endpoint: 'https://evil.example.com',
      enrollToken: 'e',
      stateFile: tmpState('hosted-bad'),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ hostname: 'dsh-x.evil.com', tunnelId: 't', token: TOKEN }),
      }),
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_1.cfargotunnel.com'] }),
    });
    try {
      await p.ensure({ port: 3081 });
      check('越界域名应拒绝', false, '竟然接受了 evil.com');
    } catch (err) {
      check('越界域名 → 4500', err.code === 4500, `code=${err.code}`);
      check('提示说明域名越界', String(err.message).includes('matrixboard.cn'), err.message);
    }
  }

  // ---- 4. 工厂 ----
  console.log('\n▶ 开通器工厂');
  {
    check('无凭据 → null（保持 Quick Tunnel）', createProvisioner({}, {}) === null);
    const p1 = createProvisioner({ apiToken: 't', accountId: 'a' }, { stateFile: tmpState('f1') });
    check('有 CF 凭据 → cloudflare', p1?.kind === 'cloudflare');
    const p2 = createProvisioner({ endpoint: 'https://x', enrollToken: 'e' }, { stateFile: tmpState('f2') });
    check('有服务地址 → hosted', p2?.kind === 'hosted');
  }

  // ---- 4.5 本地管理型开通（cloudflared 自己的证书） ----
  console.log('\n▶ 本地管理型：cloudflared login 后建 tunnel + 写 DNS + 生成 ingress');
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cf-home-'));
    tmpDirs.push(home);
    const cfDir = path.join(home, '.cloudflared');
    fs.mkdirSync(cfDir, { recursive: true });
    fs.writeFileSync(path.join(cfDir, 'cert.pem'), 'fake-cert');
    const tunnelId = '11111111-2222-3333-4444-555555555555';
    const calls = [];
    const run = async (args) => {
      calls.push(args.join(' '));
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') {
        // 真实 cloudflared 会在 ~/.cloudflared/<uuid>.json 写凭据
        fs.writeFileSync(path.join(cfDir, `${tunnelId}.json`), JSON.stringify({ TunnelID: tunnelId }), { mode: 0o600 });
        return `INF Created tunnel ${args[2]} with id ${tunnelId}`;
      }
      if (args[1] === 'route') return 'INF Added CNAME';
      return '';
    };
    const stateFile = path.join(home, 'tunnel-named.json');
    const configFile = path.join(home, 'tunnel-config.yml');
    let probeCalls = 0;
    const p = new LocalProvisioner({
      baseDomain: 'matrixboard.cn', prefix: 'dsh', seed: 'install-local',
      stateFile, configFile, homeDir: home, run, log: () => {},
      probe: async () => { probeCalls += 1; return { ok: true, kind: 'CNAME', records: [`${tunnelId}.cfargotunnel.com`] }; },
    });

    check('有 cert.pem 即视为可开通', p.configured === true);
    const r = await p.ensure({ port: 3081 });
    check('本地开通返回固定地址', /^https:\/\/dsh-[0-9a-f]{10}\.matrixboard\.cn$/.test(r.url), r.url);
    check('本地开通标记新建', r.created === true);
    check('开通后做了公网解析自检', probeCalls === 1, `calls=${probeCalls}`);
    check('解析正常时无告警', r.dnsOk === true && r.warning === null, JSON.stringify({ dnsOk: r.dnsOk, warning: r.warning }));
    check('调用了 tunnel create', calls.some((c) => c.startsWith('tunnel create')), JSON.stringify(calls));
    check('调用了 route dns 并带 --overwrite-dns',
      calls.some((c) => c.includes('route dns --overwrite-dns') && c.includes(r.hostname)), JSON.stringify(calls));

    const yml = fs.readFileSync(configFile, 'utf8');
    check('配置写入 tunnel id', yml.includes(`tunnel: ${tunnelId}`), yml);
    check('配置指向 credentials 文件', yml.includes(`credentials-file: ${path.join(cfDir, `${tunnelId}.json`)}`), yml);
    check('配置 ingress 指本机端口', yml.includes('service: http://127.0.0.1:3081'), yml);
    check('配置含兜底 ingress', yml.includes('service: http_status:404'), yml);

    const cred = await p.credential({ port: 3081 });
    check('credential 返回配置文件路径', cred.configFile === configFile && cred.hostname === r.hostname);
    check('status 带上解析结论', p.status().dnsOk === true, JSON.stringify(p.status()));

    const before = calls.length;
    await p.ensure({ port: 3081 });
    check('重复开通不再调 CLI', calls.length === before, `多了 ${calls.length - before} 次`);

    await p.ensure({ port: 3082 });
    check('端口变化只重写配置（不再调 CLI）', calls.length === before, JSON.stringify(calls.slice(before)));
    check('端口变化后配置指向新端口', fs.readFileSync(configFile, 'utf8').includes('http://127.0.0.1:3082'));

    const noLogin = new LocalProvisioner({
      baseDomain: 'matrixboard.cn', stateFile: path.join(home, 'x.json'),
      homeDir: path.join(home, 'nobody'), run: async () => '', log: () => {},
    });
    check('没有 cert.pem 不算可开通', noLogin.configured === false);
    try {
      await noLogin.ensure({ port: 3081 });
      check('未登录应拒绝开通', false, '竟然成功了');
    } catch (err) {
      check('未登录 → 4021', err.code === 4021, `code=${err.code}`);
      check('提示里给出 login 命令', String(err.message).includes('登录'), err.message);
      check('detail 里有可执行命令', String(err.extra?.detail || '').includes('tunnel login'), String(err.extra?.detail));
    }

    const failing = new LocalProvisioner({
      baseDomain: 'matrixboard.cn', seed: 'install-bad', stateFile: path.join(home, 'bad.json'),
      homeDir: home, log: () => {},
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['x'] }),
      run: async (args) => {
        if (args[1] === 'list') return '[]';
        if (args[1] === 'create') {
          fs.writeFileSync(path.join(cfDir, `${tunnelId}.json`), '{}', { mode: 0o600 });
          return `Created tunnel x with id ${tunnelId}`;
        }
        if (args[1] === 'route') throw new Error('Failed to add route: zone not found');
        return '';
      },
    });
    try {
      await failing.ensure({ port: 3081 });
      check('写 DNS 失败应抛错', false, '竟然成功了');
    } catch (err) {
      check('写 DNS 失败 → 4500', err.code === 4500, `code=${err.code}`);
      check('保留 cloudflared 的原因', String(err.message).includes('zone not found'), err.message);
    }
  }

  console.log('\n▶ 本地管理型：DNS 写成功但公网解析不到要如实报警');
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cf-pending-'));
    tmpDirs.push(home);
    const cfDir = path.join(home, '.cloudflared');
    fs.mkdirSync(cfDir, { recursive: true });
    fs.writeFileSync(path.join(cfDir, 'cert.pem'), 'fake-cert');
    const tunnelId = '99999999-8888-7777-6666-555555555555';
    const run = async (args) => {
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(cfDir, `${tunnelId}.json`), '{"TunnelID":"x"}', { mode: 0o600 });
        return `Created tunnel t with id ${tunnelId}`;
      }
      return 'INF Added CNAME';
    };
    const p = new LocalProvisioner({
      baseDomain: 'matrixboard.cn', prefix: 'dsh', seed: 'install-pending',
      stateFile: path.join(home, 's.json'), configFile: path.join(home, 'c.yml'),
      homeDir: home, run, log: () => {},
      probe: async () => ({ ok: false, kind: null, records: [] }),
    });
    const r = await p.ensure({ port: 3081 });
    check('解析不到也要返回地址（tunnel 已建好，NS 修好即可用）', /^https:\/\//.test(r.url), r.url);
    check('dnsOk=false', r.dnsOk === false);
    check('给出 pending 说明', String(r.warning).includes('pending'), String(r.warning));
    check('提示里点明改 NS 或换账号', /nameserver/.test(String(r.warning)) && /账号/.test(String(r.warning)), String(r.warning));
    check('state 记下结论，重启后仍能提示', p.status().dnsOk === false && Boolean(p.status().warning));
    const again = await p.ensure({ port: 3081 });
    check('命中缓存也带告警，不会静默变正常', again.dnsOk === false && Boolean(again.warning));
  }

  console.log('\n▶ 防劫持：CNAME 被改指到别的隧道时拒绝下发地址');
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cf-hijack-'));
    tmpDirs.push(home);
    const cfDir = path.join(home, '.cloudflared');
    fs.mkdirSync(cfDir, { recursive: true });
    fs.writeFileSync(path.join(cfDir, 'cert.pem'), 'fake-cert');
    const tunnelId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const run = async (args) => {
      if (args[1] === 'list') return '[]';
      if (args[1] === 'create') {
        fs.writeFileSync(path.join(cfDir, `${tunnelId}.json`), JSON.stringify({ TunnelID: tunnelId }), { mode: 0o600 });
        return `INF Created tunnel t with id ${tunnelId}`;
      }
      return 'INF Added CNAME';
    };
    // 解析「成功」，但目标不是本机隧道——典型的 DNS 篡改/劫持形态
    const p = new LocalProvisioner({
      baseDomain: 'matrixboard.cn', prefix: 'dsh', seed: 'install-hijack',
      stateFile: path.join(home, 's.json'), configFile: path.join(home, 'c.yml'),
      homeDir: home, run, log: () => {},
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['evil-tunnel.cfargotunnel.com'] }),
    });
    const r = await p.ensure({ port: 3081 });
    check('被改指也算地址不可用', r.dnsOk === false, JSON.stringify(r));
    check('告警点明篡改而非 pending', String(r.warning).includes('篡改'), String(r.warning));
    check('status 持久化篡改结论', p.status().dnsOk === false && String(p.status().warning).includes('篡改'));
    const again = await p.ensure({ port: 3081 });
    check('命中缓存仍拒绝被改指的地址', again.dnsOk === false && String(again.warning).includes('篡改'));

    // 修好 DNS（指回本机隧道）后，复查应自动恢复
    const healed = new LocalProvisioner({
      baseDomain: 'matrixboard.cn', prefix: 'dsh', seed: 'install-hijack',
      stateFile: path.join(home, 's.json'), configFile: path.join(home, 'c.yml'),
      homeDir: home, run, log: () => {},
      probe: async () => ({ ok: true, kind: 'CNAME', records: [`${tunnelId}.cfargotunnel.com`] }),
    });
    const fixed = await healed.ensure({ port: 3081 });
    check('DNS 修好后复查恢复可用', fixed.dnsOk === true && fixed.warning === null, JSON.stringify(fixed));
    check('恢复后状态清除篡改标记', healed.status().dnsOk === true && healed.status().warning === null);
  }

  console.log('\n▶ 本地管理型：隧道用 --config 而不是 token');
  {
    const captured = [];
    const tunnel = new TunnelManager({
      port: 3081,
      executable: FAKE_NAMED,
      mode: 'named',
      resolveNamedTarget: async () => ({ hostname: 'dsh-local.matrixboard.cn', configFile: '/tmp/fake-config.yml' }),
      spawnImpl: (exe, args, opts) => {
        captured.push({ args, env: { ...opts.env } });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => setTimeout(() => child.emit('exit', 0, 'SIGTERM'), 0);
        setTimeout(() => child.stdout.write('INF Registered tunnel connection connIndex=0\n'), 10);
        return child;
      },
    });
    const started = await tunnel.start();
    check('本地形态也能 running', started.state === 'running', started.state);
    check('argv 带 --config', captured[0]?.args.includes('--config') && captured[0].args.includes('/tmp/fake-config.yml'),
      JSON.stringify(captured[0]?.args));
    // --no-autoupdate 属于 tunnel 层选项；放到 run 之后 cloudflared 会直接
    // "flag provided but not defined: -no-autoupdate" 退出（真机踩过）
    check('--no-autoupdate 在 run 之前',
      captured[0].args.indexOf('--no-autoupdate') >= 0
      && captured[0].args.indexOf('--no-autoupdate') < captured[0].args.indexOf('run'),
      JSON.stringify(captured[0]?.args));
    check('本地形态不注入 TUNNEL_TOKEN', !captured[0]?.env?.TUNNEL_TOKEN);
    check('地址仍是固定域名', started.url === 'https://dsh-local.matrixboard.cn', started.url);
    await tunnel.stop();
  }

  // ---- 5. named 隧道生命周期 ----
  console.log('\n▶ named 隧道：token 不进 argv、注册成功才算 running');
  {
    const captured = [];
    const spawnImpl = (exe, args, opts) => {
      captured.push({ exe, args, env: { ...opts.env } });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => setTimeout(() => child.emit('exit', 0, 'SIGTERM'), 0);
      setTimeout(() => {
        child.stdout.write('2026-11-18T00:00:00Z INF Starting tunnel tunnelID=tun_1\n');
        child.stderr.write(`2026-11-18T00:00:00Z INF token ${TOKEN}\n`);
        child.stdout.write('2026-11-18T00:00:01Z INF Registered tunnel connection connIndex=0 location=hkg01\n');
      }, 20);
      return child;
    };

    const tunnel = new TunnelManager({
      port: 3081,
      executable: FAKE_NAMED,
      mode: 'named',
      resolveNamedTarget: async () => ({ hostname: 'dsh-abcdef1234.matrixboard.cn', token: TOKEN }),
      spawnImpl,
      log: () => {},
    });
    const started = await tunnel.start();
    check('注册成功后进入 running', started.state === 'running', started.state);
    check('地址就是固定域名', started.url === 'https://dsh-abcdef1234.matrixboard.cn', started.url);
    check('状态里带 mode/hostname', started.mode === 'named' && started.hostname === 'dsh-abcdef1234.matrixboard.cn');

    check('argv 不含 token', !JSON.stringify(captured[0]?.args || []).includes('eyJ'), JSON.stringify(captured[0]?.args));
    check('argv 用 run 且不给 --url（避免覆盖远端 ingress）',
      captured[0]?.args?.includes('run') && !captured[0].args.includes('--url'), JSON.stringify(captured[0]?.args));
    // 实测 QUIC 比强制 http2 更稳，named 不该带 --protocol
    check('named 不强制协议（默认 QUIC 实测更稳）',
      !captured[0].args.includes('--protocol'), JSON.stringify(captured[0]?.args));
    check('token 形态的 --no-autoupdate 也在 run 之前',
      captured[0].args.indexOf('--no-autoupdate') < captured[0].args.indexOf('run'),
      JSON.stringify(captured[0]?.args));
    check('token 走环境变量', captured[0]?.env?.TUNNEL_TOKEN === TOKEN);
    check('状态里没有 token', !JSON.stringify(tunnel.status()).includes(TOKEN), JSON.stringify(tunnel.status()));
    check('日志尾部已脱敏 token',
      tunnel.status().logTail.some((l) => l.includes('[redacted-jwt]'))
      && !tunnel.status().logTail.some((l) => l.includes(TOKEN)),
      JSON.stringify(tunnel.status().logTail));

    const stopped = await tunnel.stop();
    check('停止成功', stopped.stopped === true && tunnel.status().state === 'stopped');
  }

  console.log('\n▶ named 隧道：没连上就不许报 running');
  {
    const tunnel = new TunnelManager({
      port: 3081,
      executable: FAKE_NAMED,
      mode: 'named',
      startTimeoutMs: 400,
      resolveNamedTarget: async () => ({ hostname: 'dsh-x.matrixboard.cn', token: TOKEN }),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        // 真实子进程收到 SIGTERM 会退；桩也必须退，否则 stop() 要等满 3s 宽限，
        // 而那条宽限定时器是 unref 的，事件循环会先空掉。
        child.kill = () => setTimeout(() => child.emit('exit', 0, 'SIGTERM'), 0);
        return child;
      },
    });
    // 隧道内部超时定时器是 unref 的（生产上不能靠它撑住事件循环），
    // 测试里必须自己留一个被引用的定时器，否则进程会在 await 中途直接退出。
    const keepAlive = setTimeout(() => {}, 4000);
    try {
      await tunnel.start();
      check('未注册成功应超时', false, 'start() 竟然成功了');
    } catch (err) {
      check('超时 → 4500', err.code === 4500, `code=${err.code}`);
      check('提示是「未连上」而不是「未拿到地址」', String(err.message).includes('未连上'), err.message);
    }
    check('超时后状态 failed', tunnel.status().state === 'failed', tunnel.status().state);
    await tunnel.stop();
    clearTimeout(keepAlive);
  }

  console.log('\n▶ named 隧道：开通失败要把真实原因抛给调用方');
  {
    const tunnel = new TunnelManager({
      port: 3081,
      executable: FAKE_NAMED,
      mode: 'named',
      resolveNamedTarget: async () => {
        const err = new Error('Cloudflare 拒绝了请求：Authentication error');
        err.code = 4500;
        throw err;
      },
      spawnImpl: () => { throw new Error('不该走到 spawn'); },
    });
    try {
      await tunnel.start();
      check('开通失败应抛错', false, '竟然成功了');
    } catch (err) {
      check('保留开通器的错误码', err.code === 4500, `code=${err.code}`);
      check('保留开通器的原因', String(err.message).includes('Authentication'), err.message);
    }
    check('失败后不残留 pending', tunnel.pending === null);
  }

  // ---- 5.5 只读状态开通器（日常启动不依赖 zone 凭据） ----
  console.log('\n▶ 只读状态：已开通过的机器离线也能起固定地址');
  {
    const file = tmpState('state-only');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      installationId: 'inst-1',
      subdomain: 'dsh-abcdef1234',
      hostname: 'dsh-abcdef1234.matrixboard.cn',
      tunnelId: 'tun_state',
      token: TOKEN,
      port: 3081,
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    }), { mode: 0o600 });

    const p = new StateProvisioner({
      stateFile: file, baseDomain: 'matrixboard.cn',
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['x'] }),
    });
    check('状态文件存在即视为已开通', p.configured === true);
    const r = await p.ensure({ port: 3081 });
    check('返回既有固定地址', r.url === 'https://dsh-abcdef1234.matrixboard.cn' && r.created === false, JSON.stringify(r));
    const cred = await p.credential({ port: 3081 });
    check('能取出 cloudflared 用 token', cred.token === TOKEN);
    check('status 仍不含 token', !JSON.stringify(p.status()).includes(TOKEN));

    try {
      await p.ensure({ port: 3082 });
      check('端口变化应拒绝（无法改 CF ingress）', false, '竟然接受了');
    } catch (err) {
      check('端口变化 → 4021', err.code === 4021, `code=${err.code}`);
      check('提示里给出新旧端口', String(err.message).includes('3081') && String(err.message).includes('3082'), err.message);
    }

    const empty = new StateProvisioner({ stateFile: tmpState('state-empty'), baseDomain: 'matrixboard.cn' });
    check('没有状态文件时不算已开通', empty.configured === false);
  }


/** 构造一个 named 隧道，假子进程会立刻注册成功。返回 { tunnel, pid }。 */
function namedTunnelHarness({ pidFile = null, args = [] } = {}) {
  const childPid = 50000 + Math.floor(Math.random() * 10000);
  const tunnel = new TunnelManager({
    port: 3081,
    executable: FAKE_NAMED,
    mode: 'named',
    pidFile,
    resolveNamedTarget: async () => ({ hostname: 'dsh-orphan.matrixboard.cn', token: TOKEN }),
    spawnImpl: (exe, argv, opts) => {
      args.push(...argv);
      const child = new EventEmitter();
      child.pid = childPid;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => setTimeout(() => child.emit('exit', 0, 'SIGTERM'), 0);
      setTimeout(() => child.stdout.write('INF Registered tunnel connection connIndex=0\n'), 5);
      return child;
    },
  });
  return { tunnel, pid: childPid };
}

  console.log('\n▶ 孤儿进程：pidfile 记录、启动前回收');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pid-'));
    tmpDirs.push(dir);
    const pidFile = path.join(dir, 'cloudflared.pid');

    // (a) 指向不存在的 pid：不能因此起不来
    fs.writeFileSync(pidFile, '999999');
    const t1 = namedTunnelHarness({ pidFile });
    const started1 = await t1.tunnel.start();
    check('残留 pid 不影响启动', started1.state === 'running', started1.state);
    check('启动后 pidfile 指向子进程', Number(fs.readFileSync(pidFile, 'utf8')) === t1.pid, fs.readFileSync(pidFile, 'utf8'));
    await t1.tunnel.stop();
    check('停止后 pidfile 被清掉', !fs.existsSync(pidFile));

    // (b) pid 已被系统复用给无关进程：绝不能误杀
    fs.writeFileSync(pidFile, String(process.pid));
    const t2 = namedTunnelHarness({ pidFile });
    await t2.tunnel.start();
    check('不会误杀命令行不含 cloudflared 的进程', (() => {
      try { process.kill(process.pid, 0); return true; } catch { return false; }
    })());
    await t2.tunnel.stop();
  }

  // ---- 6. REST：隧道来源请求不能当成本机 ----
  console.log('\n▶ REST：固定地址状态与隧道来源请求硬化');
  const PORT = Number(process.env.PORT || 3187) + 9;
  const cfRest = fakeCloudflare();
  const restProv = new CloudflareProvisioner({
    apiToken: 'cf-api-token', accountId: 'acc_1', seed: 'install-rest',
    stateFile: tmpState('cf-rest'), fetchImpl: cfRest.fetchImpl,
      probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_1.cfargotunnel.com'] }),
  });
  const gw = await createGateway({
    host: createMockHost(),
    port: PORT,
    dev: true,
    log: () => {},
    tunnelExecutable: FAKE_NAMED,
    tunnelSpawn: fakeTunnel('named').spawnImpl,
    tunnelProvisioner: restProv,
  });
  const { port } = await gw.start();
  try {
    const blockedTunnel = await httpJson({
      port, method: 'POST', path: '/mobile/v1/pairing/code', body: {},
      headers: { 'CF-Connecting-IP': '203.0.113.9', 'CF-Ray': '8fakelax' },
    });
    check('隧道来源不能生成配对码', blockedTunnel.status === 403 && blockedTunnel.body?.error?.code === 4003,
      JSON.stringify(blockedTunnel.body));

    const blockedOrigin = await httpJson({
      port, method: 'POST', path: '/mobile/v1/pairing/code', body: {},
      headers: { Origin: 'https://evil.example.com' },
    });
    check('外部网页 Origin 不能生成配对码', blockedOrigin.status === 403, JSON.stringify(blockedOrigin.body));

    const summaryViaTunnel = await httpJson({
      port, path: '/mobile/v1/desktop/summary', headers: { 'CF-Ray': '8fakelax' },
    });
    check('隧道来源不能读桌面摘要', summaryViaTunnel.status === 403, JSON.stringify(summaryViaTunnel.body));

    const localSummary = await httpJson({ port, path: '/mobile/v1/desktop/summary' });
    check('本机可读桌面摘要', localSummary.status === 200 && localSummary.body?.ok === true);
    check('摘要里隧道模式为 named', localSummary.body?.tunnel?.mode === 'named', JSON.stringify(localSummary.body?.tunnel));
    check('未开通时不编造域名', localSummary.body?.tunnel?.provisioned === false
      && localSummary.body?.tunnel?.fixedUrl === null, JSON.stringify(localSummary.body?.tunnel));

    const provisioned = await httpJson({ port, method: 'POST', path: '/mobile/v1/tunnel/provision' });
    check('开通接口返回固定地址', provisioned.status === 200
      && /^https:\/\/dsh-[0-9a-f]{10}\.matrixboard\.cn$/.test(provisioned.body?.url || ''),
      JSON.stringify(provisioned.body));
    check('开通响应不含 token', !provisioned.text.includes(TOKEN) && !provisioned.text.includes('eyJ'), provisioned.text);

    const afterProvision = await httpJson({ port, path: '/mobile/v1/desktop/summary' });
    check('开通后摘要报固定地址', afterProvision.body?.tunnel?.provisioned === true
      && afterProvision.body?.tunnel?.fixedUrl === provisioned.body.url,
      JSON.stringify(afterProvision.body?.tunnel));

    // 起隧道后再发配对码：二维码主地址应是固定域名
    const startRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/tunnel/start' });
    check('start 走 named 并返回 running', startRes.status === 200 && startRes.body?.state === 'running',
      JSON.stringify(startRes.body));
    check('start 顺带带上开通状态', startRes.body?.provisioned === true && startRes.body?.hostname === provisioned.body.hostname);
    check('start 响应不含 token', !startRes.text.includes(TOKEN));

    const codeRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: {} });
    check('二维码主地址是固定域名', String(codeRes.body?.qrPayload || '').includes(encodeURIComponent(provisioned.body.url)),
      codeRes.body?.qrPayload);
    check('二维码标注 route=tunnel', codeRes.body?.route === 'tunnel');
    check('二维码载荷带 mode 标记', String(codeRes.body?.qrPayload || '').includes('&m=tunnel'));

    // 注意：配对码是单活语义——再出码会作废上一个码。所有要用 codeRes 换凭证的
    // 断言必须排在任何新的出码调用之前（route 显式选路断言在 redeem 之后）。
    const redeem = await httpJson({
      port, method: 'POST', path: '/mobile/v1/pairing/redeem',
      body: { code: codeRes.body.code, installId: 'ins_named', deviceName: 'named' },
    });
    const deviceToken = redeem.body.deviceToken;
    const tunnelState = await httpJson({ port, path: '/mobile/v1/tunnel', token: deviceToken });
    check('设备可读隧道状态', tunnelState.status === 200 && tunnelState.body?.mode === 'named');
    check('隧道状态不含 token', !tunnelState.text.includes(TOKEN));

    // 显式选路（面板双 banner 各自出码）：
    const lanCode = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: { route: 'lan' } });
    check('显式 route=lan 不吃隧道地址', lanCode.status === 201 && lanCode.body?.route === 'lan'
      && !String(lanCode.body?.qrPayload || '').includes('&m=tunnel')
      && String(lanCode.body?.address || '').includes(':'), JSON.stringify(lanCode.body?.address));

    const tunnelCode = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: { route: 'tunnel' } });
    check('显式 route=tunnel 给固定域名', tunnelCode.status === 201 && tunnelCode.body?.route === 'tunnel'
      && tunnelCode.body?.address === provisioned.body.url, JSON.stringify(tunnelCode.body?.address));

    const badRoute = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: { route: 'mesh' } });
    check('未知 route → 4400', badRoute.status === 400 && badRoute.body?.error?.code === 4400,
      JSON.stringify(badRoute.body));

    const stopRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/tunnel/stop' });
    check('停止后仍报固定地址（用于面板展示）',
      stopRes.body?.state === 'stopped' && stopRes.body?.fixedUrl === provisioned.body.url,
      JSON.stringify(stopRes.body));

    // 隧道没开时显式 route=tunnel 必须拒绝（面板按钮据此显错，不能静默给局域网地址）
    const stoppedTunnelCode = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: { route: 'tunnel' } });
    check('隧道未开启时 route=tunnel → 4021 并说明原因', stoppedTunnelCode.status === 501
      && stoppedTunnelCode.body?.error?.code === 4021
      && String(stoppedTunnelCode.body?.error?.message).includes('远程通道'),
      JSON.stringify(stoppedTunnelCode.body));
    check('隧道未开启时 route=lan 仍可用', (await httpJson({
      port, method: 'POST', path: '/mobile/v1/pairing/code', body: { route: 'lan' },
    })).status === 201);

    const bundle = await httpJson({ port, path: '/mobile/v1/diag/bundle', token: deviceToken });
    check('诊断包不含隧道 token', !bundle.text.includes(TOKEN) && !bundle.text.includes('eyJ'), '泄露了 token');
  } finally {
    await gw.stop();
  }

  // ---- 7. Host 白名单 ----
  console.log('\n▶ WS 主机白名单：固定域名必须被信任');
  {
    const allow = makeHostAllow(['trycloudflare.com', 'matrixboard.cn']);
    check('固定子域放行', allow('dsh-abcdef1234.matrixboard.cn'));
    check('带端口放行', allow('dsh-abcdef1234.matrixboard.cn:443'));
    check('根域放行', allow('matrixboard.cn'));
    check('同名后缀钓鱼域名拒绝', !allow('dsh-abcdef1234.matrixboard.cn.evil.com'));
    check('相似但不同的域拒绝', !allow('notmatrixboard.cn'));
  }

  // ---- 8. 二维码仍兼容旧载荷 ----
  console.log('\n▶ 二维码载荷向后兼容');
  {
    const issue = await (async () => {
      const p = await createGateway({ host: createMockHost(), port: PORT + 1, log: () => {} });
      await p.start();
      const res = await httpJson({ port: PORT + 1, method: 'POST', path: '/mobile/v1/pairing/code', body: {} });
      await p.stop();
      return res;
    })();
    check('无隧道时主地址为局域网或省略', issue.status === 201 && !String(issue.body.qrPayload).includes('m=tunnel'),
      issue.body?.qrPayload);
  }
} finally {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败（共 ${pass + failures.length}）`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
