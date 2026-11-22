// artifacts.mjs — 从会话事件里「如实」还原产物清单
//
// 为什么是推导而不是查询：宿主没有「会话产物」这条端点（`workspace/*` 是另一套
// 语义，不是会话的产出）。而会话事件里**已经有事实**：写文件的工具调用带完整
// 路径。把工具调用里的路径取出来，再去磁盘核对一遍，得到的就是「这个任务真的
// 落下了哪些文件」——不是猜的，也不是把工具名当产物。
//
// 三条不变量：
//   1. **只认写类工具**：Read/Glob/Grep 也带路径，但那是输入，不是产出。
//   2. **必须落在工作目录内**：事件里的路径可能指向系统文件，手机端不该能看到。
//   3. **文件必须真的存在**：任务被回滚 / 文件被删掉之后，清单要跟着消失，
//      不能给用户点开一个 404。

import { statSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_ARTIFACTS = 40;
const MAX_BYTES = 25 * 1024 * 1024;

/** 写类工具名。命中即认为它写出来的路径值得进产物清单。 */
const WRITE_TOOL = /(write|edit|create|save|patch|apply|replace|insert|rename|move|append|mkdir|touch|present)/i;

/**
 * 真实宿主的工具调用长这样：`name=run_code`、`arguments={code:"await tools.write({file_path:\"a.md\"})"}`。
 * 也就是说「哪个工具在写」和「写到哪里」都埋在代码字符串里，靠参数键根本取不到。
 * 所以对这种调用，在代码文本里逐段找 `tools.<name>(` ，只有写类名字的那一段才收路径。
 */
const CODE_TOOL_CALL = /tools\.([a-zA-Z_]+)\s*\(/g;

/** 代码里的路径键：`file_path: "x"`、`path: 'x'`、`{ "path": \`x\` }` 都算。 */
const PATH_IN_CODE =
  /(?:file_path|filePath|filepath|target_file|"path"|'path'|path)\s*:\s*(?:"([^"\n]{1,400})"|'([^'\n]{1,400})'|`([^`\n]{1,400})`)/g;

function collectPathsFromCode(code, out) {
  const text = String(code ?? '');
  if (!text) return;
  const marks = [];
  CODE_TOOL_CALL.lastIndex = 0;
  for (let m = CODE_TOOL_CALL.exec(text); m; m = CODE_TOOL_CALL.exec(text)) {
    marks.push({ name: m[1], start: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const { name, bodyStart } = marks[i];
    if (!WRITE_TOOL.test(name)) continue;
    // 一段调用最多看到下一次 tools.* 调用为止，避免把后面的读路径算进来
    const end = i + 1 < marks.length ? marks[i + 1].start : Math.min(text.length, bodyStart + 4000);
    const segment = text.slice(bodyStart, end);
    PATH_IN_CODE.lastIndex = 0;
    for (let p = PATH_IN_CODE.exec(segment); p; p = PATH_IN_CODE.exec(segment)) {
      const candidate = (p[1] ?? p[2] ?? p[3] ?? '').trim();
      if (candidate) out.push(candidate);
    }
  }
}

/** 常见工具把路径放在这些键里；键名大小写/下划线各不相同，一律归一后比较。 */
const PATH_KEYS = new Set([
  'filepath', 'path', 'targetfile', 'filename', 'file', 'notebookpath',
  'outputpath', 'destination', 'dest', 'to',
]);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.svg']);
const LOG_EXT = new Set(['.log', '.txt']);
const DIFF_EXT = new Set(['.diff', '.patch']);

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown',
  '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.ts': 'text/plain; charset=utf-8',
  '.swift': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.zip': 'application/zip',
};

const normalizeKey = (k) => String(k).toLowerCase().replace(/[_-]/g, '');

function collectPaths(value, out, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    for (const v of value) collectPaths(v, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string' && PATH_KEYS.has(normalizeKey(key)) && v.trim()) {
      out.push(v.trim());
    } else if (typeof v === 'object') {
      collectPaths(v, out, depth + 1);
    }
  }
}

function parseArguments(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

/** 绝对化 + 收进工作目录内；越界返回 null。 */
function resolveInside(cwd, candidate) {
  const resolved = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(cwd, candidate);
  const root = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  return resolved.startsWith(root) ? resolved : null;
}

export function kindOf(ext) {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (DIFF_EXT.has(ext)) return 'diff';
  if (LOG_EXT.has(ext)) return 'log';
  return 'file';
}

export function mimeOf(name) {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 按文件头认类型。
 *
 * 宿主附件对象库里文件名是纯 sha256（没有扩展名），`mimeOf` 认不出来；
 * 而浏览器 / QuickLook 要的是真 MIME 才会内联显示图片。这里只认几种确定
 * 的魔数，其余如实回 octet-stream——不猜。
 */
export function sniffMime(bytes) {
  const b = bytes;
  if (!b || typeof b.length !== 'number' || b.length < 4) return 'application/octet-stream';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return 'application/octet-stream';
}

/** `artifactId` = 相对工作目录的路径（base64url）。不带主机路径，不泄露目录结构。 */
export function encodeArtifactId(cwd, absolutePath) {
  const rel = path.relative(cwd, absolutePath).split(path.sep).join('/');
  return Buffer.from(rel, 'utf8').toString('base64url');
}

export function decodeArtifactId(cwd, artifactId) {
  let rel;
  try {
    rel = Buffer.from(String(artifactId), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!rel || rel.includes('\0')) return null;
  const resolved = resolveInside(cwd, rel);
  if (!resolved) return null;
  try {
    // 符号链接可以指向工作目录之外，必须按真实路径再判一次
    const real = realpathSync(resolved);
    const realRoot = realpathSync(cwd);
    const inside = real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
    return inside && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * 从会话事件还原产物清单。
 *
 * @param {Array} records 宿主事件记录（可能带 {event} 包层）
 * @param {{cwd?: string|null, now?: number}} options
 * @returns {{items: Array<{artifactId,name,kind,sizeBytes,mime,updatedAt}>, skipped: Record<string, number>}}
 */
export function deriveArtifacts(records = [], { cwd = null } = {}) {
  const skipped = Object.create(null);
  if (!cwd) return { items: [], skipped: { 'no-cwd': 1 } };

  const seen = new Map(); // 绝对路径 → { at, tool }
  for (const raw of records) {
    const e = raw && typeof raw === 'object' && raw.event ? raw.event : raw;
    if (!e || e.type !== 'tool/call') continue;
    const d = e.data ?? {};
    const tool = String(d.name ?? '');
    const args = parseArguments(d.arguments);
    if (!args) {
      skipped['unparsable-arguments'] = (skipped['unparsable-arguments'] ?? 0) + 1;
      continue;
    }
    const candidates = [];
    if (WRITE_TOOL.test(tool)) {
      // 结构化的写工具：路径就在参数键上（Write/Edit/present…）
      collectPaths(args, candidates);
    } else {
      // 代码型工具（真实宿主的 run_code）：写动作埋在 code 里。
      // 只扫「代码类」字段——绝不能扫 Write 的 content，那里面的示例路径
      // 只要恰好存在，就会被当成产物列出来。
      for (const key of ['code', 'script', 'command', 'input']) {
        if (typeof args[key] === 'string') collectPathsFromCode(args[key], candidates);
      }
    }
    if (!candidates.length) {
      if (WRITE_TOOL.test(tool)) skipped['no-path'] = (skipped['no-path'] ?? 0) + 1;
      continue;
    }
    for (const candidate of candidates) {
      const resolved = resolveInside(cwd, candidate);
      if (!resolved) {
        skipped['outside-cwd'] = (skipped['outside-cwd'] ?? 0) + 1;
        continue;
      }
      let info;
      try {
        info = statSync(resolved);
      } catch {
        skipped['missing'] = (skipped['missing'] ?? 0) + 1;
        continue;
      }
      if (!info.isFile()) continue;
      if (info.size > MAX_BYTES) {
        skipped['too-large'] = (skipped['too-large'] ?? 0) + 1;
        continue;
      }
      const at = typeof e.time === 'number' ? e.time : 0;
      const previous = seen.get(resolved);
      // 同一文件被多次改写：以最后一次写入为准（产物清单是「最终结果」）
      if (!previous || at >= previous.at) seen.set(resolved, { at, tool, size: info.size });
    }
  }

  const items = [...seen.entries()]
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_ARTIFACTS)
    .map(([absolute, meta]) => {
      const name = path.basename(absolute);
      return {
        artifactId: encodeArtifactId(cwd, absolute),
        name,
        kind: kindOf(path.extname(name).toLowerCase()),
        sizeBytes: meta.size,
        mime: mimeOf(name),
        updatedAt: meta.at ? new Date(meta.at).toISOString() : undefined,
        tool: meta.tool,
      };
    });

  return { items, skipped };
}
