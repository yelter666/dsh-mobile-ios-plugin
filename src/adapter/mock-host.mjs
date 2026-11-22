// adapter/mock-host.mjs — 用契约样本驱动宿主（决策 D3：Mock 载体）
// 目的：让客户端与网关在真实宿主不可用时也能跑到端到端；它不模拟"智能"，
// 只忠实回放契约里已有的报文形状，避免 UI 在假数据上长歪。

import { fail, newId } from '../protocol.mjs';
import { createMockData } from './mock-data.mjs';

// 1×1 透明 PNG：mock 不落字节，但「读附件」这条路要让客户端真的拿到一张可解码的图，
// 否则缩略图那条链路永远验证不了。
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** 契约里的附件摘要（sha256:64hex）。mock 用确定性摘要，同一个名字得到同一个 id。 */
function mockAttachmentId(name, bytes) {
  const hex = Buffer.from(`${name}:${bytes}`).toString('hex');
  return `sha256:${(hex + '0'.repeat(64)).slice(0, 64)}`;
}

/** 网关上送的附件 → 宿主 user/message 里的 image / file 块（与真宿主同形）。 */
function attachmentBlocks(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((att) => att && typeof att === 'object')
    .map((att) => {
      const name = typeof att.name === 'string' && att.name ? att.name : 'attachment';
      const mediaType = typeof att.mediaType === 'string' ? att.mediaType : undefined;
      const b64 = typeof att.dataBase64 === 'string' ? att.dataBase64 : '';
      const bytes = b64 ? Math.round((b64.length * 3) / 4) : 0;
      return {
        type: att.kind === 'image' ? 'image' : 'file',
        attachment: {
          attachmentId: mockAttachmentId(name, bytes),
          ...(mediaType ? { mediaType } : {}),
          bytes,
          ...(att.kind === 'image' ? { width: 1120, height: 1600 } : {}),
          name,
        },
      };
    });
}

export function createMockHost({ log = () => {}, autoPlay = false, speed = 1, data = null } = {}) {
  const fixtures = data || createMockData();
  const hostInfo = fixtures.hostInfo;
  const listBody = fixtures.listBody;
  const detail = fixtures.detail;
  const createOk = fixtures.createOk;
  const messageOk = fixtures.messageOk;
  const cancelOk = fixtures.cancelOk;
  const artifacts = fixtures.artifacts;
  const todoOk = fixtures.todoOk;
  const scenario = fixtures.scenario;

  const tasks = new Map(listBody.items.map((t) => [t.taskId, { ...t }]));
  // 工作区分组：与 cordis  alike，从夹具顶层 workspaces 下发，任务行带同源 id/name。
  const workspaces = Array.isArray(listBody.workspaces) ? listBody.workspaces : [];
  // 会话动作的 mock 状态（2026-11-18）：置顶/归档集合，与桌面端 workspaceRegistry 同语义。
  // 列表快照据此带 pinned/archived 标记，长按菜单的「取消置顶/取消归档」才能被验证。
  const pinnedIds = new Set();
  const archivedIds = new Set();
  // 会话设置的 mock 状态（2026-11-17 同步面）：权限当前值 + 每任务模型选择。
  const sessionModels = new Map();
  // 权限目录与桌面端同语义的四档（2026-11-20）：只读 → 工作区 → 全权 → 自动审查。
  // 真目录来自宿主 `permissionPresets.catalog()`，里面的键与文案由电脑端配置决定；
  // mock 只是把它摆成桌面端那四档的样子，供设置面板与端到端断言有样本可看。
  const MOCK_PERMISSION_OPTIONS = [
    { value: 'readOnly', name: '仅可查看', description: '只允许读取，不改动任何文件' },
    { value: 'workspaceWrite', name: '工作区内修改', description: '只能改目标工作区，越界需批准' },
    { value: 'fullAccess', name: '完全权限', description: '整个文件系统可写，命令不受限' },
    { value: 'autoReview', name: '自动审查', description: '工具调用自动审查后放行' },
  ];
  const MOCK_MODEL_GROUPS = [
    {
      id: 'deepseek', name: 'DeepSeek',
      models: [
        // 一个声明图片、一个不声明：手机端能在选图前提示的两种分支都要有样本。
        { id: 'deepseek-chat', name: 'DeepSeek Chat', inputModalities: ['text', 'image'] },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', defaultEffort: 'medium', inputModalities: ['text'] },
      ],
    },
    {
      id: 'openai', name: 'OpenAI',
      models: [{ id: 'gpt-5.2', name: 'GPT-5.2', defaultEffort: 'high', inputModalities: ['text', 'image'] }],
    },
  ];
  const modelOf = (taskId) => sessionModels.get(taskId) ?? { provider: 'deepseek', model: 'deepseek-chat' };
  const subscribers = new Set();
  const timers = new Set();
  let playing = null;

  // 宿主历史记录（2026-11-18 补齐 mock 冷启动历史缺口）：
  // 之前 mock 没有 events 面，GET /tasks/:id/events 永远 4500，
  // 手机端冷启动时间线永远是空的——mock 截图验证不了气泡/时间戳。
  // 记录形状与宿主对齐（session-history.mjs 的翻译输入）：{type, seq, time(ms), data}。
  const history = new Map(); // taskId -> [record]
  const record = (taskId, type, data, at) => {
    const list = history.get(taskId) ?? [];
    list.push({
      type,
      seq: list.length + 1,
      time: at ? Date.parse(at) || Date.now() : Date.now(),
      data,
    });
    history.set(taskId, list);
  };

  const emit = (taskId, kind, data, at) => {
    // 同步落一份宿主形状的历史记录（只落时间线会渲染的，噪声不搬）。
    host.ingestExternal(taskId, kind, data, at);
    for (const fn of subscribers) fn({ taskId, kind, data, at });
  };

  const clearTimers = () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    playing = null;
  };

  const host = {
    kind: 'mock',
    info: () => ({ ...hostInfo, caps: [...hostInfo.caps] }),

    /**
     * 外部注入的帧（dev 端点 /__mock/emit 直发 core，绕过 host.emit）也
     * 落一份宿主形状的历史记录，保证 events() 与 WS 看到同一个世界。
     */
    ingestExternal(taskId, kind, data, at) {
      if (kind !== 'turn' || !data || typeof data !== 'object') return;
      if (data.type === 'user_message') {
        // 附件块与真宿主同形（{type:'image', attachment:{…}}）：时间线翻译层靠它
        // 把「纯图片消息」救回来，mock 若只记 text，这条路径就永远测不到。
        record(taskId, 'user/message', {
          content: [
            ...(String(data.text ?? '') ? [{ type: 'text', text: String(data.text ?? '') }] : []),
            ...attachmentBlocks(data.attachments),
          ],
          source: { kind: 'user' },
        }, at);
      } else if (data.type === 'thought_delta') {
        record(taskId, 'assistant/message', {
          turn: 1,
          message: { content: [{ type: 'reasoning', text: String(data.delta ?? '') }] },
        }, at);
      } else if (data.type === 'assistant_delta') {
        record(taskId, 'assistant/message', {
          turn: 1,
          message: { content: [{ type: 'text', text: String(data.delta ?? '') }] },
        }, at);
      } else if (data.type === 'tool_call') {
        record(taskId, 'tool/call', {
          turn: 1, callId: data.callId ?? newId('call'),
          name: data.toolName ?? 'tool', arguments: data.argSummary ?? '',
        }, at);
      } else if (data.type === 'tool_result') {
        record(taskId, 'tool/result', {
          turn: 1, toolCallId: data.callId ?? newId('call'), name: data.toolName,
          content: [{ type: 'text', text: String(data.summary ?? '') }],
        }, at);
      }
    },

    async listTasks({ status, limit = 50, includeArchived = false } = {}) {
      // 与 cordis 同口径（桌面端 tree.ts isVisible）：置顶优先；
      // 子会话 / 空占位不进任务条；归档默认隐藏，只在 includeArchived 视图出现。
      const all = [...tasks.values()]
        .map((t) => ({ ...t, pinned: pinnedIds.has(t.taskId), archived: archivedIds.has(t.taskId) }))
        .filter((t) => !status || t.status === status)
        .filter((t) => t.origin !== 'subagent' && !t.parentSessionId)
        .filter((t) => !(t.blank === true && t.status !== 'running'))
        .filter((t) => (includeArchived ? t.archived : !t.archived));
      all.sort((a, b) => (Number(b.pinned) - Number(a.pinned))
        || (Date.parse(b.lastActivityAt ?? 0) - Date.parse(a.lastActivityAt ?? 0)));
      return {
        items: all.slice(0, limit),
        workspaces,
        nextCursor: null,
        serverTime: new Date().toISOString(),
      };
    },

    async getTask(taskId) {
      const t = tasks.get(taskId);
      if (!t) throw fail(4011);
      const flags = { pinned: pinnedIds.has(taskId), archived: archivedIds.has(taskId) };
      if (taskId === detail.task.taskId) {
        return { ...detail, task: { ...detail.task, ...t, ...flags }, lastSeq: 0, serverTime: new Date().toISOString() };
      }
      return {
        task: { ...t, ...flags, lastSeq: 0 },
        budget: { limitMin: t.budgetMin ?? 10, usedSec: t.elapsedSec ?? 0, remainingSec: 600, warnAt: 480 },
        pendingTodos: [],
        artifactsPreview: [],
        tokenUsage: null,
        lastSeq: 0,
        serverTime: new Date().toISOString(),
      };
    },

    async listArtifacts(taskId) {
      if (!tasks.has(taskId)) throw fail(4011);
      return artifacts;
    },

    /** mock 侧不碰磁盘：产物内容是固定文本，够客户端验证「点开→预览」这条链路。 */
    async readArtifact(taskId, artifactId) {
      if (!tasks.has(taskId)) throw fail(4011);
      const item = (artifacts.items ?? []).find((a) => a.artifactId === artifactId);
      if (!item) throw fail(4404, '产物不存在');
      const body = `# ${item.name}\n\nmock 产物内容（${item.kind}）\n`;
      return {
        name: item.name,
        mime: 'text/markdown; charset=utf-8',
        sizeBytes: Buffer.byteLength(body),
        data: Buffer.from(body, 'utf8'),
      };
    },

    /**
     * mock 附件读取：mock 不落字节，但必须回一张能真解码的图——否则「聊天里
     * 显示的图片」这条链路在 mock 上永远验证不了。只校验 id 形状，宽松返回固定 PNG。
     */
    async readAttachment(attachmentId) {
      const id = String(attachmentId ?? '');
      if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw fail(4400, 'attachmentId 必须是 sha256:<64 位小写十六进制>');
      return { name: 'attachment-mock.png', mime: 'image/png', sizeBytes: MOCK_PNG.length, data: MOCK_PNG };
    },

    async createTask({ prompt, title, permission, budgetMin = 10, attachments, provider, model, workspaceId } = {}) {
      const taskId = newId('tsk');
      // 新建会话指定模型（2026-11-21）：与真宿主同口径，请求了就记进会话并在回执里回显。
      const modelApplied = provider && model ? true : undefined;
      // 新建会话默认权限（2026-11-20）：与真宿主同口径——未知预设不建会话，
      // 已知预设就地生效并在回执里说明。缺省按工作区内修改（workspaceWrite）。
      const preset = permission == null ? null : String(permission).trim();
      if (preset && !MOCK_PERMISSION_OPTIONS.some((o) => o.value === preset)) {
        throw fail(4400, `未知权限预设：${preset}`);
      }
      // 工作区（2026-11-22）：与真宿主同口径——会话的 cwd 必须落在该工作区目录下，
      // 否则它不会被归进这一组（真宿主 attachSession 会按 cwd 严格相等校验）。
      const wantedWs = String(workspaceId ?? '').trim();
      const ws = wantedWs ? workspaces.find((w) => String(w.workspaceId ?? w.id) === wantedWs) : null;
      if (wantedWs && !ws) throw fail(4400, '选中的工作区已不在电脑端 — 刷新任务列表后重新选。', { detail: `workspace=${wantedWs}` });
      const cwd = ws ? String(ws.path ?? `/mock/${ws.name ?? 'workspace'}`) : '/mock/workspace';
      tasks.set(taskId, {
        taskId,
        storedKey: newId('sk'),
        title: title || String(prompt).slice(0, 24),
        status: 'running',
        phase: { index: 1, total: 5, label: '已接收' },
        elapsedSec: 0,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        hostId: hostInfo.hostId,
        hostName: hostInfo.hostName,
        cwd,
        workspaceId: ws ? String(ws.workspaceId ?? ws.id) : null,
        workspaceName: ws ? String(ws.name ?? ws.title ?? '') : null,
        permission: preset ?? 'workspaceWrite',
        budgetMin,
        needsYou: false,
        pendingTodoCount: 0,
        artifactsCount: 0,
      });
      if (ws) {
        // 会话归属：真宿主是 workspace.sessionIds（有序数组），mock 就地补进去，
        // 让列表快照能看出「新建的会话进了选中分组」。
        if (!Array.isArray(ws.sessionIds)) ws.sessionIds = [];
        ws.sessionIds.unshift(taskId);
      }
      emit(taskId, 'state', { status: 'running', phase: { index: 1, total: 5, label: '已接收' }, elapsedSec: 0, needsYou: false });
      // 首条提示也要进历史：真宿主会把 user/message 写进会话事件；mock 不落的话
      // 「新建会话打开后看不到自己刚写的那句」，看起来像消息丢了。
      emit(taskId, 'turn', {
        turnId: newId('turn'),
        type: 'user_message',
        text: String(prompt ?? ''),
        ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
      });
      log(`host  createTask ${taskId}`);
      return { ...createOk, taskId, storedKey: tasks.get(taskId).storedKey, acceptedAt: new Date().toISOString(),
        // 与真宿主同形：请求了权限 / 模型才带这些字段。
        permissionApplied: preset ? true : undefined, modelApplied };
    },

    async appendMessage(taskId, { text, attachments } = {}) {
      if (!tasks.has(taskId)) throw fail(4011);
      const turnId = newId('turn');
      // 纯附件消息 text 可空；mock 只记元数据（不落字节），供端到端断言送达。
      const atts = Array.isArray(attachments) ? attachments : [];
      // 先把「用户说了什么」写进历史（含附件块），再回一句助手话术。
      // 顺序不能反：事件是时间线的事实，助手回复只是 mock 的回执。
      emit(taskId, 'turn', {
        turnId,
        type: 'user_message',
        text: String(text ?? ''),
        ...(atts.length ? { attachments: atts } : {}),
      });
      const names = atts.map((a) => a?.name || a?.kind || 'attachment').join('、');
      const delta = text
        ? `收到：${String(text).slice(0, 40)}`
        : `收到附件：${names || '附件'}`;
      emit(taskId, 'turn', { turnId, type: 'assistant_delta', delta });
      return { ...messageOk, taskId, turnId, acceptedAt: new Date().toISOString() };
    },

    /**
     * 冷启动历史（FR-CHAT-01）：从 emit 落下的宿主形状记录里翻页。
     * 记录按 seq 升序返回；beforeSeq 取更早的一页（seq < beforeSeq）。
     * mock 数据量小，一页装得下，hasMore 恒 false。
     */
    async events(taskId, { beforeSeq, limit = 60 } = {}) {
      if (!tasks.has(taskId)) throw fail(4011);
      const all = history.get(taskId) ?? [];
      const filtered = Number.isFinite(beforeSeq) && beforeSeq > 0
        ? all.filter((r) => r.seq < beforeSeq)
        : all;
      const records = filtered.slice(-Math.min(Math.max(limit, 1), 200));
      return { taskId, records, hasMore: false };
    },

    async cancelTask(taskId) {
      const t = tasks.get(taskId);
      if (!t) throw fail(4011);
      t.status = 'cancelled';
      emit(taskId, 'state', { status: 'cancelled', phase: { index: 5, total: 5, label: '已停止' }, elapsedSec: t.elapsedSec ?? 0, needsYou: false });
      log(`host  cancelTask ${taskId}`);
      return { ...cancelOk, taskId, at: new Date().toISOString() };
    },

  async answerTodo(taskId, todoId, { decision }) {
    if (!tasks.has(taskId)) throw fail(4011);
    emit(taskId, 'todo', { todoId, state: 'resolved', decision, resolvedAt: new Date().toISOString() });
    return { ...todoOk, taskId, todoId, decision, resolvedAt: new Date().toISOString() };
  },

  // MARK: 会话动作（与桌面端右键菜单同源；mock 用内存集合模拟 workspaceRegistry）

  // MARK: 提示词增强（mock 无模型，返回可预期的结构化文本供端到端断言）

  async enhancePrompt({ text } = {}) {
    const source = String(text ?? '').trim();
    if (!source) throw fail(4400, '待增强的提示词不能为空');
    return {
      text: `目标：\n${source}\n\n要求：\n1. 先给结论，再给依据。\n2. 保留原文给出的数值、路径与名称。\n3. 输出可直接执行的结果，不要额外解释。`,
      provider: 'mock',
      model: 'mock-enhance',
      finishReason: 'stop',
      at: new Date().toISOString(),
    };
  },

  // 工作区写动作（与桌面端分组右键菜单同源）：mock 用内存 workspaces 数组模拟
  // workspaceRegistry，删分组只移除注册、任务行的 workspaceId/Name 清空（落到未分组），
  // 与桌面端 delete.desc「文件与会话保留，会话显示在未分组下」一致。
  async renameWorkspace(workspaceId, { title } = {}) {
    const id = String(workspaceId ?? '').trim();
    const name = String(title ?? '').trim();
    if (!id) throw fail(4400, 'workspaceId 不能为空');
    if (!name) throw fail(4400, '工作区名称不能为空');
    const ws = workspaces.find((w) => String(w.workspaceId ?? w.id) === id);
    if (!ws) throw fail(4011, '工作区不存在', { detail: 'workspace/not-found' });
    // fixture 下发的工作区字段是 {id,name}；真实宿主是 {workspaceId,title}。两种都改，
    // 列表快照原样下发 workspaces，改错字段会出现「回执说成功、列表名没变」。
    ws.name = name;
    ws.title = name;
    for (const t of tasks.values()) {
      if (String(t.workspaceId ?? '') === id) t.workspaceName = name;
    }
    log(`host  rename workspace ${id} → ${name}`);
    return { applied: true, workspaceId: id, title: name, at: new Date().toISOString() };
  },

  async deleteWorkspace(workspaceId) {
    const id = String(workspaceId ?? '').trim();
    if (!id) throw fail(4400, 'workspaceId 不能为空');
    const idx = workspaces.findIndex((w) => String(w.workspaceId ?? w.id) === id);
    if (idx < 0) throw fail(4011, '工作区不存在', { detail: 'workspace/not-found' });
    workspaces.splice(idx, 1);
    for (const t of tasks.values()) {
      if (String(t.workspaceId ?? '') === id) {
        t.workspaceId = null;
        t.workspaceName = null;
      }
    }
    log(`host  delete workspace ${id}（会话落到未分组，文件保留）`);
    return { applied: true, workspaceId: id, deleted: true, at: new Date().toISOString() };
  },

  // 新建工作区（2026-11-22，与真宿主 workspaceController.create 同口径）：
  // 同一目录重复注册拿回原分组（幂等），不会建出两个同名分组。
  async createWorkspace({ path, title } = {}) {
    const dir = String(path ?? '').trim();
    if (!dir) throw fail(4400, '目录路径不能为空');
    if (!dir.startsWith('/')) throw fail(4400, '目录路径必须是绝对路径，例如 /Users/你/Documents/项目');
    const existing = workspaces.find((w) => String(w.path ?? '') === dir);
    if (existing) {
      return {
        applied: true, workspaceId: String(existing.workspaceId ?? existing.id),
        title: String(existing.name ?? existing.title ?? ''), path: dir,
        created: false, at: new Date().toISOString(),
      };
    }
    const id = newId('ws');
    const name = String(title ?? '').trim() || dir.split('/').filter(Boolean).pop() || dir;
    workspaces.push({ id, name, path: dir, sessionIds: [] });
    log(`host  create workspace ${id} path=${dir}`);
    return { applied: true, workspaceId: id, title: name, path: dir, created: true, at: new Date().toISOString() };
  },

  async pinTask(taskId, { pinned = true } = {}) {
    if (!tasks.has(taskId)) throw fail(4011);
    if (pinned) pinnedIds.add(taskId); else pinnedIds.delete(taskId);
    log(`host  ${pinned ? 'pin' : 'unpin'} ${taskId}`);
    return {
      applied: true, taskId, pinned,
      pinnedSessionIds: [...pinnedIds], at: new Date().toISOString(),
    };
  },

  async archiveTask(taskId, { archived = true, stopActivity = false } = {}) {
    const t = tasks.get(taskId);
    if (!t) throw fail(4011);
    if (archived) {
      // 与宿主一致：运行中会话不带 stopActivity 会拒绝（workspace/session-active → 我们用 4007 表达"忙"）。
      if ((t.status === 'running' || t.status === 'pending') && stopActivity !== true) {
        throw fail(4007, '会话正在运行，归档前需先停止', { detail: 'workspace/session-active' });
      }
      if (stopActivity === true && (t.status === 'running' || t.status === 'pending')) {
        t.status = 'cancelled';
      }
      archivedIds.add(taskId);
      pinnedIds.delete(taskId); // 宿主归档时同时取消置顶（client/model.ts installArchived 实证）
    } else {
      archivedIds.delete(taskId);
    }
    log(`host  ${archived ? 'archive' : 'unarchive'} ${taskId}`);
    return {
      applied: true, taskId, archived,
      archivedSessionIds: [...archivedIds], at: new Date().toISOString(),
    };
  },

  async renameTask(taskId, { title } = {}) {
    const t = tasks.get(taskId);
    if (!t) throw fail(4011);
    const name = String(title ?? '').trim();
    if (!name) throw fail(4400, '标题不能为空');
    t.title = name;
    t.lastActivityAt = new Date().toISOString();
    log(`host  rename ${taskId} → ${name}`);
    return { applied: true, taskId, title: name, seq: (t.lastSeq ?? 0) + 1, at: new Date().toISOString() };
  },

  async forkTask(taskId) {
    const t = tasks.get(taskId);
    if (!t) throw fail(4011);
    const forkedTaskId = newId('tsk');
    tasks.set(forkedTaskId, {
      ...t, taskId: forkedTaskId, storedKey: newId('sk'),
      title: `${t.title}（分叉）`,
      status: 'idle', phase: null, startedAt: null, lastActivityAt: new Date().toISOString(),
      needsYou: false, pendingTodoCount: 0,
    });
    log(`host  fork ${taskId} → ${forkedTaskId}`);
    return { accepted: true, taskId, forkedTaskId, at: new Date().toISOString() };
  },

  // MARK: 会话设置同步（与 cordis 适配器同形状；mock 恒 supported，供端到端与回归断言）

  /**
   * App 级设置目录（2026-11-20）：进程级权限目录 + 模型目录，不含会话级当前值。
   * mock 恒 supported，端到端才能验「设置面板在没会话时也有目录」。
   */
  async appSettings() {
    return {
      permission: { supported: true, options: MOCK_PERMISSION_OPTIONS },
      model: {
        supported: true,
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        groups: MOCK_MODEL_GROUPS,
        failures: [],
      },
      serverTime: new Date().toISOString(),
    };
  },

  async sessionSettings(taskId) {
    if (!tasks.has(taskId)) throw fail(4011);
    const selection = modelOf(taskId);
    return {
      taskId,
      permission: {
        supported: true,
        currentValue: tasks.get(taskId).permission ?? 'workspaceWrite',
        options: MOCK_PERMISSION_OPTIONS,
      },
      model: {
        supported: true,
        current: selection,
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        groups: MOCK_MODEL_GROUPS,
        failures: [],
      },
      serverTime: new Date().toISOString(),
    };
  },

  async setPermission(taskId, { preset } = {}) {
    if (!tasks.has(taskId)) throw fail(4011);
    const value = String(preset ?? '').trim();
    if (!value) throw fail(4400, 'preset 不能为空');
    if (!MOCK_PERMISSION_OPTIONS.some((o) => o.value === value)) {
      throw fail(4400, `未知权限预设：${value}`);
    }
    tasks.get(taskId).permission = value;
    log(`host  setPermission ${taskId} → ${value}`);
    return { applied: true, taskId, value, at: new Date().toISOString() };
  },

  async selectModel(taskId, { provider, model, reasoningEffort } = {}) {
    if (!tasks.has(taskId)) throw fail(4011);
    const providerId = String(provider ?? '').trim();
    const modelId = String(model ?? '').trim();
    if (!providerId || !modelId) throw fail(4400, 'provider 与 model 不能为空');
    const group = MOCK_MODEL_GROUPS.find((g) => g.id === providerId);
    if (!group || !group.models.some((m) => m.id === modelId)) {
      throw fail(4400, `目录中没有 ${providerId}/${modelId}`);
    }
    const selection = { provider: providerId, model: modelId };
    if (reasoningEffort) selection.reasoningEffort = String(reasoningEffort);
    sessionModels.set(taskId, selection);
    log(`host  selectModel ${taskId} → ${providerId}/${modelId}`);
    return { applied: true, taskId, selection, at: new Date().toISOString() };
  },

    /**
     * 宿主重启钩子（由 GatewayCore.restartHost 调用）。
     *
     * 真实宿主重启后，在跑的任务不会复活，宿主会把它们标成中断。
     * mock 若不建模这一步，列表快照仍报 running，客户端「已中断 · 可续」的降级
     * 会被列表覆盖回「运行中」——端到端就验不出 FR-TASK-06。
     */
    onHostRestart(reason = 'host_restart') {
      let affected = 0;
      for (const t of tasks.values()) {
        if (t.status !== 'running' && t.status !== 'pending') continue;
        t.status = 'interrupted';
        t.needsYou = false;
        t.pendingTodoCount = 0;
        t.lastActivityAt = new Date().toISOString();
        affected += 1;
        // 刻意**不**发事件：调用方紧接着清空环缓冲并断开连接，谁也收不到；
        // 发了只会让「重启那一瞬间」的时序变得不可预测。
        // 状态由随后的列表快照体现——真实宿主也是这样。
      }
      log(`host  onHostRestart(${reason}) 降级 ${affected} 个运行中任务`);
      return affected;
    },

    async diag() {
      return { adapter: 'mock', data: 'builtin', tasks: tasks.size };
    },

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    /** 回放契约里的 10 帧事件流（间隔按 speed 缩放），用于验收"实时"而不只是"首屏" */
    playScenario(taskId = fixtures.RUNNING_TASK, { speed: s = speed } = {}) {
      clearTimers();
      playing = taskId;
      let acc = 0;
      for (const item of scenario.frames || []) {
        acc += (item.delayMs || 60) / s;
        const t = setTimeout(() => {
          timers.delete(t);
          emit(taskId, item.frame.kind, item.frame.data, new Date().toISOString());
        }, acc);
        timers.add(t);
      }
      const done = setTimeout(() => timers.delete(done), acc + 50);
      timers.add(done);
      log(`host  playScenario ${taskId} frames=${(scenario.frames || []).length}`);
      return { playing, frames: (scenario.frames || []).length };
    },

    stopScenario: clearTimers,
    isPlaying: () => playing,

    async close() {
      clearTimers();
      subscribers.clear();
    },
  };

  if (autoPlay) setTimeout(() => host.playScenario(), 50).unref?.();
  return host;
}
