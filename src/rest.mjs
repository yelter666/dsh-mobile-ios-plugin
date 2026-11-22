// rest.mjs — 一元接口（/mobile/v1/*）
// 只做三件事：鉴权、参数校验、把请求交给 host 适配器。业务判断一律不在这里。

import { fail, ERRORS, newId } from './protocol.mjs';
import { translateRecords } from './adapter/session-history.mjs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { PLUGIN_VERSION } from './version.mjs';
import { ensureCloudflared, resolveAsset } from './cloudflared-install.mjs';
import { selfUpdatePlugin } from './plugin-update.mjs';
import { resolveNs } from './dns-probe.mjs';
import { createLoginManager } from './cloudflared-login.mjs';
import { findCloudflared } from './tunnel.mjs';

// QR 编码（vendor：qrcode-generator 1.4.4，MIT，零依赖；见 lib/vendor/，
// .cjs 后缀：包为 type:module，require 需显式 CommonJS）
const require = createRequire(import.meta.url);
const qrEncoder = require('../lib/vendor/qrcode-generator.cjs');

/** 配对二维码 SVG（服务端生成，借鉴 dsh-mobile：QR 在响应里随码下发）。 */
function pairQrSvg(payload) {
  try {
    const qr = qrEncoder(0, 'M');
    qr.addData(payload);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch {
    return null;
  }
}

// 图片/文件附件以 base64 随请求上送（膨胀约 33%），1MB 会挡住正常照片。
// 25MB 与宿主产物读取上限同档；再大的文件让用户在电脑端处理。
const BODY_LIMIT = 25 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 管理面「是不是主机本机」的判据。
 *
 * 坑在隧道：cloudflared 就跑在本机，它转发进来的请求 socket 地址同样是
 * 127.0.0.1。只用 remoteAddress 判断，等于让公网上的任何人拿到管理面
 * （重新生成配对码 / 撤销全部设备 / 开关隧道）。Cloudflare 一定会在边缘
 * 打上 CF-Connecting-IP / CF-Ray，见到这些头就不再是本机用户。
 *
 * 这不是「防自己人」的校验，而是防止隧道把本机特权面复制到公网。
 */
const EDGE_HEADERS = ['cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry'];

function isLoopbackRequest(req) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
  return !EDGE_HEADERS.some((name) => req.headers[name] !== undefined);
}

/**
 * 管理面请求的另一个门：发起方必须是本机页面。
 *
 * 浏览器里任何一个网页都能向 127.0.0.1 发 POST（CORS 只挡读响应，不挡执行），
 * 而隧道开通会真消耗 Cloudflare 配额。桌面面板来自本机（回环 host、file:// 的
 * null origin、或宿主 Electron 的自有 scheme），所以有 Origin 时只认这三种；
 * curl / Node 工具没有 Origin，放行。
 *
 * 宿主页面源是自定义 scheme（实测 dsh-app://app）。这类 scheme 只能出现在
 * 特权本机上下文里：公网网页的 Origin 永远是 http(s)，且 fetch 无法伪造
 * Origin 头（那是浏览器保护的请求头）。叠加 isLoopbackRequest 的回环
 * socket + 无边缘头两个前置条件，局域网与隧道进来的请求拿不到放行资格，
 * 攻击面没有扩大。
 */
function isSameMachineOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    const host = u.hostname.toLowerCase();
    return LOOPBACK.has(host) || host === 'localhost';
  } catch {
    return false;
  }
}

/**
 * 桌面端 banner（lib/client.js 注入宿主 web app）跨源读取的端点白名单。
 *
 * 边界：
 *   - health 本来就公开（无敏感信息）；desktop/summary 走回环门（LAN 模式下外部拿不到）；
 *   - pairing/code 本就回环-only，开放 CORS 只是把「本机浏览器」也纳入合法调用方；
 *   - 白名单之外的路由一律不发 CORS 头——手机走的同源/原生 fetch 不需要它。
 */
const DESKTOP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
};

const DESKTOP_CORS_PATHS = [
  /^\/mobile\/v1\/health$/,
  /^\/mobile\/v1\/desktop\/summary$/,
  /^\/mobile\/v1\/pairing\/code$/,
  // 桌面面板的隧道按钮原本就在调这两个端点，但没进白名单：请求其实发出去了，
  // 只是响应被浏览器拦下，面板只能显示「操作失败」——隧道其实已经起来了。
  /^\/mobile\/v1\/tunnel\/start$/,
  /^\/mobile\/v1\/tunnel\/stop$/,
  /^\/mobile\/v1\/tunnel\/provision$/,
  /^\/mobile\/v1\/tunnel\/install-cloudflared$/,
  /^\/mobile\/v1\/tunnel\/recheck-dns$/,
  /^\/mobile\/v1\/tunnel\/reset$/,
  /^\/mobile\/v1\/tunnel\/login$/,
  /^\/mobile\/v1\/tunnel\/login\/cancel$/,
  /^\/mobile\/v1\/plugin\/self-update$/,
];

// 面板「插件版本」与更新检查的「当前版本」都取这里；必须与 npm 包版本同源。
const GATEWAY_VERSION = PLUGIN_VERSION;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(fail(4400, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(fail(4400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function createRestRouter({ core, pairing, host, tickets, config = {}, log = () => {} }) {
  const { dev = false, clock = () => new Date() } = config;

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  /**
   * 浏览器授权会话（`cloudflared tunnel login`）。
   *
   * 放在网关而不是面板：起子进程、读 HOME、等回调都只能在主机侧做；面板只负责
   * 把链接摆出来并在结果出来后继续开通。会话是**进程级单例**——重复点不会开第二个
   * 浏览器授权页（现场最容易踩的坑：点两次，两个 cloudflared 抢同一个 cert.pem）。
   */
  const loginManager = config.loginManager || createLoginManager({ log });

  /** 授权用的 cloudflared 与开通用同一套发现链：能开通却找不到 login 的二进制没意义。 */
  const loginExecutable = () => {
    if (typeof config.loginExecutable === 'function') return config.loginExecutable();
    const hint = config.tunnelProvisioner?.executable || 'auto';
    return findCloudflared(hint, process.env) || findCloudflared('auto', process.env) || null;
  };

  /**
   * 诊断包（GW-9）。
   *
   * 取舍：宁可少给信息也不外发隐私 —— 不含设备 token、绝对路径、prompt 正文、产物内容。
   * 同时附一份 `text`，用户可以长按复制直接发给支持人员，不必解释 JSON 结构。
   */
  const buildDiagBundle = () => {
    const info = host.info();
    const stats = core.stats();
    const ws = config.wsStats?.() ?? null;
    const tunnel = config.tunnel?.status?.() ?? { state: 'disabled', executable: 'unknown' };
    const generatedAt = clock().toISOString();

    const stages = [
      { name: 'network', state: 'ok' },
      { name: 'transport', state: 'ok' },
      { name: 'auth', state: stats.pairing.activeDevices > 0 ? 'ok' : 'idle' },
      { name: 'identity', state: 'ok' },
      { name: 'handshake', state: stats.readySessions > 0 ? 'ok' : 'idle' },
      {
        name: 'tunnel',
        state: tunnel.state === 'running' ? 'ok' : tunnel.state === 'failed' ? 'error' : 'idle',
      },
    ];

    const text = [
      'DSH-mobile 诊断包',
      `生成时间：${generatedAt}`,
      `网关：${GATEWAY_VERSION}（adapter=${config.adapterKind || 'unknown'}）`,
      `宿主：${info.hostName} v${info.hostVersion} ${info.platform || ''}`.trim(),
      '协议：1.0',
      `运行时长：${stats.uptimeSec}s`,
      `已配对设备：${stats.pairing.activeDevices}`,
      `就绪会话：${stats.readySessions}`,
      `WS：连接 ${ws?.connections ?? '?'} / 握手 ${ws?.handshakes ?? '?'} / 拒绝 ${ws?.rejects ?? '?'}`,
      `隧道：${tunnel.state}${tunnel.url ? `（${tunnel.url}）` : ''}，可执行文件=${tunnel.executable}`,
      '',
      '脱敏说明：不含设备 token、绝对路径、prompt 正文与产物内容',
    ].join('\n');

    return {
      generatedAt,
      gateway: {
        version: GATEWAY_VERSION,
        adapter: config.adapterKind || 'unknown',
        protocolVersion: '1.0',
        uptimeSec: stats.uptimeSec,
      },
      host: {
        hostId: info.hostId,
        hostName: info.hostName,
        hostVersion: info.hostVersion,
        platform: info.platform,
        caps: info.caps,
      },
      stages,
      transport: { lan: config.lanAddr?.() ?? config.addrs?.lan ?? null, tunnel, ws },
      stats,
      redaction: '已移除设备 token、绝对路径、prompt 正文与产物内容',
      text,
    };
  };

  const auth = (req) => {
    const raw = req.headers.authorization || '';
    if (!raw) throw fail(4001);
    return pairing.verify(String(raw).replace(/^Bearer\s+/i, ''));
  };

  /**
   * 隧道状态 = 进程态 + 开通态。两者必须一起看：
   *   · 进程 running 但没开通 → 只可能是 Quick Tunnel；
   *   · 已开通但进程 stopped → 地址是固定的，但此刻连不上，二维码不能写它。
   */
  // 「解析异常」曾经是死锁：dnsOk=false 被写进状态文件，面板据此禁用开启按钮，
  // 而唯一的重探入口就在开启流程里——按钮点不到 → 永远不重探 → NS 改好了也不恢复。
  // 这里补一层节流自愈：面板轮询 summary 时，若仍是 false 且距上次检查超过 60 秒，
  // 后台重探一次（不阻塞响应）。用户改完 NS 最多等一分钟就会自己变好。
  let dnsAutoRecheckAt = 0;
  let dnsAutoRechecking = false;
  const maybeAutoRecheckDns = (prov) => {
    if (!prov || prov.dnsOk !== false) return;
    if (typeof config.tunnelProvisioner?.recheckDns !== 'function') return;
    const now = Date.now();
    if (dnsAutoRechecking || now - dnsAutoRecheckAt < 60_000) return;
    dnsAutoRecheckAt = now;
    dnsAutoRechecking = true;
    Promise.resolve()
      .then(() => config.tunnelProvisioner.recheckDns())
      .catch(() => { /* 探测失败保持原状态，不打扰用户 */ })
      .finally(() => { dnsAutoRechecking = false; });
  };

  const tunnelSnapshot = () => {
    const base = config.tunnel?.status?.() ?? { state: 'disabled', url: null, mode: 'disabled' };
    const prov = config.tunnelProvisioner?.status?.() ?? null;
    maybeAutoRecheckDns(prov);
    return {
      ...base,
      mode: prov ? 'named' : (base.mode || 'quick'),
      provisioned: Boolean(prov?.provisioned),
      hostname: base.hostname ?? prov?.hostname ?? null,
      provisionerKind: prov?.kind ?? null,
      // 固定地址即使进程停了也照实给出来：桌面面板要能显示「地址是这个，当前未开启」
      fixedUrl: prov?.url ?? null,
      // 域名在公网上解析得到吗。false 时地址虽在、扫码却连不上（zone pending / NS 没指过来），
      // 面板与二维码都要据此避开它，而不是让用户拿一个必然失败的地址去扫。
      dnsOk: prov?.dnsOk ?? null,
      dnsCheckedAt: prov?.dnsCheckedAt ?? null,
      // 解析失败的归因（moved / pending / ns-mismatch / unresolved）：
      // 面板据此给**不同**的修法，而不是一律「等 NS 生效」。
      zone: prov?.zone ?? null,
      warning: prov?.warning ?? null,
      // 凭据预检结论（local 形态才有）：state=障碍类型，blocking=是否**确定**不可写。
      // 面板因此能在用户点「开启远程」之前就提示「登录的账号不对」，而不是等写 DNS 才崩。
      credentials: prov?.credentials ?? null,
      // 浏览器授权的进度（idle/waiting/ok/error/canceled）。面板刷新/重载后能凭它
      // 恢复「正在等授权」的界面，不会让用户以为按钮点了没反应。
      login: loginManager.status(),
      // 面板据此决定是否显示「自动安装 cloudflared」入口：仅在缺失且有官方构建时为 true。
      canAutoInstall: base.executable === 'missing' && !!resolveAsset({}),
    };
  };

  route('GET', /^\/mobile\/v1\/health$/, async (ctx) =>
    send(ctx.res, 200, { ok: true, version: GATEWAY_VERSION, serverTime: clock().toISOString() }, DESKTOP_CORS)
  );

  /**
   * 桌面端侧栏 banner 的状态摘要（lib/client.js 消费）。
   *
   * 回环-only + 无鉴权：监听面默认 127.0.0.1，LAN 模式下外部也拿不到（4003）；
   * 字段只含展示信息（版本 / 适配器 / 设备数 / 隧道态），绝不含 token、路径、prompt。
   */
  route('GET', /^\/mobile\/v1\/desktop\/summary$/, async (ctx) => {
    if (!isLoopbackRequest(ctx.req) || !isSameMachineOrigin(ctx.req)) {
      throw fail(4003, '桌面端摘要只允许在主机本机读取');
    }
    const info = host.info();
    const stats = core.stats();
    const tunnel = tunnelSnapshot();
    const connected = new Set(typeof core.connectedDeviceIds === 'function' ? core.connectedDeviceIds() : []);
    // 面板要能点开看设备名并逐台下线：这里只给展示字段，绝不带凭证哈希/installId。
    const devices = pairing.listDevices().map((d) => ({ ...d, online: connected.has(d.deviceId) }));
    return send(ctx.res, 200, {
      ok: true,
      version: GATEWAY_VERSION,
      adapter: config.adapterKind || 'unknown',
      hostName: info.hostName,
      // 手机端应填的局域网地址（IP:port）；null 表示网关未绑公网/私网面或未就绪
      lan: config.lanAddr?.() ?? null,
      pairing: {
        activeDevices: stats.pairing.activeDevices,
        maxDevices: pairing.maxDevices,
        onlineDevices: connected.size,
        devices,
      },
      sessions: { ready: stats.readySessions },
      tunnel,
      uptimeSec: stats.uptimeSec,
      serverTime: clock().toISOString(),
    }, DESKTOP_CORS);
  });

  route('GET', /^\/mobile\/v1\/meta\/contract$/, async (ctx) =>
    send(ctx.res, 200, {
      contract: 'DSH-mobile gateway contract v0',
      version: '0.2.0',
      websocket: '/ws/mobile',
      protocolVersion: '1.0',
      capabilities: host.info().caps,
      generatedAt: clock().toISOString(),
    })
  );

  // 配对码只允许在回环地址生成：防止同网段任意设备刷码
  route('POST', /^\/mobile\/v1\/pairing\/code$/, async (ctx) => {
    if (!isLoopbackRequest(ctx.req) || !isSameMachineOrigin(ctx.req)) throw fail(4003, '配对码只允许在主机本机生成');
    const body = await readJson(ctx.req);
    // route 显式选路：面板双 banner（局域网 / 远程通道）各自出码。
    // 缺省 auto——沿用「此刻最可能连通」的易用性原则，老客户端不受影响。
    const route = body.route === undefined ? 'auto' : body.route;
    if (!['auto', 'lan', 'tunnel'].includes(route)) throw fail(4400, `route 只支持 auto/lan/tunnel，收到 ${body.route}`);
    const issued = pairing.issueCode({ deviceName: body.deviceName });
    const info = host.info();
    const lan = config.lanAddr?.() ?? null;
    //
    // 易用性原则：用户不该知道「局域网 / 隧道 / Mesh」这些词。二维码里放的是
    // **此刻最可能连通的地址**——在家是同 Wi-Fi 的局域网 IP，出门前开了隧道
    // 就是那个公网域名，扫码即连，不需要在手机上做任何选择。
    // lan=True 时额外把局域网地址一并写进载荷，"addr" 始终是首选。
    const tunnel = tunnelSnapshot();
    // dnsOk === false 表示域名在公网解析不到：隧道进程可能确实连上了边缘，
    // 但手机走这个域名必然是错误页。此时宁可退回局域网地址，也不要给一个假的可达地址。
    const tunnelUsable = tunnel.dnsOk !== false;
    const tunnelUrl = tunnel.state === 'running' && tunnelUsable ? tunnel.url : null;
    // 显式 route 是面板按钮的语义承诺：点了「远程通道出码」就不能给一个局域网地址，
    // 反之亦然。前置条件不满足就明说原因（4021, action=hideControl），别静默换路。
    if (route === 'lan' && !lan) throw fail(4021, '未检测到局域网地址，请确认电脑已连上 Wi-Fi');
    if (route === 'tunnel') {
      if (!config.tunnel) throw fail(4021, '这台主机没有启用远程通道');
      if (!tunnel.provisioned) throw fail(4021, '远程通道未开通，请先开通固定地址');
      if (tunnel.state !== 'running') throw fail(4021, '远程通道未开启，请先点「开启远程」');
      if (!tunnelUsable) throw fail(4021, '固定域名尚未在公网生效，暂时连不上，请稍后再试');
    }
    const primary = route === 'lan' ? lan : route === 'tunnel' ? tunnelUrl : (tunnelUrl ?? lan);
    const parts = [];
    if (primary) parts.push(`addr=${encodeURIComponent(primary)}`);
    if (tunnelUrl && lan) parts.push(`lan=${encodeURIComponent(lan)}`);
    parts.push(`c=${issued.code}`, `h=${info.hostId}`, `m=${tunnelUrl && primary === tunnelUrl ? 'tunnel' : lan ? 'lan' : 'none'}`);
    const qrPayload = `dshm://pair?${parts.join('&')}`;
    return send(ctx.res, 201, {
      ...issued,
      qrPayload,
      qrSvg: pairQrSvg(qrPayload),
      // 桌面面板据此显示「手机扫码后走哪条路」，不再让用户自己猜
      route: tunnelUrl && primary === tunnelUrl ? 'tunnel' : lan ? 'lan' : 'unknown',
      // 面板要能解释「为什么有固定地址却给了局域网地址」
      tunnelWarning: tunnel.warning ?? null,
      address: primary,
      host: { hostId: info.hostId, hostName: info.hostName, hostVersion: info.hostVersion },
    }, DESKTOP_CORS);
  });

  route('POST', /^\/mobile\/v1\/pairing\/redeem$/, async (ctx) => {
    const body = await readJson(ctx.req);
    const device = pairing.redeem(body);
    const info = host.info();
    return send(ctx.res, 200, {
      ...device,
      host: {
        hostId: info.hostId,
        hostName: info.hostName,
        hostVersion: info.hostVersion,
        platform: info.platform,
        protocolVersion: '1.0',
        caps: info.caps,
      },
      protocolVersion: '1.0',
      caps: info.caps,
    });
  });

  /**
   * 单设备下线（桌面面板「已配对设备」里逐台操作）。
   * 与全量 revoke 同样的管理面约束：只允许本机回环 + 同机 Origin；
   * 面板没有 Bearer，所以不调 auth()——防的是同网段设备，不是本机用户。
   * 撤销同时掐断该设备的 WS，避免旧连接在会话存活期间继续读任务数据。
   */
  route('POST', /^\/mobile\/v1\/pairing\/revoke-device$/, async (ctx) => {
    if (!isLoopbackRequest(ctx.req) || !isSameMachineOrigin(ctx.req)) {
      throw fail(4003, '下线设备只允许在主机本机操作');
    }
    const body = await readJson(ctx.req);
    const deviceId = String(body.deviceId || '');
    if (!deviceId) throw fail(4400, '缺少 deviceId');
    const revoked = pairing.revokeDevice(deviceId);
    const droppedSessions = typeof core.dropSessionsByDevice === 'function'
      ? core.dropSessionsByDevice(deviceId) : 0;
    log(`rest  revoke device=${deviceId} revoked=${revoked} sessions=${droppedSessions}`);
    return send(ctx.res, 200, {
      revoked, droppedSessions, deviceId, allDevices: false, at: clock().toISOString(),
    }, DESKTOP_CORS);
  });

  route('POST', /^\/mobile\/v1\/pairing\/revoke$/, async (ctx) => {
    // 仅本机（借鉴 dsh-plugin-mobile-gateway：pair/revoke 管理面不暴露给局域网）。
    // 撤销是全设备级动作，Bearer 只证明「是某台已配对设备」，
    // 局域网内被攻陷的手机不该能把自己的同伴一起炸掉。
    if (!isLoopbackRequest(ctx.req) || !isSameMachineOrigin(ctx.req)) throw fail(4003, '撤销设备只允许在主机本机操作');
    auth(ctx.req);
    const n = pairing.revokeAll();
    log(`rest  revoke all devices n=${n}`);
    return send(ctx.res, 200, { revoked: n, allDevices: true, at: clock().toISOString() });
  });

  // WS 一次性票据（契约 v0.2 扩展，能力名 ws.ticket；宿主未声明该能力时客户端用 Bearer 降级）
  route('POST', /^\/mobile\/v1\/ws-ticket$/, async (ctx) => {
    const device = auth(ctx.req);
    return send(ctx.res, 201, tickets.issue(device.deviceId));
  });

  route('GET', /^\/mobile\/v1\/host$/, async (ctx) => {
    auth(ctx.req);
    const info = host.info();
    return send(ctx.res, 200, {
      ...info,
      serverTime: clock().toISOString(),
      addrs: config.addrs || { lan: null, tunnel: null },
    });
  });

  route('GET', /^\/mobile\/v1\/diag$/, async (ctx) => {
    auth(ctx.req);
    const info = host.info();
    const stats = core.stats();
    const tunnelState = config.tunnel?.status?.().state ?? 'disabled';
    // 宿主适配器自诊断（cordis：服务可见性 + 方法面取证；mock：无则省略）
    const hostDiag = typeof host.diag === 'function' ? await host.diag().catch(() => null) : null;
    return send(ctx.res, 200, {
      gatewayVersion: GATEWAY_VERSION,
      adapter: config.adapterKind || 'unknown',
      hostVersion: info.hostVersion,
      protocolVersion: '1.0',
      uptimeSec: stats.uptimeSec,
      ...(hostDiag ? { hostDiag } : {}),
      stages: [
        { name: 'network', state: 'ok' },
        { name: 'transport', state: 'ok' },
        { name: 'auth', state: stats.pairing.activeDevices > 0 ? 'ok' : 'idle' },
        { name: 'identity', state: 'ok' },
        { name: 'handshake', state: stats.readySessions > 0 ? 'ok' : 'idle' },
        {
          name: 'tunnel',
          state: tunnelState === 'running' ? 'ok' : tunnelState === 'failed' ? 'error' : 'idle',
        },
      ],
      addr: { lan: config.lanAddr?.() ?? config.addrs?.lan ?? null, tunnel: config.tunnel?.status?.().url ?? null },
      stats,
      note: '地址与凭证已脱敏；导出日志不含 token、绝对路径、prompt 正文',
    });
  });

  // 隧道（GW-8）：Quick Tunnel 的启停与状态；named 模式额外支持开通固定地址。
  // 启停是**管理面动作**：回环-only 且免设备凭证（桌面侧栏面板没有设备 token，
  // 与配对码生成同模型）。未安装 cloudflared 时返回 4021 而不是 500——客户端据此隐藏入口。
  const loopbackOnly = (ctx, message) => {
    if (!isLoopbackRequest(ctx.req) || !isSameMachineOrigin(ctx.req)) throw fail(4003, message);
  };

  route('GET', /^\/mobile\/v1\/tunnel$/, async (ctx) => {
    auth(ctx.req);
    if (!config.tunnel) throw fail(4021, '隧道能力未启用', { method: 'tunnel.status' });
    return send(ctx.res, 200, tunnelSnapshot());
  });

  /**
   * 开通固定地址（Pro）：一个 tunnel + 一个子域 + 一份 token。
   *
   * 幂等，可反复点：已开通且端口未变时直接返回既有地址，不再打 Cloudflare API。
   * **绝不返回 token**——它只留在主机上给 cloudflared 用。
   */
  route('POST', /^\/mobile\/v1\/tunnel\/provision$/, async (ctx) => {
    loopbackOnly(ctx, '开通固定地址只允许在主机本机操作');
    const provisioner = config.tunnelProvisioner;
    if (!provisioner) {
      throw fail(4021, '当前主机没有可用的固定地址开通器', {
        detail: '配置 tunnel.provisioner=cloudflare（accountId + API Token）或 hosted（endpoint + enrollToken）',
      });
    }
    const port = config.tunnel?.port;
    const result = await provisioner.ensure({ port });
    log(`rest  tunnel provision ${result.hostname} (${result.created ? 'created' : 'reused'})`);
    return send(ctx.res, 200, {
      ...result,
      status: tunnelSnapshot(),
    }, DESKTOP_CORS);
  });

  route('POST', /^\/mobile\/v1\/tunnel\/start$/, async (ctx) => {
    loopbackOnly(ctx, '隧道启动只允许在主机本机操作');
    if (!config.tunnel) throw fail(4021, '隧道能力未启用', { method: 'tunnel.start' });
    // named 模式在这里顺带完成开通：桌面面板只有一个「开启远程」按钮，
    // 不该让用户先点一次「开通」再点一次「启动」。
    const status = await config.tunnel.start();
    log(`rest  tunnel start → ${status.state}${status.url ? ` ${status.url}` : ''}`);
    return send(ctx.res, 200, { ...status, ...tunnelSnapshot() });
  });

  route('POST', /^\/mobile\/v1\/tunnel\/stop$/, async (ctx) => {
    loopbackOnly(ctx, '隧道停止只允许在主机本机操作');
    if (!config.tunnel) throw fail(4021, '隧道能力未启用', { method: 'tunnel.stop' });
    const result = await config.tunnel.stop();
    return send(ctx.res, 200, { ...tunnelSnapshot(), ...result });

  });

  /**
   * 自举安装 cloudflared（每机首次开启远程）。回环-only：只有主机本机能触发下载执行。
   * 面板必须先弹窗得到用户同意才调用此端点；服务端不做静默后台安装。
   * 下载源固定为 Cloudflare 官方 Release，落点私有组件目录，不改系统 PATH。
   */
  route('POST', /^\/mobile\/v1\/tunnel\/install-cloudflared$/, async (ctx) => {
    loopbackOnly(ctx, '安装 cloudflared 只允许在主机本机操作');
    if (!config.tunnel) throw fail(4021, '隧道能力未启用', { method: 'tunnel.installCloudflared' });
    let result;
    try {
      result = await ensureCloudflared();
    } catch (err) {
      log(`rest  tunnel install-cloudflared 失败 ${err?.code || ''} ${err?.message || err}`);
      throw fail(4500, err?.message || '自动安装 cloudflared 失败', {
        code: err?.code || 'INSTALL_FAILED',
      });
    }
    log(`rest  tunnel install-cloudflared ${result.reused ? '复用' : '已装'} ${result.executable}`);
    // 回填路径：刚装好的二进制不在 PATH 里，开通器如果还拿裸名字去 execFile 会 ENOENT。
    // 这一步让「装完 → 同一次会话里继续开通」真正成立，不必重启宿主。
    config.tunnelProvisioner?.useExecutable?.(result.executable);
    // 立即重取状态：findCloudflared 已把组件目录纳入发现链，装完应马上从 missing 变 found。
    return send(ctx.res, 200, { ...result, status: tunnelSnapshot() }, DESKTOP_CORS);
  });

  /**
   * 重新检测固定域名的公网解析（面板「重新检测解析」按钮）。
   *
   * 存在的唯一理由：dnsOk=false 会持久化，而面板在 false 时曾禁用开启按钮——
   * 用户把 NS 改对之后没有任何可点的入口让它再验一次。这条路把「自锁死」解开。
   * 回环-only：探测会真发 DNS 查询，不该让外部触发。
   */
  route('POST', /^\/mobile\/v1\/tunnel\/recheck-dns$/, async (ctx) => {
    loopbackOnly(ctx, '重新检测解析只允许在主机本机操作');
    const prov = config.tunnelProvisioner;
    if (!prov) throw fail(4021, '这台主机没有固定地址可检测', { method: 'tunnel.recheckDns' });
    if (typeof prov.recheckDns !== 'function') throw fail(4021, '当前开通方式不支持重新检测', { method: 'tunnel.recheckDns' });
    const started = Date.now();
    const result = await prov.recheckDns();
    log(`rest  tunnel recheck-dns ok=${result.ok} tampered=${result.tampered} ${Date.now() - started}ms`);
    // 把公网当前 NS 一并带回去：用户不需要理解 zone/pending，只要拿这串名字去注册商对照。
    const baseDomain = prov.baseDomain
      || String(result.hostname || '').split('.').slice(-2).join('.');
    const publicNs = result.provisioned && baseDomain ? await resolveNs(baseDomain) : [];
    return send(ctx.res, 200, {
      ...result,
      publicNs,
      status: tunnelSnapshot(),
    }, DESKTOP_CORS);
  });

  /**
   * 重置本机的固定地址状态（面板兜底动作）。
   *
   * 存在的理由：状态文件被跨机拷贝、或损坏到无法自愈时，用户原来只能手删
   * ~/.dsh/mobile-access/tunnel-named.json——那是「只有开发者才会的操作」。
   * 这里把「清本地状态」变成一次点击，并明确边界：
   *   · 只清本机状态与 ingress 配置，**不删** cert.pem；
   *   · **不删** Cloudflare 上的隧道与 DNS 记录（用户账号资产，删了不可恢复）；
   *   · 幂等：重复点不会报错。
   * 回环-only：管理面动作，与开通/启停同一道门。
   */
  route('POST', /^\/mobile\/v1\/tunnel\/reset$/, async (ctx) => {
    loopbackOnly(ctx, '重置固定地址只允许在主机本机操作');
    const prov = config.tunnelProvisioner;
    if (typeof prov?.reset !== 'function') {
      throw fail(4021, '当前主机没有可重置的固定地址状态', { method: 'tunnel.reset' });
    }
    // 先停隧道：进程还挂着旧配置时删配置，下一轮重拉会读到一个不存在的 ingress
    try {
      await config.tunnel?.stop?.();
    } catch (err) {
      log(`rest  tunnel reset 前停止隧道失败（继续重置）${err?.message || err}`);
    }
    const result = await prov.reset();
    log(`rest  tunnel reset 完成 hadState=${result.hadState} removed=${(result.removed || []).join(',') || '（无文件）'}`);
    return send(ctx.res, 200, { ...result, status: tunnelSnapshot() }, DESKTOP_CORS);
  });

  /**
   * 发起 Cloudflare 浏览器授权（面板「重新授权」按钮）。
   *
   * 边界与开通同一道门（回环-only）：这一步会起子进程并让浏览器拿到一次账号授权，
   * 公网上的任何人都不能触发。返回里带 `url`——面板即使拿不到系统浏览器，也能把
   * 链接复制出去在任意设备上完成授权（回调仍是本机 localhost，所以必须同机浏览器）。
   */
  route('POST', /^\/mobile\/v1\/tunnel\/login$/, async (ctx) => {
    loopbackOnly(ctx, 'Cloudflare 授权只允许在主机本机操作');
    const executable = loginExecutable();
    if (!executable) {
      throw fail(4021, '这台主机还没有 cloudflared，先安装再授权', {
        method: 'tunnel.login',
        detail: '面板「安装 cloudflared」或在这台电脑终端执行 brew install cloudflared',
      });
    }
    let status;
    try {
      status = loginManager.start({ executable, homeDir: os.homedir() });
    } catch (err) {
      throw fail(4500, err?.message || '无法发起 Cloudflare 授权', { method: 'tunnel.login' });
    }
    log(`rest  tunnel login ${status.state}${status.url ? '（已给出链接）' : '（等待输出链接）'}`);
    return send(ctx.res, 200, status, DESKTOP_CORS);
  });

  /** 查询授权进度（面板每 1.5 秒轮询一次；状态机在 cloudflared-login.mjs）。 */
  route('GET', /^\/mobile\/v1\/tunnel\/login$/, async (ctx) => {
    loopbackOnly(ctx, 'Cloudflare 授权状态只允许在主机本机读取');
    return send(ctx.res, 200, loginManager.status(), DESKTOP_CORS);
  });

  /** 取消授权：kill 掉等待中的 cloudflared，避免用户关了弹窗它还在后台等。 */
  route('POST', /^\/mobile\/v1\/tunnel\/login\/cancel$/, async (ctx) => {
    loopbackOnly(ctx, 'Cloudflare 授权只允许在主机本机操作');
    const status = loginManager.cancel();
    log(`rest  tunnel login cancel → ${status.state}`);
    return send(ctx.res, 200, status, DESKTOP_CORS);
  });

  /**
   * 插件自更新（不依赖宿主 pluginManager）。
   *
   * 为什么放在网关：dsh-app:// 页面里的复制/剪贴板能力不可靠，而「一键更新」缺了宿主
   * API 就只剩复制包名一条路。这里由 Node 侧直接取 npm tarball、校验 shasum、
   * 备份后覆盖安装目录，返回 restartRequired 让面板明确告知需要重启。
   * 只允许装本插件自己（写死包名），不接受任意包/任意 URL。
   */
  route('POST', /^\/mobile\/v1\/plugin\/self-update$/, async (ctx) => {
    loopbackOnly(ctx, '插件更新只允许在主机本机操作');
    const body = await readJson(ctx.req);
    const target = typeof body?.target === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(body.target)
      ? body.target
      : null;
    let result;
    try {
      result = await selfUpdatePlugin({ target, log });
    } catch (err) {
      log(`rest  plugin self-update 失败 ${err?.message || err}`);
      throw fail(4500, err?.message || '插件更新失败', { code: 'SELF_UPDATE_FAILED' });
    }
    log(`rest  plugin self-update ${result.from || '?'} → ${result.to} changed=${result.changed}`);
    return send(ctx.res, 200, result, DESKTOP_CORS);
  });

  // 诊断包（GW-9）：一次拿到可直接粘贴给支持人员的东西。
  route('GET', /^\/mobile\/v1\/diag\/bundle$/, async (ctx) => {
    auth(ctx.req);
    return send(ctx.res, 200, buildDiagBundle());
  });

  route('GET', /^\/mobile\/v1\/tasks$/, async (ctx) => {
    auth(ctx.req);
    // includeArchived=1 切到「已归档」视图：与桌面端 archivedOnly 同口径，
    // 只返回归档项。默认（false）与桌面端 sidebar 一致，归档项不占任务条。
    const body = await host.listTasks({
      status: ctx.url.searchParams.get('status') || undefined,
      limit: Number(ctx.url.searchParams.get('limit')) || 50,
      includeArchived: /^(1|true)$/i.test(ctx.url.searchParams.get('includeArchived') || ''),
    });
    // lastSeq 属于**网关的事件空间**（每任务独立自增），宿主并不掌握它。
    // 宿主返回 0 会让客户端把这份快照判成「比事件旧」而拒用（实测：任务永远停在占位行，
    // 标题与预算都补不上）。真相在环缓冲里，这里补齐。
    body.items = body.items.map((item) => ({
      ...item,
      lastSeq: Math.max(Number(item.lastSeq) || 0, core.events.maxSeq(item.taskId)),
    }));
    return send(ctx.res, 200, body);
  });

  route('POST', /^\/mobile\/v1\/tasks$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req);
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if ((!body.prompt || String(body.prompt).trim().length === 0) && !hasAttachments) {
      throw fail(4400, 'prompt 不能为空');
    }
    const key = body.submissionId || ctx.req.headers['idempotency-key'];
    const result = await core.idempotent(key, () => host.createTask(body));
    return send(ctx.res, 202, result);
  });

  route('GET', /^\/mobile\/v1\/tasks\/([^/]+)$/, async (ctx) => {
    auth(ctx.req);
    const body = await host.getTask(ctx.params[0]);
    // 同上：seq 是网关的事实，不是宿主的。两处都补，避免一处真一处假。
    const seq = core.events.maxSeq(body.task.taskId);
    body.lastSeq = Math.max(Number(body.lastSeq) || 0, seq);
    body.task.lastSeq = Math.max(Number(body.task.lastSeq) || 0, seq);
    return send(ctx.res, 200, body);
  });

  // 会话历史页（FR-CHAT-01）：宿主冷启动历史由 session/events 提供，
  // 手机端「尚未收到数据」的根因就是这条缺失（此前只有 WS 增量、无历史）。
  route('GET', /^\/mobile\/v1\/tasks\/([^/]+)\/events$/, async (ctx) => {
    auth(ctx.req);
    const beforeSeq = Number(ctx.url.searchParams.get('beforeSeq'));
    const limit = Number(ctx.url.searchParams.get('limit')) || 60;
    const page = await host.events(ctx.params[0], {
      beforeSeq: Number.isFinite(beforeSeq) && beforeSeq > 0 ? beforeSeq : undefined,
      limit: Math.min(Math.max(limit, 1), 200),
    });
    const translated = translateRecords(page.records);
    // lastSeq 必须是**网关事件空间**的水位，不是宿主 seq 的水位。
    //
    // 历史条目的 seq 来自宿主（每个会话自己的计数，可能到几百），而实时帧用的是
    // 网关环形缓冲的 seq（从 1 起）。两者混在同一个 `lastSeq` 里，客户端就会把
    // 后续实时帧当成「重复的旧事件」全部丢掉——真机表现是「发消息没反应，
    // 时间线一动不动」（2026-11-17 实测：历史 lastSeq=5，实时帧 seq=1..9 全被拒）。
    //
    // 所以：条目里的 seq 只用于客户端**排序**，水位一律取环缓冲当前最大值。
    return send(ctx.res, 200, {
      taskId: page.taskId,
      items: translated.items,
      lastSeq: core.events.maxSeq(page.taskId),
      nextBeforeSeq: translated.nextBeforeSeq,
      hasMore: page.hasMore,
    });
  });

  route('GET', /^\/mobile\/v1\/tasks\/([^/]+)\/artifacts$/, async (ctx) => {
    auth(ctx.req);
    const body = await host.listArtifacts(ctx.params[0]);
    return send(ctx.res, 200, body);
  });

  route('GET', /^\/mobile\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)$/, async (ctx) => {
    auth(ctx.req);
    // 文件字节由宿主适配器读出（它才掌握 cwd 与路径收边），网关只负责搬运。
    // 不解 base64、不包 JSON：产物的常见用途是「在手机上直接看」，
    // 包一层信封就得让客户端先落盘再解一次，图什么。
    const file = await host.readArtifact(ctx.params[0], ctx.params[1]);
    const data = file?.data ?? Buffer.alloc(0);
    ctx.res.writeHead(200, {
      'Content-Type': file?.mime ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      // inline：客户端（QuickLook / 浏览器）直接预览，不当附件下载
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file?.name ?? 'artifact')}`,
    });
    ctx.res.end(data);
  });

  // 聊天里「我发的那张图」：按宿主附件摘要取字节（2026-11-22）。
  //
  // 时间线只带 `attachments[].downloadUrl`，不带 base64——一次冷启动拉几十兆 JSON
  // 是另一种坏法。这里与产物下载同一条搬运口径：不解 base64、不包信封，
  // Content-Type 由字节头认出（对象库文件名没有扩展名）。
  //
  // 路由先收任意单段 id，再由 host 校验 `sha256:<64hex>`：非法 id 必须得到
  // 4400（形状不对），而不是 404（接口不存在）——前者能告诉客户端「别再拼这个 url」。
  // 路径收边在 host 那一层，这里不放行斜杠，杜绝穿越。
  route('GET', /^\/mobile\/v1\/attachments\/([^/]+)$/, async (ctx) => {
    auth(ctx.req);
    const file = await host.readAttachment(decodeURIComponent(ctx.params[0]));
    const data = file?.data ?? Buffer.alloc(0);
    ctx.res.writeHead(200, {
      'Content-Type': file?.mime ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file?.name ?? 'attachment')}`,
    });
    ctx.res.end(data);
  });

  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/messages$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req);
    const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
    if ((!body.text || !String(body.text).trim()) && !hasAttachments) {
      throw fail(4400, 'text 不能为空');
    }
    // 纯附件消息允许 text 为空；宿主 content 只要求「非空文本或附件」。
    const result = await core.idempotent(body.submissionId, () => host.appendMessage(ctx.params[0], body));
    return send(ctx.res, 202, result);
  });

  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/cancel$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req).catch(() => ({}));
    const result = await core.idempotent(body.submissionId, () => host.cancelTask(ctx.params[0], body));
    return send(ctx.res, 202, result);
  });

  // 保留位：用来验证"能力缺失应隐藏入口"，而不是让客户端弹错
  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/rollback$/, async (ctx) => {
    auth(ctx.req);
    throw fail(4021, '回滚能力未实现', { method: 'tasks.rollback' });
  });

  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/todos\/([^/]+)\/answer$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req);
    if (!body.decision) throw fail(4400, 'decision 不能为空');
    const result = await host.answerTodo(ctx.params[0], ctx.params[1], body);
    return send(ctx.res, 200, result);
  });

  // App 级设置目录（2026-11-20）：进程级权限目录 + 模型目录。
  // 与下面那条会话级接口的区别只有一个：这里没有 currentValue（权限当前值是会话事实）。
  // 存在的理由：设置面板要在「一条会话都还没有」时也能选新建会话默认权限。
  route('GET', /^\/mobile\/v1\/settings$/, async (ctx) => {
    auth(ctx.req);
    const body = await host.appSettings();
    return send(ctx.res, 200, body);
  });

  // 会话设置同步（2026-11-17）：工作区权限与模型选择，与桌面端同源。
  // 读 = 权限目录 + 当前值 + 模型目录一次拿全；写 = 两条直改端点。
  // 宿主侧哪个面缺失由适配器降级 supported:false，网关不吞、也不替它编数据。
  route('GET', /^\/mobile\/v1\/tasks\/([^/]+)\/settings$/, async (ctx) => {
    auth(ctx.req);
    const body = await host.sessionSettings(ctx.params[0]);
    return send(ctx.res, 200, body);
  });

  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/settings\/permission$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req);
    if (!body.preset) throw fail(4400, 'preset 不能为空');
    const result = await host.setPermission(ctx.params[0], body);
    return send(ctx.res, 200, result);
  });

  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/settings\/model$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req);
    if (!body.provider || !body.model) throw fail(4400, 'provider 与 model 不能为空');
    const result = await host.selectModel(ctx.params[0], body);
    return send(ctx.res, 200, result);
  });

  // 会话动作（2026-11-18）：与桌面端 Session 右键菜单同源。
  // 置顶/归档/重命名/分叉都是即时生效的管理动作（非消息写队列），200 同步回执；
  // 但带 submissionId 幂等，防手抖重复 fork 出两个会话。复制 ID 纯客户端，无路由。
  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/pin$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req).catch(() => ({}));
    const pinned = body.pinned === undefined ? true : body.pinned === true;
    const result = await core.idempotent(body.submissionId, () => host.pinTask(ctx.params[0], { pinned }));
    return send(ctx.res, 200, result);
  });

  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/archive$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req).catch(() => ({}));
    const archived = body.archived === undefined ? true : body.archived === true;
    const result = await core.idempotent(body.submissionId, () =>
      host.archiveTask(ctx.params[0], { archived, stopActivity: body.stopActivity === true }));
    return send(ctx.res, 200, result);
  });

  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/rename$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req);
    if (!body.title || !String(body.title).trim()) throw fail(4400, 'title 不能为空');
    const result = await core.idempotent(body.submissionId, () => host.renameTask(ctx.params[0], body));
    return send(ctx.res, 200, result);
  });

  route('POST', /^\/mobile\/v1\/tasks\/([^/]+)\/fork$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req).catch(() => ({}));
    const result = await core.idempotent(body.submissionId, () => host.forkTask(ctx.params[0], body));
    return send(ctx.res, 200, result);
  });

  // 新建工作区（2026-11-22）：手机端「新任务会话」可以选、也可以新建工作区。
  // 工作区在宿主里就是一个已存在目录的注册，所以这里是「登记一个目录」，
  // 不是「创建文件夹」——目录不存在时宿主会拒绝，如实回 4400。
  // 同一目录重复登记幂等（拿回原分组，`created: false`）。
  route('POST', /^\/mobile\/v1\/workspaces$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req);
    const result = await core.idempotent(body.submissionId, () => host.createWorkspace(body));
    return send(ctx.res, 201, result);
  });

  // 工作区写动作（2026-11-21）：与桌面端分组右键菜单同源。
  // 宿主 workspaceController.rename/delete 的进程内直调，202 同步回执；带 submissionId
  // 幂等防手抖重复删。删除只移除分组注册（会话落到未分组、文件保留），不是删文件。
  route('POST', /^\/mobile\/v1\/workspaces\/([^/]+)\/rename$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req);
    if (!body.title || !String(body.title).trim()) throw fail(4400, 'title 不能为空');
    const result = await core.idempotent(body.submissionId, () =>
      host.renameWorkspace(ctx.params[0], body));
    return send(ctx.res, 200, result);
  });

  route('DELETE', /^\/mobile\/v1\/workspaces\/([^/]+)$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req).catch(() => ({}));
    const result = await core.idempotent(body.submissionId, () =>
      host.deleteWorkspace(ctx.params[0], body));
    return send(ctx.res, 200, result);
  });

  // 提示词增强（2026-11-18）：真调宿主模型，不绑定任务——新建页也能用。
  // 刻意不做幂等缓存：模型输出非确定性，缓存反而会让「再增强一次」拿到旧结果。
  // 防重复点击由客户端 loading 态负责。
  route('POST', /^\/mobile\/v1\/prompt\/enhance$/, async (ctx) => {
    auth(ctx.req);
    const body = await readJson(ctx.req);
    const result = await host.enhancePrompt({
      text: body.text,
      provider: body.provider,
      model: body.model,
    });
    return send(ctx.res, 200, result);
  });

  if (dev) {
    route('POST', /^\/__mock\/emit$/, async (ctx) => {
      const body = await readJson(ctx.req);
      // dev 注入的帧同时落进 mock 宿主的历史记录：否则 events() 与 WS 看到的
      // 是两个世界（手机冷启动拉不到刚注入的时间线，实测 2026-11-18）。
      host.ingestExternal?.(body.taskId, body.kind || 'log', body.data ?? {}, body.at);
      const frame = core.publish({
        taskId: body.taskId,
        kind: body.kind || 'log',
        data: body.data ?? { line: 'synthetic' },
        at: body.at,
      });
      return send(ctx.res, 201, { emitted: frame });
    });
    route('GET', /^\/__mock\/state$/, async (ctx) =>
      send(ctx.res, 200, { ...core.stats(), ws: config.wsStats?.() ?? null })
    );

    // 故障注入（S-1）：三类必须可编程复现的失败
    // 1) 宿主重启：换 gen + 清环 + 推 gateway 事件 + 1012 断开
    route('POST', /^\/__mock\/restart-host$/, async (ctx) => {
      const body = await readJson(ctx.req).catch(() => ({}));
      return send(ctx.res, 200, core.restartHost(body?.reason || 'manual'));
    });
    // 2) seq 缺口：裁掉旧帧，让客户端游标早于环下界
    route('POST', /^\/__mock\/gap$/, async (ctx) => {
      const body = await readJson(ctx.req).catch(() => ({}));
      if (!body?.taskId) return send(ctx.res, 400, { code: 4400, message: 'taskId 必填' });
      return send(ctx.res, 200, core.injectGap(body.taskId, Number(body.keep) || 0));
    });
    // 3) 链路中断：不发 close 帧，直接断 socket
    route('POST', /^\/__mock\/drop$/, async (ctx) => {
      const n = config.dropAll?.() ?? 0;
      log(`mock  drop ${n} connection(s)`);
      return send(ctx.res, 200, { dropped: n });
    });
  }

  return async function handle(req, res) {
    const traceId = newId('tr');
    const url = new URL(req.url, 'http://127.0.0.1');
    const ctxBase = { req, res, url, traceId };

    try {
      // 桌面端 banner 预检：JSON POST 会触发 preflight，白名单路径内直接应答。
      if (req.method === 'OPTIONS' && DESKTOP_CORS_PATHS.some((p) => p.test(url.pathname))) {
        res.writeHead(204, { ...DESKTOP_CORS, 'Access-Control-Max-Age': '600' });
        return res.end();
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        await r.handler({ ...ctxBase, params: m.slice(1) });
        if (req.method !== 'GET') log(`rest  ${req.method} ${url.pathname} ${res.statusCode}`);
        return;
      }
      throw fail(4404);
    } catch (err) {
      const code = err.code && ERRORS[err.code] ? err.code : 4500;
      const meta = ERRORS[code];
      if (code === 4500) log(`rest  ERR ${req.method} ${url.pathname} ${err.stack || err}`);
      // 4xx 也要留痕：手机端「发不出去」在过去只能靠猜，因为业务拒绝（4400/4011/
      // 4021/4007…）全是静默返回，日志里只有 500。一行就够定位。
      else if (code === 4003) {
        // 管理面拒绝要能区分「真公网/局域网请求」和「宿主 webview 被误伤」：
        // 回环地址、无边缘头、同机 Origin 三个条件哪个没过，看一眼就知道。
        const edgeHit = EDGE_HEADERS.filter((h) => req.headers[h] !== undefined);
        log(`rest  deny ${req.method} ${url.pathname} ${code} ${err.message || ''}`
          + ` src=${req.socket.remoteAddress}`
          + ` origin=${req.headers.origin ?? '-'}`
          + ` edge=${edgeHit.join('|') || '-'}`);
      } else log(`rest  deny ${req.method} ${url.pathname} ${code} ${err.message || ''}`);
      const body = {
        error: {
          code,
          message: err.message || meta.message,
          ...(err.extra?.detail ? { detail: err.extra.detail } : {}),
          // 机器可读的失败原因（credentials / zone / conflict …）：面板据此决定
          // 「给登录指引」还是「给 NS 修法」，不靠中文字符串匹配。
          ...(err.extra?.reason ? { reason: err.extra.reason } : {}),
          traceId,
          ...(err.extra?.retryAfterMs ? { retryAfterMs: err.extra.retryAfterMs } : {}),
          ...(err.extra?.attemptsRemaining !== undefined ? { retryAfterMs: err.extra.retryAfterMs, attemptsRemaining: err.extra.attemptsRemaining } : {}),
        },
      };
      if (res.headersSent) return res.end();
      // 白名单路径的错误响应也带 CORS——浏览器端要能读到 4003 等语义化错误
      const headers = DESKTOP_CORS_PATHS.some((p) => p.test(url.pathname)) ? DESKTOP_CORS : {};
      return send(res, meta.http, body, headers);
    }
  };
}
