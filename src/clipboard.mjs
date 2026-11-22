// clipboard.mjs — 宿主本机系统剪贴板写入（网关侧）
//
// 为什么存在：Electron `dsh-app://` 自定义协议页面里，浏览器剪贴板 API
// （navigator.clipboard / execCommand）不可靠——writeText 可能永不 settle，
// execCommand 对屏幕外元素拿不到选区。「复制包名点了没反应」折腾多轮的教训。
// 网关跑在宿主本机（loopback-only），直接调用系统自带剪贴板工具是最可靠的一级：
//   macOS  pbcopy     （系统内置）
//   win32  clip       （系统内置）
//   linux  wl-copy / xclip -selection clipboard（无则报错，由面板降级）
// 面板把这一级放在最前面，失败才走 JS 三级降级。

import { spawn } from 'node:child_process';

const TIMEOUT_MS = 3000;

/** 各平台的写入命令链。返回 [{ cmd, args }]，按顺序试，第一个成功即止。 */
export function clipboardTools(platform = process.platform) {
  if (platform === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ cmd: 'clip', args: [] }];
  if (platform === 'linux') {
    return [
      { cmd: 'wl-copy', args: [] },
      { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    ];
  }
  return [];
}

/**
 * 把文本写入系统剪贴板。execImpl 注入便于测试；默认 node spawn。
 * @returns {Promise<{ ok: true, tool: string }>} 全部失败抛错（code: CLIPBOARD_UNAVAILABLE）
 */
export async function copyToSystemClipboard(text, { execImpl, platform = process.platform } = {}) {
  const value = String(text ?? '');
  if (!value) throw Object.assign(new Error('剪贴板内容为空'), { code: 'CLIPBOARD_EMPTY' });
  const run = execImpl || ((cmd, args, input) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      reject(Object.assign(new Error(`${cmd} 超时`), { code: 'CLIPBOARD_TIMEOUT' }));
    }, TIMEOUT_MS);
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`${cmd} 退出码 ${code}${stderr ? `：${stderr.trim()}` : ''}`), { code: 'CLIPBOARD_FAILED' }));
    });
    child.stdin?.on('error', () => { /* EPIPE 交给 close 判定 */ });
    child.stdin?.end(value);
  }));

  const tools = clipboardTools(platform);
  if (!tools.length) {
    throw Object.assign(new Error(`暂不支持的平台：${platform}`), { code: 'CLIPBOARD_UNAVAILABLE' });
  }
  let lastErr = null;
  for (const { cmd, args } of tools) {
    try {
      await run(cmd, args, value);
      return { ok: true, tool: cmd };
    } catch (err) {
      lastErr = err;
    }
  }
  throw Object.assign(
    new Error(`系统剪贴板工具不可用：${lastErr?.message || lastErr}`),
    { code: 'CLIPBOARD_UNAVAILABLE' },
  );
}
