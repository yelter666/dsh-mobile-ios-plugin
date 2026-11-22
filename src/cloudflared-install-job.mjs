// cloudflared-install-job.mjs — cloudflared 下载任务的单例状态机
//
// 为什么要有这一层：原来 POST /tunnel/install-cloudflared 同步等 res.arrayBuffer()，
// Windows 53MB 在国内网络下要十几分钟，面板 240 秒超时后只看到「安装失败」，
// 用户主观就是「点了没反应」。现在 POST 只**启动**任务并立刻返回，面板轮询真实字节进度。
//
// 边界：
// 1. 单例：同一时刻只有一个下载任务；重复点确认复用同一个 job，不并发抢同一文件。
// 2. 可取消：用户点「取消并改手动安装」→ abort fetch + 清残留，状态变 canceled。
// 3. 有心跳：慢但持续下载不算超时；连续 idleMs 没收到字节才算卡死。
// 4. 不放松校验：实际下载仍走 ensureCloudflared（官方源 + 字节数 + 魔数）。

import { ensureCloudflared, findInstalledCloudflared, resolveAsset, CLOUDFLARED_RELEASE } from './cloudflared-install.mjs';

const DEFAULT_TOTAL_MS = 20 * 60 * 1000; // 极端慢网络下 53MB 的兜底窗口
const DEFAULT_IDLE_MS = 90 * 1000;       // 连续 90 秒零字节视为卡死

let current = null;

function publicStatus() {
  if (!current) return { state: 'idle' };
  return {
    state: current.state,
    jobId: current.jobId,
    loaded: current.loaded,
    total: current.total,
    percent: current.percent,
    version: current.version || CLOUDFLARED_RELEASE,
    downloadUrl: current.downloadUrl,
    error: current.error,
    reused: current.reused,
    startedAt: current.startedAt,
    updatedAt: current.updatedAt,
  };
}

/** 面板轮询用：只读快照，绝不外泄 controller / result 等内部对象。 */
export function installStatus() {
  return publicStatus();
}

/**
 * 启动（或复用）安装任务。
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl]  测试注入
 * @param {function} [opts.onSuccess] 装好后回填开通器的可执行路径
 * @param {number} [opts.totalMs]     总超时
 * @param {number} [opts.idleMs]      无字节心跳超时
 */
export function startInstall({
  fetchImpl, onSuccess, destDir, platform, arch,
  totalMs = DEFAULT_TOTAL_MS, idleMs = DEFAULT_IDLE_MS,
} = {}) {
  const asset = resolveAsset({ platform, arch });
  const versionInfo = { version: CLOUDFLARED_RELEASE, downloadUrl: asset?.url || null };

  // 已装好就直接复用，不启动任何任务（幂等语义与旧同步端点一致）
  const installed = findInstalledCloudflared({ destDir, platform, arch });
  if (installed) {
    try { onSuccess?.(installed); } catch { /* 回填失败不影响「已安装」结论 */ }
    return { started: false, installed: true, reused: true, result: installed, ...versionInfo };
  }
  if (!asset) {
    const err = new Error('暂不支持自动安装：当前平台无 cloudflared 官方构建');
    err.code = 'UNSUPPORTED_PLATFORM';
    throw err;
  }
  if (current?.state === 'running') {
    return { started: true, ...publicStatus() };
  }

  const controller = new AbortController();
  const jobId = `install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  current = {
    jobId,
    state: 'running',
    loaded: 0,
    total: asset.size,
    percent: 0,
    version: CLOUDFLARED_RELEASE,
    downloadUrl: asset.url,
    error: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    controller,
    abortReason: null,
  };
  const job = current;

  // 心跳：每收到一个 chunk 就顺延；慢但不停不算超时。
  let idleTimer = null;
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      job.abortReason = 'idle';
      controller.abort(new Error('下载停滞'));
    }, idleMs);
  };
  const totalTimer = setTimeout(() => {
    job.abortReason = 'timeout';
    controller.abort(new Error('下载总时长超限'));
  }, totalMs);
  bumpIdle();

  void ensureCloudflared({
    destDir, platform, arch,
    signal: controller.signal,
    fetchImpl,
    onProgress: ({ loaded, total, percent }) => {
      job.loaded = loaded;
      job.total = total || asset.size;
      job.percent = percent ?? null;
      job.updatedAt = Date.now();
      bumpIdle();
    },
  }).then((result) => {
    job.state = 'done';
    job.percent = 100;
    job.total = result.archiveSize || job.total;
    job.updatedAt = Date.now();
    job.result = result;
    try { onSuccess?.(result); } catch { /* 同上 */ }
  }).catch((err) => {
    if (job.abortReason === 'user') {
      job.state = 'canceled';
      job.error = { code: 'DOWNLOAD_CANCELLED', message: '已取消下载' };
    } else {
      job.state = 'failed';
      const timedOut = job.abortReason === 'idle' || job.abortReason === 'timeout';
      job.error = {
        code: timedOut ? 'DOWNLOAD_TIMEOUT' : (err?.code || 'INSTALL_FAILED'),
        message: timedOut
          ? '下载超时（国内访问 GitHub 较慢）。请用浏览器打开官方地址下载，再按手动安装指引放置。'
          : (err?.message || '自动安装失败'),
      };
    }
    job.updatedAt = Date.now();
  }).finally(() => {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  });

  return { started: true, jobId, ...publicStatus() };
}

/** 取消正在进行的下载；无任务或已结束返回 canceled:false。 */
export function cancelInstall() {
  if (!current || current.state !== 'running') {
    return { canceled: false, ...publicStatus() };
  }
  current.abortReason = 'user';
  current.controller.abort(new Error('用户取消下载'));
  return { canceled: true, ...publicStatus() };
}

/** 仅供测试隔离：清空单例状态，避免用例互相污染。 */
export function resetInstallJobForTest() {
  if (current?.state === 'running') {
    try { current.controller.abort(new Error('测试结束')); } catch { /* 尽力 */ }
  }
  current = null;
}
