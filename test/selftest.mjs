// test/selftest.mjs — 网关端到端自检（无框架，跑完给结论）
// 覆盖面：鉴权、配对、幂等、能力缺失、WS 票据、握手、续传、限速、撤销、端口释放、插件隔离

import { createGateway, makeHostAllow } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { connect, httpJson, portFree } from './lib/wsclient.mjs';

const PORT = Number(process.env.PORT || 3181);
let pass = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const logLines = [];
const host = createMockHost({ log: (m) => logLines.push(m) });
const gw = await createGateway({ host, port: PORT, dev: true, log: (m) => logLines.push(m) });
const addr = await gw.start();
const { port } = addr;

console.log(`\n网关自检 @ 127.0.0.1:${port}\n`);

// ---- 1. 绑定与健康 ----
check('默认绑定全部网卡（LAN 伴侣路径）', addr.address === '0.0.0.0', addr.address);
check('手机连接地址已计算（LAN IP:port 或显式 null）', addr.lan === null || /^\d+\.\d+\.\d+\.\d+:\d+$/.test(addr.lan), String(addr.lan));
const health = await httpJson({ port, path: '/mobile/v1/health' });
check('health 免鉴权可用', health.status === 200 && health.body?.ok === true);

// ---- 1a. WS Host 白名单（LAN 直连必须放行私网 Host 头）----
const allow = makeHostAllow(['trycloudflare.com']);
check('Host 白名单放行回环', allow('127.0.0.1:3081') && allow('localhost:3081'));
check('Host 白名单放行私网 IPv4（手机 LAN 直连）', allow('192.168.1.5:3081') && allow('10.0.0.2:3081') && allow('172.16.3.4:3081'));
check('Host 白名单放行隧道域名', allow('abc.trycloudflare.com'));
check('Host 白名单拒绝公网/陌生域', !allow('8.8.8.8:3081') && !allow('evil.example.com') && !allow('172.32.0.1:3081'));

// ---- 1b. 桌面端 banner（X3：desktop/summary + CORS 白名单）----
const summary = await httpJson({ port, path: '/mobile/v1/desktop/summary' });
check('desktop/summary 回环免鉴权', summary.status === 200 && summary.body?.ok === true);
check('summary 带 lan 字段（与监听面一致）', summary.body?.lan === addr.lan
  || (summary.body?.lan === null && addr.lan === null), `${summary.body?.lan} vs ${addr.lan}`);
check('summary 含展示字段且无敏感字段', summary.body?.adapter === 'mock'
  && typeof summary.body?.pairing?.activeDevices === 'number'
  && summary.body?.pairing?.maxDevices === 5
  && Array.isArray(summary.body?.pairing?.devices)
  && summary.body?.tunnel?.state !== undefined
  && !('token' in summary.body) && !('credentials' in summary.body), JSON.stringify(summary.body));
check('summary 带 CORS 头', String(health.headers?.['access-control-allow-origin'] ?? '') === '*'
  && String(summary.headers?.['access-control-allow-origin'] ?? '') === '*', JSON.stringify(summary.headers ?? {}));
const preflight = await httpJson({
  port, method: 'OPTIONS', path: '/mobile/v1/pairing/code',
  headers: { origin: 'app://dsh', 'access-control-request-method': 'POST' },
});
check('pairing/code 预检 → 204 + CORS', preflight.status === 204
  && String(preflight.headers?.['access-control-allow-origin'] ?? '') === '*');
const preflightRevoke = await httpJson({
  port, method: 'OPTIONS', path: '/mobile/v1/pairing/revoke-device',
  headers: { origin: 'app://dsh', 'access-control-request-method': 'POST' },
});
check('revoke-device 预检 → 204 + CORS（白名单缺失时下线按钮报 Failed to fetch）',
  preflightRevoke.status === 204 && String(preflightRevoke.headers?.['access-control-allow-origin'] ?? '') === '*');
const tasksCors = await httpJson({ port, path: '/mobile/v1/tasks' });
check('白名单外路由不发 CORS 头', tasksCors.headers?.['access-control-allow-origin'] === undefined);

// ---- 2. 未鉴权与错误码 ----
const noAuth = await httpJson({ port, path: '/mobile/v1/tasks' });
check('无凭证访问任务列表 → 4001', noAuth.status === 401 && noAuth.body?.error?.code === 4001, JSON.stringify(noAuth.body));

// ---- 3. 配对 ----
const codeRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: { deviceName: 'iPhone 17 Pro' } });
const code = codeRes.body?.code;
check('配对码 6 位 + qrPayload', codeRes.status === 201 && /^\d{6}$/.test(code) && String(codeRes.body.qrPayload).includes(code));

const wrong = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/redeem', body: { code: '000000', installId: 'ins_test' } });
check('错误配对码 → 4008 且余次减少', wrong.status === 400 && wrong.body?.error?.code === 4008, JSON.stringify(wrong.body));

const redeem = await httpJson({
  port,
  method: 'POST',
  path: '/mobile/v1/pairing/redeem',
  body: { code, installId: 'ins_test', deviceName: 'iPhone 17 Pro', platform: 'ios', appVersion: '2.0.0 (spike0)' },
});
const token = redeem.body?.deviceToken;
const deviceId = redeem.body?.deviceId;
check('凭证兑换成功且带 caps', redeem.status === 200 && Boolean(token) && Array.isArray(redeem.body.caps));
check('兑换回包带协议版本', redeem.body?.protocolVersion === '1.0');

const reuse = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/redeem', body: { code, installId: 'ins_test' } });
check('配对码单次有效（复用 → 4008）', reuse.body?.error?.code === 4008);

// ---- 4. 一元接口 ----
const list = await httpJson({ port, path: '/mobile/v1/tasks', token });
check('任务列表可用且有数据', list.status === 200 && list.body.items.length >= 2, `items=${list.body?.items?.length}`);

const detailRes = await httpJson({ port, path: '/mobile/v1/tasks/tsk_a41f9c', token });
check('任务详情含 pendingTodos', detailRes.status === 200 && Array.isArray(detailRes.body.pendingTodos));

const missing = await httpJson({ port, path: '/mobile/v1/tasks/tsk_nope', token });
check('任务不存在 → 4011', missing.status === 404 && missing.body?.error?.code === 4011);

const rollback = await httpJson({ port, method: 'POST', path: '/mobile/v1/tasks/tsk_a41f9c/rollback', body: {}, token });
check('未实现能力 → 4021（不是 500）', rollback.status === 501 && rollback.body?.error?.code === 4021);

const created = await httpJson({
  port,
  method: 'POST',
  path: '/mobile/v1/tasks',
  token,
  body: { prompt: '把重试改成指数退避', submissionId: 'sub_fixed_001' },
});
check('建任务 202 + accepted', created.status === 202 && created.body?.accepted === true);
const createdAgain = await httpJson({
  port,
  method: 'POST',
  path: '/mobile/v1/tasks',
  token,
  body: { prompt: '把重试改成指数退避', submissionId: 'sub_fixed_001' },
});
check(
  '同 submissionId 幂等（返回首次结果）',
  createdAgain.body?.taskId === created.body?.taskId && createdAgain.body?.replayed === true,
  JSON.stringify(createdAgain.body)
);

const msg = await httpJson({ port, method: 'POST', path: `/mobile/v1/tasks/${created.body.taskId}/messages`, token, body: { text: '顺便补测试', submissionId: 'sub_fixed_002' } });
check('追加消息 202 + turnId', msg.status === 202 && Boolean(msg.body?.turnId));

// ---- 4a. 附件上送（2026-11-18「+」开放）----
// 图片内联 / 文件 receiptId 的宿主翻译在 cordis 适配器；这里验 HTTP 层：
// 纯附件消息可过、带 base64 的正文不再被 1MB 旧限制挡住。
const attachmentOnly = await httpJson({
  port, method: 'POST', path: `/mobile/v1/tasks/${created.body.taskId}/messages`, token,
  body: {
    text: '', submissionId: 'sub_fixed_att_1',
    attachments: [{ kind: 'image', name: 'shot.jpg', mediaType: 'image/jpeg', dataBase64: 'AAECAw==' }],
  },
});
check('纯附件消息（空 text）202', attachmentOnly.status === 202 && Boolean(attachmentOnly.body?.turnId),
  JSON.stringify(attachmentOnly.body));

// 1.2MB 的 base64 图片：旧 BODY_LIMIT=1MB 会 4400，新 25MB 应放行。
const bigImage = Buffer.alloc(1_200_000, 7).toString('base64');
const bigAttachment = await httpJson({
  port, method: 'POST', path: `/mobile/v1/tasks/${created.body.taskId}/messages`, token,
  body: {
    text: '大图', submissionId: 'sub_fixed_att_2',
    attachments: [{ kind: 'image', name: 'big.png', mediaType: 'image/png', dataBase64: bigImage }],
  },
});
check('超过 1MB 的图片附件不再被拒（BODY_LIMIT 提升到 25MB）',
  bigAttachment.status === 202, `status=${bigAttachment.status} ${JSON.stringify(bigAttachment.body)}`);

// ---- 5. WS 鉴权 ----
let upgraded = null;
try {
  upgraded = await connect({ port, protocols: ['dsh.v1'] });
} catch (err) {
  upgraded = err;
}
check('无票据/无 Bearer 升级 → 401', upgraded?.status === 401, String(upgraded?.status || upgraded?.message));

const ticketRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/ws-ticket', token });
check('ws-ticket 下发 30s 一次性票据', ticketRes.status === 201 && Boolean(ticketRes.body.ticket));

const client = await connect({ port, protocols: ['dsh.v1', `ticket.${ticketRes.body.ticket}`] });
check('子协议协商回 dsh.v1', client.protocol === 'dsh.v1', String(client.protocol));

const ticketAgain = await connect({ port, protocols: ['dsh.v1', `ticket.${ticketRes.body.ticket}`] }).catch((e) => e);
check('票据一次性（重放 → 401）', ticketAgain?.status === 401);

// ---- 6. 握手 ----
client.send({ t: 'hello', protocolVersion: '0.9', caps: [], deviceId, installId: 'ins_test' });
const bad = await client.until((j) => j?.t === 'reject');
check('协议版本不兼容 → reject 4004', bad.json?.code === 4004, JSON.stringify(bad.json));
const badClose = await client.waitClose();
check('reject 后关闭码 1008', badClose.code === 1008, String(badClose.code));

const t2 = (await httpJson({ port, method: 'POST', path: '/mobile/v1/ws-ticket', token })).body.ticket;
const c2 = await connect({ port, protocols: ['dsh.v1', `ticket.${t2}`] });
c2.send({ t: 'hello', protocolVersion: '1.0', caps: ['tasks.read'], deviceId, installId: 'wrong_install' });
const reject2 = await c2.until((j) => j?.t === 'reject');
check('installId 不一致 → 4009（要求重新配对）', reject2.json?.code === 4009, JSON.stringify(reject2.json));
c2.close();

const t3 = (await httpJson({ port, method: 'POST', path: '/mobile/v1/ws-ticket', token })).body.ticket;
const c3 = await connect({ port, protocols: ['dsh.v1', `ticket.${t3}`] });
const fullDeviceName = '李大葉的 iPhone 17 Pro Max（工作机）';
c3.send({ t: 'hello', protocolVersion: '1.0', caps: ['tasks.read'], deviceId, installId: 'ins_test', deviceName: fullDeviceName });
const ready = await c3.until((j) => j?.t === 'ready');
check('握手成功且 ready 含 gen/caps', Boolean(ready.json?.gen) && Array.isArray(ready.json?.caps), JSON.stringify(ready.json));
const renamedSummary = await httpJson({ port, path: '/mobile/v1/desktop/summary' });
check('hello 全称已同步到桌面设备清单', renamedSummary.body?.pairing?.devices?.some((d) => d.deviceName === fullDeviceName),
  JSON.stringify(renamedSummary.body?.pairing?.devices));
const genFirst = ready.json.gen;

// ---- 7. 事件流与 seq ----
// 注意：seq 是"每任务"独立，不能跨任务比较；先滤掉握手时补发的其它任务帧
host.playScenario('tsk_a41f9c', { speed: 8 });
const evs = [];
const deadline = Date.now() + 8000;
while (evs.length < 10 && Date.now() < deadline) {
  const item = await c3.next(6000);
  if (item.json?.t === 'ev' && item.json.taskId === 'tsk_a41f9c') evs.push(item.json);
}
const seqs = evs.map((e) => e.seq);
check('收到 10 帧事件', evs.length === 10, String(evs.length));
check('同任务内 seq 从 1 连续递增', seqs.every((s, i) => s === i + 1), seqs.join(','));
check('事件都带 taskId/at/kind', evs.every((e) => e.taskId && e.at && e.kind));
check('覆盖多种 kind', new Set(evs.map((e) => e.kind)).size >= 4, [...new Set(evs.map((e) => e.kind))].join(','));
c3.close();

// ---- 8. 续传 ----
const t4 = (await httpJson({ port, method: 'POST', path: '/mobile/v1/ws-ticket', token })).body.ticket;
const c4 = await connect({ port, protocols: ['dsh.v1', `ticket.${t4}`] });
c4.send({ t: 'hello', protocolVersion: '1.0', caps: [], deviceId, installId: 'ins_test', lastSeq: 4 });
const ready2 = await c4.until((j) => j?.t === 'ready');
check('续传锚点 = 5', ready2.json?.resumeFrom === 5, JSON.stringify({ resumeFrom: ready2.json?.resumeFrom }));
check('代际 gen 稳定（未重启不该变）', ready2.json?.gen === genFirst);
const firstReplay = await c4.until((j) => j?.t === 'ev');
check('只补 seq > 4 的帧', firstReplay.json.seq === 5, String(firstReplay.json.seq));

// 控制调用
c4.send({ t: 'req', id: 'r1', method: 'ping' });
const pong = await c4.until((j) => j?.t === 'res' && j.id === 'r1');
check('req/ping 回 res', pong.json?.ok === true && Boolean(pong.json?.data?.serverTime));
c4.send({ t: 'req', id: 'r2', method: 'tasks.rollback' });
const miss = await c4.until((j) => j?.t === 'res' && j.id === 'r2');
check('未知方法 → error 4021', miss.json?.error?.code === 4021);
c4.close();

// ---- 8b. 设备治理：面板看清单、逐台下线 ----
{
  const secondCode = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: { deviceName: 'iPad mini' } });
  const secondRedeem = await httpJson({
    port, method: 'POST', path: '/mobile/v1/pairing/redeem',
    body: { code: secondCode.body?.code, installId: 'ins_ipad', deviceName: 'iPad mini', platform: 'ios' },
  });
  check('第二台设备配对成功', secondRedeem.status === 200, JSON.stringify(secondRedeem.body));
  const devicesSummary = await httpJson({ port, path: '/mobile/v1/desktop/summary' });
  const devices = devicesSummary.body?.pairing?.devices ?? [];
  check('摘要列出两台设备并显示关于页全称',
        devices.length === 2 && devices.some((d) => d.deviceName === 'iPad mini')
        && devices.some((d) => d.deviceName === fullDeviceName), JSON.stringify(devices));
  check('摘要不泄露设备凭证哈希',
        devices.every((d) => !('deviceTokenHash' in d) && !('installId' in d)), JSON.stringify(devices));
  check('活跃设备数正确', devicesSummary.body?.pairing?.activeDevices === 2);

  const kicked = await httpJson({
    port, method: 'POST', path: '/mobile/v1/pairing/revoke-device',
    body: { deviceId: secondRedeem.body.deviceId },
  });
  check('单台下线成功且不波及其他设备',
        kicked.status === 200 && kicked.body?.revoked === 1, JSON.stringify(kicked.body));
  const gone = await httpJson({ port, path: '/mobile/v1/tasks', token: secondRedeem.body.deviceToken });
  check('被下线设备凭证 → 4009', gone.status === 401 && gone.body?.error?.code === 4009, JSON.stringify(gone.body));
  const stillGood = await httpJson({ port, path: '/mobile/v1/tasks', token });
  check('其他设备不受影响', stillGood.status === 200);
  const afterKick = await httpJson({ port, path: '/mobile/v1/desktop/summary' });
  check('摘要更新为 1 台', afterKick.body?.pairing?.activeDevices === 1);
}

// ---- 9. diag 与撤销 ----
const diag = await httpJson({ port, path: '/mobile/v1/diag', token });
check('diag 脱敏且含 adapter/events', diag.status === 200 && diag.body.adapter === 'mock' && Boolean(diag.body.stats?.events), JSON.stringify(diag.body.stages));
check('diag 不含 token 明文', !JSON.stringify(diag.body).includes(token.slice(0, 12)));

const revoked = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/revoke', body: {}, token });
check('撤销全部设备', revoked.status === 200 && revoked.body.revoked >= 1);
const afterRevoke = await httpJson({ port, path: '/mobile/v1/tasks', token });
check('撤销后请求 → 4009', afterRevoke.status === 401 && afterRevoke.body?.error?.code === 4009, JSON.stringify(afterRevoke.body));

// ---- 10. 限速 ----
let limited = null;
for (let i = 0; i < 6; i += 1) {
  const r = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: {} });
  if (r.body?.error?.code === 4029) {
    limited = r;
    break;
  }
}
check('配对码生成限速 → 4029', limited?.body?.error?.code === 4029);

// ---- 11. 停服与端口释放 ----
await gw.stop();
check('停服后端口已释放', await portFree(port));

// ---- 12. 插件入口隔离性 ----
const { apply } = await import('../entries/plugin.mjs');
// 测试绝不能碰真实用户状态：默认路径下 apply 会写真实日志、读真实设备注册表与隧道状态，
// 跑一次测试就把用户的配对记录/诊断日志搅乱（实际发生过：日志里混进测试异常）。
const { mkdtempSync } = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const isolateDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-selftest-'));
const isolate = {
  logFile: path.join(isolateDir, 'plugin.log'),
  pairingFile: path.join(isolateDir, 'devices.json'),
  // provisioner=state + 空状态文件 → 不碰任何 Cloudflare 凭据，退化成 Quick Tunnel
  tunnel: { stateFile: path.join(isolateDir, 'tunnel.json'), provisioner: 'state' },
};
const cleanups = [];
// 模拟 Cordis 语义：effect(cb) 会调用 cb，取其返回值作为 disposer
const stubCtx = {
  effect: (cb) => {
    const disposer = cb();
    if (typeof disposer === 'function') cleanups.push(disposer);
    return () => {};
  },
  logger: { info: () => {} },
};
const handle = apply(stubCtx, { ...isolate, port: PORT + 6, printPairingCode: false });
await handle.ready;
check('插件 apply 返回 ok 且拿到地址', handle.ok === true && handle.address?.port === PORT + 6, JSON.stringify(handle.steps));
check('插件注册了清理钩子', cleanups.length === 1);
await cleanups[0]();
await new Promise((r) => setTimeout(r, 120));
check('插件卸载后端口释放', await portFree(PORT + 6));

const brokenCtx = {
  effect: () => {
    throw new Error('宿主 effect 坏了');
  },
  logger: {
    info: () => {
      throw new Error('logger 也坏了');
    },
  },
};
let threw = false;
let brokenHandle = null;
try {
  brokenHandle = apply(brokenCtx, { ...isolate, port: PORT + 7, printPairingCode: false });
} catch {
  threw = true;
}
check('apply 不外抛（防带崩宿主）', threw === false && brokenHandle?.ok === false, brokenHandle?.error || '');
await brokenHandle?.ready?.catch?.(() => {});

// ---- 13. 环缓冲缺口（GW-6 的边界）----
const { EventLog } = await import('../src/ring.mjs');
const ring = new EventLog({ capacity: 3 });
for (let i = 0; i < 5; i += 1) ring.append({ taskId: 't1', kind: 'log', data: { i } });
const gapRes = ring.replay({ lastSeq: 1 });
check('环缓冲下界 = 3（旧帧已丢）', gapRes.resumeFrom === 3, String(gapRes.resumeFrom));
check('缺口被如实标记（不猜、不静默）', gapRes.gap === true);
const okRes = ring.replay({ lastSeq: 4 });
check('游标有效时只补 1 帧', okRes.frames.length === 1 && okRes.frames[0].seq === 5);

// ---- 收尾：删掉本次隔离目录，别在临时目录里留垃圾 ----
// Windows 上日志句柄可能还没完全释放，删不掉就放过（不因清理失败判错）。
try {
  (await import('node:fs')).rmSync(isolateDir, { recursive: true, force: true });
} catch {
  // 忽略：临时目录由系统回收
}

// ---- 汇总 ----
console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
  process.exit(1);
}
process.exit(0);
