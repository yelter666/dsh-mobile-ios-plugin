// test/rebuild-provisioner.mjs — 固定地址开通器运行时重判回归（0.3.2）
//
// 背景：开通器原来只在网关启动时判定一次。全新机器（无 cert.pem、无状态文件）
// 启动时 provisioner=null → 永远 Quick Tunnel——之后装好 cloudflared、
// 浏览器授权完成，也分不出 matrixboard.cn 固定地址（真机实测踩坑）。
// 0.3.2 起：授权成功（GET /tunnel/login state=ok）自动重判 + 手动重判端点。
// 本套件用注入的假 loginManager 与临时状态文件验证整条链，不联网。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway, makeHostAllow } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { CloudflareProvisioner } from '../src/cloudflare.mjs';
import { httpJson } from './lib/wsclient.mjs';
import { fakeTunnel } from './lib/fake-tunnel.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rebuild-'));
const stateFile = path.join(tmp, 'state.json');
const PORT = 3222;

/** 假 Cloudflare：建隧道/写 DNS 最小实现（照抄 tunnel-named 的 envelope 形状）。 */
function fakeCloudflare() {
  let tunnelId = null;
  const calls = [];
  const json = (data, status = 200) => ({ ok: true, status, json: async () => data });
  return {
    calls,
    fetchImpl: async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      calls.push({ url: String(url), method, body: opts.body ? String(opts.body) : null });
      if (url.includes('/accounts/acc_1/tunnels') && method === 'GET') {
        return json({ success: true, result: [], result_info: {} });
      }
      if (url.includes('/accounts/acc_1/tunnels') && method === 'POST') {
        tunnelId = `tun_${Math.random().toString(16).slice(2, 8)}`;
        return json({ success: true, result: { id: tunnelId, name: 'dsh-test', status: 'pending', token: 'ZmFrZS10b2tlbg==' } });
      }
      if (url.includes('/cfd_tunnel/') && url.includes('/token') && method === 'GET') {
        return json({ success: true, result: { token: 'ZmFrZS10b2tlbg==' } });
      }
      if (url.includes('/cfd_tunnel/') && method === 'PUT') {
        return json({ success: true, result: [] });
      }
      if (url.includes('/dns_records') && method === 'POST') {
        return json({ success: true, result: { id: 'dns1' } });
      }
      if (url.includes('/zones')) {
        return json({ success: true, result: [{ id: 'zone1', name: 'matrixboard.cn', status: 'active' }] });
      }
      return json({ success: true, result: {} });
    },
  };
}

/** 假 loginManager：可切换状态，模拟「浏览器授权完成」。 */
function fakeLoginManager() {
  let state = 'idle';
  return {
    set(s) { state = s; },
    status: () => ({ state, url: state === 'waiting' ? 'https://dash.cloudflare.com/argotunnel?fake' : null }),
    start: async () => ({ state }),
    cancel: () => ({ state: 'canceled' }),
  };
}

console.log('\n固定地址开通器运行时重判回归\n');

const cf = fakeCloudflare();
const mkProv = () => new CloudflareProvisioner({
  apiToken: 'cf-token', accountId: 'acc_1', seed: 'rebuild-test',
  stateFile, fetchImpl: cf.fetchImpl,
  probe: async () => ({ ok: true, kind: 'CNAME', records: ['tun_x.cfargotunnel.com'] }),
});
const login = fakeLoginManager();
let rebuilds = 0;

const gw = await createGateway({
  host: createMockHost(),
  port: PORT,
  dev: true,
  log: () => {},
  tunnelSpawn: fakeTunnel('quick').spawnImpl,
  // 启动时凭据不全 → null（全新机器的真实起点）
  tunnelProvisioner: null,
  rebuildProvisioner: () => { rebuilds += 1; return mkProv(); },
  loginManager: login,
});
const { port } = await gw.start();

try {
  const before = await httpJson({ port, path: '/mobile/v1/desktop/summary' });
  check('启动时没有开通器（quick 模式）', before.body?.tunnel?.mode === 'quick'
    && before.body?.tunnel?.provisionerKind === null, JSON.stringify(before.body?.tunnel));

  // 手动重判端点
  const rebuilt = await httpJson({ port, method: 'POST', path: '/mobile/v1/tunnel/rebuild-provisioner' });
  check('手动重判返回 200', rebuilt.status === 200, JSON.stringify(rebuilt.body));
  check('重判后开通器就位（named 模式）', rebuilt.body?.provisionerKind === 'cloudflare'
    && rebuilt.body?.status?.mode === 'named', JSON.stringify(rebuilt.body));
  check('重判工厂确实被调用', rebuilds >= 1);

  const after = await httpJson({ port, path: '/mobile/v1/desktop/summary' });
  check('摘要反映 named 模式', after.body?.tunnel?.mode === 'named'
    && after.body?.tunnel?.provisionerKind === 'cloudflare', JSON.stringify(after.body?.tunnel));

  // hostAllow 形状：重建时 suffixes 必须并入自有域名（WS 握手白名单靠它）
  const allowBase = makeHostAllow(['trycloudflare.com']);
  const allowRebuilt = makeHostAllow(['trycloudflare.com', 'matrixboard.cn']);
  check('基础白名单不含自有域名', !allowBase('dsh-x.matrixboard.cn'));
  check('重建后白名单含自有域名', allowRebuilt('dsh-x.matrixboard.cn'));

  // 授权完成自动重判：登录 ok + 当前 quick → 重建一次
  const gw2 = await createGateway({
    host: createMockHost(),
    port: PORT + 1,
    dev: true,
    log: () => {},
    tunnelSpawn: fakeTunnel('quick').spawnImpl,
    tunnelProvisioner: null,
    rebuildProvisioner: () => mkProv(),
    loginManager: login,
  });
  const { port: port2 } = await gw2.start();
  try {
    login.set('ok');
    const poll = await httpJson({ port: port2, path: '/mobile/v1/tunnel/login' });
    check('授权 ok 后轮询返回成功', poll.status === 200 && poll.body?.state === 'ok', JSON.stringify(poll.body));
    check('授权 ok 自动重判开通器', poll.body?.provisionerKind === 'cloudflare', JSON.stringify(poll.body));
    const summary2 = await httpJson({ port: port2, path: '/mobile/v1/desktop/summary' });
    check('重判后 mode 变 named', summary2.body?.tunnel?.mode === 'named', JSON.stringify(summary2.body?.tunnel));
    const countBefore = rebuilds;
    const twice = await httpJson({ port: port2, path: '/mobile/v1/tunnel/login' });
    check('已是 named 后轮询不再重复重建', twice.body?.provisionerKind === 'cloudflare' && rebuilds === countBefore,
      JSON.stringify(twice.body));
  } finally {
    await gw2.stop();
  }
} finally {
  await gw.stop();
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
