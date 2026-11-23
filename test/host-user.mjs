// test/host-user.mjs — 桌面端账号下发链路（0.3.9，HostInfo.user）
// 覆盖：mock 夹具、cordis 三种来源形态、端到端 /mobile/v1/host

import { createGateway } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { createCordisHost } from '../src/adapter/cordis-host.mjs';
import { connect, httpJson, portFree } from './lib/wsclient.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const PORT = Number(process.env.PORT || 3191);

// ---- 1. mock 夹具：info() 自带演示账号 ----
{
  const host = createMockHost({ log: () => {} });
  const info = host.info();
  check('mock info 带 user', info.user && typeof info.user === 'object', JSON.stringify(info.user));
  check('mock user.nickname=大葉', info.user?.nickname === '大葉', info.user?.nickname);
  check('mock user.maskedContact 脱敏格式', /^\d{3}\*\*\*\*\d{4}$/.test(info.user?.maskedContact || ''), info.user?.maskedContact);
  check('mock user 无 avatarUrl（客户端走首字退化头像）', info.user?.avatarUrl === undefined, String(info.user?.avatarUrl));
}

// ---- 2. cordis host：四种来源形态 ----
{
  // 2a. 插件 config 显式注入（标准字段名）
  const a = createCordisHost({ ctx: { get: () => undefined }, user: { id: 'u_x1', nickname: '大葉', avatarUrl: 'https://a/img.png', maskedContact: '138****6688' } });
  const ia = a.info();
  check('config 注入 → info 带 user', ia.user?.nickname === '大葉' && ia.user?.avatarUrl === 'https://a/img.png', JSON.stringify(ia.user));
  check('config 注入不影响其余字段', ia.hostId === 'host_cordis' && Array.isArray(ia.caps));

  // 2b. 宿主上下文宽容读取 + 别名归一（uid/username/avatar/contact → 标准名）
  const b = createCordisHost({ ctx: { get: (n) => (n === 'user' ? { uid: 'u_x2', username: '大葉', avatar: 'https://a/x.png', contact: '138****6688' } : undefined) } });
  const ib = b.info();
  check('ctx.get(user) 别名归一生效', ib.user?.id === 'u_x2' && ib.user?.nickname === '大葉'
    && ib.user?.avatarUrl === 'https://a/x.png' && ib.user?.maskedContact === '138****6688', JSON.stringify(ib.user));

  // 2c. 宿主未提供 → 不发字段（客户端显示未登录态，绝不编造）
  const c = createCordisHost({ ctx: { get: () => undefined } });
  check('未提供时 info 无 user 字段', !('user' in c.info()), JSON.stringify(c.info().user));
  const d = createCordisHost({ ctx: { get: () => undefined }, user: 'garbage' });
  check('非对象 user 被忽略', !('user' in d.info()));
}

// ---- 2d. 0.3.10 缺口修复：name 别名 + 守卫放宽 ----
{
  // 纯引擎 profile：{name, avatarUrl, contact} 无 id —— 0.3.9 会整条丢弃
  const e = createCordisHost({ ctx: { get: () => undefined }, user: { name: '大葉', avatarUrl: 'https://a/p.png', contact: '13812346688' } });
  const ie = e.info();
  check('name 别名生效（无 id/nickname 不丢）', ie.user?.nickname === '大葉', JSON.stringify(ie.user));
  check('avatarUrl-only 不丢', ie.user?.avatarUrl === 'https://a/p.png');
  check('明文 contact 自动脱敏为 138****6688', ie.user?.maskedContact === '138****6688', ie.user?.maskedContact);
  // 全字段为空的对象 → 丢弃
  const f = createCordisHost({ ctx: { get: () => undefined }, user: { id: null, name: null, contact: null } });
  check('全空字段对象被丢弃', !('user' in f.info()), JSON.stringify(f.info().user));
  // 已脱敏 contact 原样保留
  const g = createCordisHost({ ctx: { get: () => undefined }, user: { nickname: 'x', contact: '138****6688' } });
  check('已脱敏 contact 原样保留', g.info().user?.maskedContact === '138****6688');
  // 过短明文 contact 丢弃（防泄露）
  const h = createCordisHost({ ctx: { get: () => undefined }, user: { nickname: 'x', contact: '12345' } });
  check('过短明文 contact 丢弃', h.info().user?.maskedContact === undefined, h.info().user?.maskedContact);
}

// ---- 2e. 0.3.10 引擎第三源：deepseekAccount（预热缓存 + watchState 事件刷新）----
/** 流事件在后台任务里消费，断言前轮询等待条件成立（2s 超时）。 */
async function waitFor(cond, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
{
  function fakeAccountSvc({ profile, updates = [], failFirst = false } = {}) {
    let calls = 0;
    return {
      getProfileCalls: () => calls,
      async getProfile(_meta) {
        calls += 1;
        if (failFirst && calls === 1) return { status: 'failed' };
        return profile; // null = 未登录 | {status:'ready',value:{...}} | {status:'failed'}
      },
      async *watchState(_signal) { for (const u of updates) yield u; },
    };
  }
  // 引擎 ready profile（字段可空的平台形态；contact 为明文，网关侧脱敏）
  const readyProfile = { status: 'ready', value: { id: null, name: '大葉', contact: '13812346688', avatarUrl: null } };

  // e1. 登录态：预热后 info 带出（明文 contact 脱敏；id/avatarUrl 为空不出）
  const svc1 = fakeAccountSvc({ profile: readyProfile });
  const h1 = createCordisHost({ ctx: { get: (n) => (n === 'deepseekAccount' ? svc1 : undefined) } });
  await h1.whenAccountReady();
  const i1 = h1.info();
  check('引擎 getProfile 缓存生效（name→nickname）', i1.user?.nickname === '大葉', JSON.stringify(i1.user));
  check('引擎明文 contact 脱敏', i1.user?.maskedContact === '138****6688', i1.user?.maskedContact);
  check('引擎空字段不出（id/avatarUrl 为 null）', i1.user?.id === undefined && i1.user?.avatarUrl === undefined, JSON.stringify(i1.user));
  // 缓存生效：第二次 info 不再触发 RPC
  h1.info(); h1.info();
  check('缓存后不再打 RPC（info 同步读缓存）', svc1.getProfileCalls() === 1, String(svc1.getProfileCalls()));

  // e2. 未登录（null）→ 无字段
  const h2 = createCordisHost({ ctx: { get: (n) => (n === 'deepseekAccount' ? fakeAccountSvc({ profile: null }) : undefined) } });
  await h2.whenAccountReady();
  check('引擎未登录 → 不发 user', !('user' in h2.info()));

  // e3. failed → 无字段，不崩
  const h3 = createCordisHost({ ctx: { get: (n) => (n === 'deepseekAccount' ? fakeAccountSvc({ profile: { status: 'failed' } }) : undefined) } });
  await h3.whenAccountReady();
  check('引擎查询 failed → 不发 user', !('user' in h3.info()));

  // e4. watchState 推 credentials-changed → 缓存重拉刷新
  let externalProfile = { status: 'ready', value: { id: 'u_a', name: '旧名', contact: null } };
  const svc4 = {
    async getProfile() { return externalProfile; },
    async *watchState(_signal) {
      yield { type: 'snapshot', state: { status: 'signed-out', links: {}, attempt: null } };
      // 真实时序：凭证先落库、再发 credentials-changed（生成器 yield 后暂停，
      // 消费端 refresh() 执行时必须已能看到新 profile）
      externalProfile = { status: 'ready', value: { id: 'u_a', name: '新名', contact: null } };
      yield { type: 'credentials-changed', state: { status: 'credential-stored', links: {}, attempt: null } };
    },
  };
  const h4 = createCordisHost({ ctx: { get: (n) => (n === 'deepseekAccount' ? svc4 : undefined) } });
  await h4.whenAccountReady();
  // 流事件后台消费：snapshot(signed-out) 清缓存 → credentials-changed 重拉「新名」
  const refreshed = await waitFor(() => h4.info().user?.nickname === '新名');
  check('watchState 事件后缓存刷新为最新 profile', refreshed, JSON.stringify(h4.info().user));

  // e5. watchState 推 signed-out → 缓存清空
  const svc5 = {
    async getProfile() { return { status: 'ready', value: { id: 'u_b', name: '在线' } }; },
    async *watchState(_signal) { yield { type: 'credentials-changed', state: { status: 'signed-out', links: {}, attempt: null } }; },
  };
  const h5 = createCordisHost({ ctx: { get: (n) => (n === 'deepseekAccount' ? svc5 : undefined) } });
  await h5.whenAccountReady();
  const cleared = await waitFor(() => !('user' in h5.info()));
  check('watchState 登出事件 → 清缓存不发 user', cleared);

  // e6. config 显式在场时引擎源不参与（避免两套真相）
  const svc6 = fakeAccountSvc({ profile: readyProfile });
  const h6 = createCordisHost({ ctx: { get: (n) => (n === 'deepseekAccount' ? svc6 : undefined) }, user: { nickname: '配置优先' } });
  await h6.whenAccountReady();
  check('config 显式在场 → 引擎源不参与', h6.info().user?.nickname === '配置优先' && svc6.getProfileCalls() === 0, String(svc6.getProfileCalls()));

  // e7. getProfile 抛异常 → 不崩、无字段
  const h7 = createCordisHost({ ctx: { get: (n) => (n === 'deepseekAccount' ? { async getProfile() { throw new Error('boom'); } } : undefined) } });
  await h7.whenAccountReady();
  check('引擎 RPC 抛错 → 不崩、不发 user', !('user' in h7.info()));

  // e8. 宿主无 deepseekAccount 服务 → 引擎源静默不可用
  const h8 = createCordisHost({ ctx: { get: () => undefined } });
  await h8.whenAccountReady();
  check('无引擎服务 → 引擎源静默跳过', !('user' in h8.info()));
}

// ---- 3. 端到端：/mobile/v1/host 带出 user（mock gateway）----
if (await portFree(PORT)) {
  const logLines = [];
  const host = createMockHost({ log: (m) => logLines.push(m) });
  const gw = await createGateway({ host, port: PORT, dev: true, log: (m) => logLines.push(m) });
  const addr = await gw.start();
  try {
    const code = await httpJson({ port: PORT, method: 'POST', path: '/mobile/v1/pairing/code', body: { deviceName: 'host-user-test' } });
    const redeem = await httpJson({
      port: PORT, method: 'POST',
      path: '/mobile/v1/pairing/redeem',
      body: { code: code.body?.code, installId: 'ins_host_user' },
    });
    const token = redeem.body?.deviceToken;
    check('端到端配对成功', Boolean(token), JSON.stringify(redeem.body).slice(0, 120));

    const res = await httpJson({ port: PORT, path: '/mobile/v1/host', headers: token ? { Authorization: `Bearer ${token}` } : {} });
    check('GET /host 200', res.status === 200, String(res.status));
    check('端点带出 user.nickname', res.body?.user?.nickname === '大葉', JSON.stringify(res.body?.user));
    check('端点 user.maskedContact 与夹具一致', res.body?.user?.maskedContact === '138****6688', res.body?.user?.maskedContact);
    check('端点其余字段不受影响', res.body?.hostId === 'host_mock' && typeof res.body?.serverTime === 'string');
  } finally {
    await gw.stop();
  }
} else {
  console.log('  (跳过端到端：端口被占)');
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f.name} — ${f.detail}`);
  process.exit(1);
}
