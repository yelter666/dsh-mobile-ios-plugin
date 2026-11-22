// cloudflared-install.mjs — cloudflared 自举安装（每机首次开启远程时按需下载）
//
// 设计原则：
// 1. **只在用户确认后下载**：调用方（桌面面板）必须先弹窗得到同意，本模块不静默下载执行。
// 2. **只用官方源、只落私有目录**：从 Cloudflare 官方 GitHub Release 下载，写到
//    ~/.dsh/mobile-access/components/cloudflared/<version>/，不改系统 PATH、不装到 Program Files。
// 3. **如实校验**：GitHub Release 不提供 checksum 文件，故校验 HTTPS + HTTP 200 + 官方字节数
//    + 落盘后按平台嗅探可执行文件魔数（PE / Mach-O / ELF）。任何一步不过就删临时文件并报错，
//    绝不把残缺或错平台的文件交给启动器。
// 4. **幂等**：目标已存在且大小吻合直接返回，不重复下载。

import { closeSync, mkdirSync, openSync, readSync, writeFileSync, existsSync, statSync, unlinkSync, chmodSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractTgzEntry } from './tar.mjs';

export { extractTgzEntry as extractTarGz } from './tar.mjs';

export const CLOUDFLARED_RELEASE = '2026.11.1';
const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_RELEASE}`;

// 官方 Release 资产与预期字节数（2026-11-20 实测 api.github.com 的 size 字段）。
// 只列出我们支持的平台；未知平台由调用方降级为「手动安装」，不猜测下载地址。
//
// macOS 只提供 .tgz（内含 cloudflared），Linux/Windows 是裸二进制 —— 这条差别曾经被忽略：
// 早先的实现把 .tgz 整个写成了目标文件，装完 chmod 也「成功」，但一执行就报格式错误。
// archive 字段就是为这条差别显式建模的。
const ASSETS = {
  win32: {
    x64: { file: 'cloudflared-windows-amd64.exe', size: 55483112, bin: 'cloudflared.exe', archive: null, magic: 'pe' },
    ia32: { file: 'cloudflared-windows-386.exe', size: 38157960, bin: 'cloudflared.exe', archive: null, magic: 'pe' },
  },
  darwin: {
    x64: { file: 'cloudflared-darwin-amd64.tgz', size: 21857340, bin: 'cloudflared', archive: 'tgz', magic: 'macho' },
    arm64: { file: 'cloudflared-darwin-arm64.tgz', size: 19898712, bin: 'cloudflared', archive: 'tgz', magic: 'macho' },
  },
  linux: {
    x64: { file: 'cloudflared-linux-amd64', size: 40346301, bin: 'cloudflared', archive: null, magic: 'elf' },
    arm64: { file: 'cloudflared-linux-arm64', size: 37818397, bin: 'cloudflared', archive: null, magic: 'elf' },
  },
};

/** 解析当前平台对应的资产。未知平台/架构返回 null（调用方降级为手动安装）。 */
export function resolveAsset({ platform = process.platform, arch = process.arch } = {}) {
  const byArch = ASSETS[platform];
  if (!byArch) return null;
  const asset = byArch[arch];
  if (!asset) return null;
  return { ...asset, url: `${RELEASE_BASE}/${asset.file}` };
}

/** home 解析：与 tunnel.mjs 的 findCloudflared 保持一致（USERPROFILE/HOME 优先）。 */
export function resolveHome(env = process.env) {
  return env.USERPROFILE || env.HOME || os.homedir();
}

/** 组件目录：与 tunnel.mjs 的 findCloudflared 保持同一路径约定。 */
export function componentBinDir({ home, version = CLOUDFLARED_RELEASE, env = process.env } = {}) {
  const base = home || resolveHome(env);
  return path.join(base, '.dsh', 'mobile-access', 'components', 'cloudflared', version);
}

/** 只读前 8 字节判魔数：别为了嗅探把 50MB 的二进制整个读进内存。 */
function readHead(file, bytes = 8) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * 可执行文件魔数嗅探。
 *
 * 为什么值得做：字节数与 HTTP 200 都只能证明「下载完整」，证明不了「这是本平台的可执行文件」。
 * macOS 的 .tgz 事故（把压缩包当二进制写盘）就是靠这条能立刻拦住。
 */
export function sniffBinary(buf, platform = process.platform) {
  if (!buf || buf.length < 4) return 'unknown';
  const want = platform === 'win32' ? 'pe' : platform === 'darwin' ? 'macho' : 'elf';
  const unix =
    buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46 ? 'elf'
      : buf[0] === 0x4d && buf[1] === 0x5a ? 'pe'
        : [0xfeedfacf, 0xfeedface, 0xcafebabe, 0xcefaedfe, 0xcffaedfe].includes(buf.readUInt32BE(0)) ? 'macho'
          : 'unknown';
  return unix === want ? want : unix;
}

/**
 * 只查不装：组件目录里是否已有**可用**的二进制。
 *
 * 抽出来给安装任务启动时判断「无需下载」用——以前这段逻辑埋在 ensureCloudflared 内部，
 * 端点要么同步跑完整下载才能知道，要么另写一套判定，两边一旦漂移就会出现
 * 「面板说没装、网关却在复用」的鬼故事。
 */
export function findInstalledCloudflared({
  version = CLOUDFLARED_RELEASE,
  destDir,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const asset = resolveAsset({ platform, arch });
  if (!asset) return null;
  const dir = destDir || componentBinDir({ version });
  const target = path.join(dir, asset.bin);
  if (!existsSync(target)) return null;

  // 大小吻合 + 魔数正确才复用（只看大小会把「上次写坏的 .tgz」当成装好了）
  const actual = statSync(target).size;
  if (asset.size > 0 && actual !== asset.size) return null;
  try {
    if (sniffBinary(readHead(target), platform) === 'unknown') return null;
  } catch {
    return null;
  }
  return { installed: true, executable: target, version, reused: true, size: actual };
}

/**
 * 确保 cloudflared 二进制存在于组件目录。返回 { installed, executable, version, reused }。
 * fetchImpl 注入便于测试；默认用全局 fetch。
 * onProgress({ loaded, total, percent }) 按 chunk 回传**真实下载字节数**，
 * 让面板能显示进度而不是「已等待 N 秒」的假进度。
 */
export async function ensureCloudflared({
  version = CLOUDFLARED_RELEASE,
  destDir,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  signal,
  onProgress,
} = {}) {
  const asset = resolveAsset({ platform, arch });
  if (!asset) {
    const err = new Error(`暂不支持自动安装：${platform}/${arch} 无官方构建`);
    err.code = 'UNSUPPORTED_PLATFORM';
    throw err;
  }
  const dir = destDir || componentBinDir({ version });
  const target = path.join(dir, asset.bin);
  const expected = asset.size;

  // 残缺或格式不对：删掉重下（旧版把 .tgz 当二进制写坏的机器靠这一步自愈）
  if (findInstalledCloudflared({ version, destDir: dir, platform, arch })) {
    return { installed: true, executable: target, version, reused: true, size: statSync(target).size };
  }
  try { unlinkSync(target); } catch { /* 落到下面覆盖写 */ }

  if (typeof fetchImpl !== 'function') {
    const err = new Error('当前运行时不支持下载，请手动安装 cloudflared');
    err.code = 'NO_FETCH';
    throw err;
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = `${target}.partial`;
  let res;
  try {
    res = await fetchImpl(asset.url, { signal });
  } catch (err) {
    const aborted = signal?.aborted || err?.name === 'AbortError';
    const e = new Error(aborted
      ? '下载 cloudflared 已取消'
      : `下载 cloudflared 失败：${err?.message || err}`);
    e.code = aborted ? 'DOWNLOAD_CANCELLED' : 'DOWNLOAD_FAILED';
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`下载 cloudflared 失败：HTTP ${res.status}`);
    e.code = 'DOWNLOAD_FAILED';
    throw e;
  }

  let raw;
  try {
    // 流式读取：53MB 的 Windows 包在慢网络下要十几分钟，arrayBuffer() 全程静默，
    // 用户看到的就是「点了没反应」。按 chunk 累计并回传真实字节数，面板才有进度可显示。
    if (typeof res.body?.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      const headerTotal = Number(res.headers?.get?.('content-length'));
      const total = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : expected;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        loaded += chunk.length;
        onProgress?.({ loaded, total, percent: total > 0 ? Math.min(100, Math.round(loaded * 100 / total)) : null });
      }
      raw = Buffer.concat(chunks);
    } else {
      // 注入式 mock fetch（测试）与非标准运行时可能没有 stream：保留原路径。
      raw = Buffer.from(await res.arrayBuffer());
      onProgress?.({ loaded: raw.length, total: expected, percent: 100 });
    }
  } catch (err) {
    const aborted = signal?.aborted || err?.name === 'AbortError';
    const e = new Error(aborted
      ? '下载 cloudflared 已取消'
      : `读取 cloudflared 内容失败：${err?.message || err}`);
    e.code = aborted ? 'DOWNLOAD_CANCELLED' : 'DOWNLOAD_FAILED';
    throw e;
  }
  if (raw.length === 0 || (expected > 0 && raw.length !== expected)) {
    const e = new Error(`cloudflared 大小校验失败：期望 ${expected}，实际 ${raw.length}`);
    e.code = 'SIZE_MISMATCH';
    throw e;
  }

  let bin = raw;
  if (asset.archive === 'tgz') bin = extractTgzEntry(raw, asset.bin);
  if (sniffBinary(bin, platform) !== asset.magic) {
    const e = new Error(`cloudflared 二进制格式不符（期望 ${asset.magic}）`);
    e.code = 'BAD_BINARY';
    throw e;
  }

  try {
    writeFileSync(partial, bin, { mode: 0o700 });
    renameSync(partial, target);
    // Windows 的 chmod 只认读写位；POSIX 补执行位
    try { chmodSync(target, 0o755); } catch { /* Windows 忽略 */ }
  } catch (err) {
    try { if (existsSync(partial)) unlinkSync(partial); } catch { /* 尽力清理 */ }
    const e = new Error(`写入 cloudflared 失败：${err?.message || err}`);
    e.code = 'WRITE_FAILED';
    throw e;
  }

  return {
    installed: true,
    executable: target,
    version,
    reused: false,
    size: bin.length,
    archiveSize: raw.length,
  };
}
