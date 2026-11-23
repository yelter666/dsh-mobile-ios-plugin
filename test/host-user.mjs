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

// ---- 2. cordis host：三种来源形态 ----
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
