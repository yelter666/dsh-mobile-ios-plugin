// test/clipboard.mjs — 系统剪贴板写入回归（0.3.2）
//
// 背景：「复制包名/安装指令点了没反应」折腾多轮的根因是 dsh-app:// 页面里
// 浏览器剪贴板 API 不可靠。0.3.2 起面板一级走网关 → 系统工具（pbcopy/clip）。
// 本套件注入 execImpl 验证命令链与 stdin 内容；路由层用注入的 clipboardImpl，
// 不真的写测试机剪贴板。

import { createGateway } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { copyToSystemClipboard, clipboardTools } from '../src/clipboard.mjs';
import { httpJson } from './lib/wsclient.mjs';
import { fakeTunnel } from './lib/fake-tunnel.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n系统剪贴板写入回归\n');

// 1. 平台命令链
check('macOS 用 pbcopy', clipboardTools('darwin')[0].cmd === 'pbcopy');
check('Windows 用 clip', clipboardTools('win32')[0].cmd === 'clip');
check('Linux 先 wl-copy 后 xclip', clipboardTools('linux').map((t) => t.cmd).join(',') === 'wl-copy,xclip');
check('未知平台无命令链', clipboardTools('sunos').length === 0);

// 2. 写入成功：stdin 收到完整文本
{
  const seen = [];
  const res = await copyToSystemClipboard('dsh-mobile-ios@0.3.2', {
    platform: 'darwin',
    execImpl: (cmd, args, input) => { seen.push({ cmd, args, input }); return Promise.resolve(); },
  });
  check('成功返回 ok 与工具名', res.ok === true && res.tool === 'pbcopy', JSON.stringify(res));
  check('stdin 收到完整文本', seen.length === 1 && seen[0].input === 'dsh-mobile-ios@0.3.2', JSON.stringify(seen));
}

// 3. 降级：第一个工具不存在，第二个成功
{
  const tried = [];
  const res = await copyToSystemClipboard('hello', {
    platform: 'linux',
    execImpl: (cmd, args, input) => {
      tried.push(cmd);
      if (cmd === 'wl-copy') return Promise.reject(new Error('not found'));
      return Promise.resolve();
    },
  });
  check('第一级失败降级到第二级', res.ok === true && res.tool === 'xclip', JSON.stringify(res));
  check('降级顺序正确', tried.join(',') === 'wl-copy,xclip', tried.join(','));
}

// 4. 全部失败：报 CLIPBOARD_UNAVAILABLE
{
  let err = null;
  try {
    await copyToSystemClipboard('hello', {
      platform: 'darwin',
      execImpl: () => Promise.reject(new Error('spawn failed')),
    });
  } catch (e) { err = e; }
  check('全部失败抛错', err?.code === 'CLIPBOARD_UNAVAILABLE', String(err));
}

// 5. 空文本与退出码非 0
{
  let err = null;
  try { await copyToSystemClipboard('', { execImpl: () => Promise.resolve() }); } catch (e) { err = e; }
  check('空文本报 CLIPBOARD_EMPTY', err?.code === 'CLIPBOARD_EMPTY', String(err));
  err = null;
  try {
    await copyToSystemClipboard('x', {
      platform: 'darwin',
      execImpl: () => Promise.reject(Object.assign(new Error('exit 1'), { code: 'CLIPBOARD_FAILED' })),
    });
  } catch (e) { err = e; }
  check('工具退出非 0 报 CLIPBOARD_UNAVAILABLE', err?.code === 'CLIPBOARD_UNAVAILABLE', String(err));
}

// 6. 真实路由：回环-only + 参数校验 + 注入实现写入成功
{
  const writes = [];
  const gw = await createGateway({
    host: createMockHost(),
    port: 3218,
    dev: true,
    log: () => {},
    tunnelSpawn: fakeTunnel('quick').spawnImpl,
    clipboardImpl: async (text) => { writes.push(text); return { ok: true, tool: 'test-impl' }; },
  });
  const { port } = await gw.start();
  try {
    const viaTunnel = await httpJson({
      port, method: 'POST', path: '/mobile/v1/clipboard', body: { text: 'x' },
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
    });
    check('隧道来源不能写剪贴板', viaTunnel.status === 403, JSON.stringify(viaTunnel.body));

    const empty = await httpJson({ port, method: 'POST', path: '/mobile/v1/clipboard', body: {} });
    check('空 text 报 4400', empty.status === 400, JSON.stringify(empty.body));

    const okRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/clipboard', body: { text: 'dsh-test' } });
    check('本机写入返回 ok', okRes.status === 200 && okRes.body?.ok === true, JSON.stringify(okRes.body));
    check('写入实现收到文本', writes.join('|') === 'dsh-test', writes.join('|'));

    const cors = await httpJson({
      port, method: 'POST', path: '/mobile/v1/clipboard', body: { text: 'x' },
      headers: { Origin: 'dsh-app://app' },
    });
    check('桌面端（dsh-app://）能写入并带 CORS 头', cors.status === 200
      && (cors.headers['access-control-allow-origin'] || '') === '*', JSON.stringify(cors.headers));

    const evil = await httpJson({
      port, method: 'POST', path: '/mobile/v1/clipboard', body: { text: 'x' },
      headers: { Origin: 'https://evil.example.com' },
    });
    check('外部网页 Origin 不能写剪贴板', evil.status === 403, JSON.stringify(evil.body));
  } finally {
    await gw.stop?.().catch?.(() => {}) ?? null;
    if (typeof gw.stop === 'function') await gw.stop();
  }
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
