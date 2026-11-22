// test/install-progress.mjs — cloudflared 下载任务状态机回归（0.3.0）
//
// 覆盖：POST 启动即返回、真实字节进度回传、完成回填、幂等复用、
// 中途取消、心跳/总超时、单例不并发。全程注入 mock fetch 与临时目录，不联网、不碰真实组件目录。

import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startInstall, installStatus, cancelInstall, resetInstallJobForTest,
} from '../src/cloudflared-install-job.mjs';
import { CLOUDFLARED_RELEASE } from '../src/cloudflared-install.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cf-progress-'));

function fakePe(size) {
  const b = Buffer.alloc(size, 0x5a);
  b.write('MZ', 0, 'latin1');
  return b;
}

/** 分批吐字节的 fetch mock；高度贴近 Node fetch 的 ReadableStream 形状。 */
function streamFetch(buf, { chunks = 8, delay = 0, hang = false } = {}) {
  return async (url, opts = {}) => {
    const signal = opts.signal;
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) throw aborted();
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) },
      body: {
        getReader() {
          let i = 0;
          return {
            async read() {
              if (signal?.aborted) throw aborted();
              if (hang) {
                return new Promise((_, reject) => {
                  signal?.addEventListener('abort', () => reject(aborted()), { once: true });
                });
              }
              if (delay) await sleep(delay);
              if (i >= chunks) return { done: true };
              const start = Math.floor((i * buf.length) / chunks);
              const end = Math.floor(((i + 1) * buf.length) / chunks);
              i += 1;
              return { done: false, value: buf.subarray(start, end) };
            },
          };
        },
      },
    };
  };
}

async function settle(jobId, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = installStatus();
    if (s.jobId === jobId && ['done', 'failed', 'canceled'].includes(s.state)) return s;
    await sleep(10);
  }
  throw new Error(`任务 ${jobId} 未在 ${timeoutMs}ms 内结束（当前 ${installStatus().state}）`);
}

console.log('\ncloudflared 下载任务状态机回归\n');

// 1. 启动即返回 + 真实字节进度 + 完成回填
{
  resetInstallJobForTest();
  const destDir = path.join(tmp, 'win-ok');
  const payload = fakePe(55483112);
  const seen = [];
  const successes = [];
  const started = startInstall({
    destDir, platform: 'win32', arch: 'x64',
    fetchImpl: streamFetch(payload, { chunks: 12 }),
    onSuccess: (r) => successes.push(r.executable),
    totalMs: 8000,
  });
  check('POST 启动后立刻返回 started', started.started === true);
  check('启动时就给出 jobId', typeof started.jobId === 'string' && started.jobId.startsWith('install-'));
  check('启动时就给出官方下载地址', /github\.com\/cloudflare\/cloudflared\/releases\/download/.test(started.downloadUrl || ''));
  check('版本与常量一致', started.version === CLOUDFLARED_RELEASE);
  check('初始进度为 0', installStatus().percent === 0);

  // 进度回调是同步累积的，任务很快完成；另起一个带延迟的任务单独验递增。
  const final = await settle(started.jobId);
  check('任务完成状态为 done', final.state === 'done', final.state);
  check('完成时进度 100%', final.percent === 100, String(final.percent));
  check('完成任务没有错误', final.error === null);
  check('二进制落在私有组件目录', existsSync(path.join(destDir, 'cloudflared.exe')));
  check('完成后回填开通器路径', successes[0] === path.join(destDir, 'cloudflared.exe'), String(successes[0]));

  resetInstallJobForTest();
  const destSlow = path.join(tmp, 'win-slow');
  const started2 = startInstall({
    destDir: destSlow, platform: 'win32', arch: 'x64',
    fetchImpl: streamFetch(payload, { chunks: 6, delay: 15 }),
    onProgress: undefined,
    totalMs: 8000,
  });
  const seenLoaded = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const st = installStatus();
    if (st.jobId === started2.jobId && st.state === 'running') seenLoaded.push(st.loaded);
    if (st.state === 'done') break;
    await sleep(5);
  }
  await settle(started2.jobId);
  const nonZero = seenLoaded.filter((n) => n > 0);
  check('进度回传真实非零字节数', nonZero.length >= 2, `samples=${nonZero.length}`);
  check('字节数单调递增', nonZero.every((n, i) => i === 0 || n >= nonZero[i - 1]));
  check('下载字节数不超过官方大小', Math.max(...nonZero, 0) <= payload.length);
  void seen;
}

// 2. 幂等复用：装好后不再下载
{
  const destDir = path.join(tmp, 'win-ok');
  const reused = startInstall({
    destDir, platform: 'win32', arch: 'x64',
    fetchImpl: async () => { throw new Error('不应再次下载'); },
  });
  check('已安装时返回 installed', reused.installed === true && reused.reused === true);
  check('已安装时不启动新任务', reused.started === false);
  check('复用路径指向已有二进制', reused.result.executable === path.join(destDir, 'cloudflared.exe'));
}

// 3. 取消：stop 后不落盘、状态 canceled
{
  resetInstallJobForTest();
  const destDir = path.join(tmp, 'win-cancel');
  const started = startInstall({
    destDir, platform: 'win32', arch: 'x64',
    fetchImpl: streamFetch(fakePe(55483112), { chunks: 30, delay: 20 }),
    totalMs: 8000,
  });
  const cancel = cancelInstall();
  check('取消请求命中运行中的任务', cancel.canceled === true && cancel.jobId === started.jobId);
  const final = await settle(started.jobId);
  check('取消后状态为 canceled', final.state === 'canceled', final.state);
  check('取消错误码可辨识', final.error?.code === 'DOWNLOAD_CANCELLED', JSON.stringify(final.error));
  check('取消后不留下二进制', !existsSync(path.join(destDir, 'cloudflared.exe')));
  check('无任务时重复取消返回 canceled:false', cancelInstall().canceled === false);
}

// 4. 超时：慢但持续有字节不算超时；彻底卡住才算
{
  resetInstallJobForTest();
  const destDir = path.join(tmp, 'win-timeout');
  const started = startInstall({
    destDir, platform: 'win32', arch: 'x64',
    fetchImpl: streamFetch(fakePe(55483112), { hang: true }),
    totalMs: 80,
    idleMs: 40,
  });
  const final = await settle(started.jobId, 3000);
  check('卡死任务落到 failed', final.state === 'failed', final.state);
  check('超时错误码为 DOWNLOAD_TIMEOUT', final.error?.code === 'DOWNLOAD_TIMEOUT', JSON.stringify(final.error));
  check('超时文案给出浏览器下载出路', /下载超时.*浏览器/.test(final.error?.message || ''), final.error?.message);
  check('超时后不留下二进制', !existsSync(path.join(destDir, 'cloudflared.exe')));
}

// 5. 单例：重复启动复用同一 job，不并发抢同一个文件
{
  resetInstallJobForTest();
  const destDir = path.join(tmp, 'win-single');
  const fetchImpl = streamFetch(fakePe(55483112), { chunks: 30, delay: 20 });
  const a = startInstall({ destDir, platform: 'win32', arch: 'x64', fetchImpl, totalMs: 8000 });
  const b = startInstall({ destDir, platform: 'win32', arch: 'x64', fetchImpl, totalMs: 8000 });
  check('重复启动返回同一个 jobId', a.jobId === b.jobId, `${a.jobId} vs ${b.jobId}`);
  check('重复启动仍标记 started', b.started === true);
  await settle(a.jobId);
}
resetInstallJobForTest();

// 6. 真实 HTTP 路由：面板轮询的 GET 与摘要字段都可用（不触发真实下载）
{
  const { createGateway } = await import('../src/server.mjs');
  const { createMockHost } = await import('../src/adapter/mock-host.mjs');
  const { httpJson } = await import('./lib/wsclient.mjs');
  const PORT = Number(process.env.INSTALL_PROGRESS_PORT || 3397);
  const gw = await createGateway({ host: createMockHost(), port: PORT, dev: true, log: () => {} });
  await gw.start();
  try {
    const progress = await httpJson({ port: PORT, path: '/mobile/v1/tunnel/install-cloudflared' });
    check('GET 安装进度端点可达', progress.status === 200 && progress.body?.state === 'idle', JSON.stringify(progress.body));
    const summary = await httpJson({ port: PORT, path: '/mobile/v1/desktop/summary' });
    check('摘要下发官方下载地址', /github\.com\/cloudflare\/cloudflared/.test(summary.body?.tunnel?.downloadUrl || ''));
    check('摘要下发安装任务状态', summary.body?.tunnel?.install?.state === 'idle', JSON.stringify(summary.body?.tunnel?.install));
  } finally {
    await gw.stop();
  }
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败\n`);
if (failures.length) process.exit(1);
