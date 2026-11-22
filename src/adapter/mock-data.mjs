// adapter/mock-data.mjs — 契约回放用的内置样本数据
//
// 历史包袱：mock 宿主原来从仓库 `spec/fixtures/**` 读 9 个 JSON，而这份夹具从未随
// 插件分包一起提交（路径还多上了一级），于是 mock 一创建就 ENOENT ——
// `npm start`、sidecar 开发模式、以及 9 个测试套件全部连带崩掉。
// 样本数据本来就只为「形状正确」服务，放在代码里比放在一个易丢的目录更可靠：
//   · 装到哪台机器都能跑（不依赖相对路径，Windows/macOS 一致）
//   · 时间戳按创建时刻生成，截图里不会出现「三天前」的假数据
//
// 这里只塑造宿主真实会返回的形状，不模拟「智能」。

const RUNNING_TASK = 'tsk_a41f9c';
const IDLE_TASK = 'tsk_b7c21e';

export function createMockData({ now = Date.now() } = {}) {
  const at = (offsetSec = 0) => new Date(now - offsetSec * 1000).toISOString();

  const hostInfo = {
    hostId: 'host_mock',
    hostName: 'DSH 桌面端（mock）',
    hostVersion: '0.2.14-mock',
    platform: process.platform,
    protocolVersion: '1.0',
    caps: ['tasks.read', 'tasks.write', 'tasks.cancel', 'artifacts.read', 'tasks.settings', 'tasks.sessionActions', 'prompt.enhance'],
  };

  const workspaces = [{ id: 'ws_mock', name: 'mock 工作区' }];

  const taskList = [
    {
      taskId: RUNNING_TASK,
      storedKey: 'sk_mock_a41f9c',
      title: '把隧道重连逻辑抽成独立模块',
      status: 'running',
      phase: { index: 2, total: 5, label: '正在改代码' },
      elapsedSec: 132,
      startedAt: at(132),
      lastActivityAt: at(3),
      hostId: hostInfo.hostId,
      hostName: hostInfo.hostName,
      cwd: '/mock/workspace',
      permission: 'requireApproval',
      budgetMin: 10,
      needsYou: false,
      // 与下面 detail.pendingTodos 的条数一致（2 条待办）。
      pendingTodoCount: 2,
      artifactsCount: 2,
      workspaceId: 'ws_mock',
      workspaceName: 'mock 工作区',
      origin: 'user',
    },
    {
      taskId: IDLE_TASK,
      storedKey: 'sk_mock_b7c21e',
      title: '整理 iOS 配对页文案',
      status: 'completed',
      phase: null,
      elapsedSec: 96,
      startedAt: at(3600),
      lastActivityAt: at(1800),
      hostId: hostInfo.hostId,
      hostName: hostInfo.hostName,
      cwd: '/mock/workspace',
      permission: 'autoApprove',
      budgetMin: 15,
      needsYou: false,
      pendingTodoCount: 0,
      artifactsCount: 0,
      workspaceId: 'ws_mock',
      workspaceName: 'mock 工作区',
      origin: 'user',
    },
  ];

  const artifacts = {
    items: [
      {
        artifactId: 'art_notes',
        name: 'tunnel-notes.md',
        kind: 'file',
        mime: 'text/markdown',
        sizeBytes: 2048,
        updatedAt: at(120),
      },
      {
        artifactId: 'art_qr',
        name: 'qr-preview.png',
        kind: 'image',
        mime: 'image/png',
        sizeBytes: 10240,
        updatedAt: at(90),
      },
    ],
  };

  const detail = {
    task: { ...taskList[0] },
    budget: { limitMin: 10, usedSec: 132, remainingSec: 468, warnAt: 480 },
    // 待办形状按 `spec/openapi.yaml` 的 Todo（required: todoId/type/state/prompt）。
    //
    // 这里曾经是 `{ todoId, question, options:[{id,label}], createdAt }` —— 一份**契约里
    // 不存在的形状**。客户端按契约严格解码，第一条待办就把整份 TaskDetail 解崩，
    // 表现是「这个任务没有输出、产物胶囊整片消失」；排查时还以为是宿主数据坏了
    // （2026-11-22，另一个会话照着 mock 反推宿主，绕了两轮）。
    // 教训：mock 是「契约样本的搬运工」，形状只能比契约更少，不能自创。
    pendingTodos: [
      {
        todoId: 'todo_1',
        type: 'approval',
        state: 'pending',
        prompt: '写入 src/tunnel-reconnect.mjs（新增文件，523 行）',
        // options 只对 approval 有意义，取值是契约枚举而非自定义 id/label。
        options: ['allow_once', 'allow_always', 'deny'],
        // at() 是「往前偏移」，负值=未来；给 10 分钟，避免刚启动就显示已过期。
        expiresAt: at(-600),
      },
      {
        todoId: 'todo_2',
        type: 'question',
        state: 'pending',
        // question 类型的提问放 prompt；它没有 allow_once/deny 这类审批选项。
        prompt: '重连退避要不要做成可配置？',
      },
    ],
    artifactsPreview: artifacts.items.map((a) => ({
      artifactId: a.artifactId, name: a.name, kind: a.kind, sizeBytes: a.sizeBytes,
    })),
    tokenUsage: { inputTokens: 8123, outputTokens: 2048, totalTokens: 10171 },
    lastSeq: 0,
    serverTime: at(0),
  };

  // 一次完整运行的 10 帧事件；kind 覆盖 state / turn / todo / log / artifact。
  const scenario = {
    frames: [
      { delayMs: 60, frame: { kind: 'turn', data: { type: 'user_message', text: '把隧道重连逻辑抽成独立模块' } } },
      { delayMs: 240, frame: { kind: 'turn', data: { type: 'thought_delta', delta: '先看 tunnel.mjs 里重连的那几段，确认边界。' } } },
      { delayMs: 180, frame: { kind: 'turn', data: { type: 'assistant_delta', delta: '我把重连拆成独立模块，' } } },
      { delayMs: 220, frame: { kind: 'turn', data: { type: 'tool_call', callId: 'call_mock_1', toolName: 'read_file', argSummary: 'src/tunnel.mjs' } } },
      { delayMs: 160, frame: { kind: 'turn', data: { type: 'tool_result', callId: 'call_mock_1', toolName: 'read_file', summary: '已读取 523 行' } } },
      { delayMs: 200, frame: { kind: 'turn', data: { type: 'assistant_delta', delta: '并把退避与进程回收都收进去。' } } },
      { delayMs: 180, frame: { kind: 'todo', data: { todoId: 'todo_1', type: 'approval', state: 'pending', prompt: '写入 src/tunnel-reconnect.mjs（新增文件，523 行）' } } },
      { delayMs: 140, frame: { kind: 'log', data: { level: 'info', text: '写入 src/tunnel-reconnect.mjs' } } },
      { delayMs: 160, frame: { kind: 'artifact', data: { artifactId: 'art_notes', name: 'tunnel-notes.md', kind: 'file' } } },
      { delayMs: 200, frame: { kind: 'state', data: { status: 'completed', phase: { index: 5, total: 5, label: '已完成' }, elapsedSec: 96, needsYou: false } } },
    ],
  };

  return {
    hostInfo,
    workspaces,
    taskList,
    detail,
    artifacts,
    scenario,
    createOk: { accepted: true, replayed: false, duplicate: false },
    messageOk: { accepted: true, duplicate: false },
    cancelOk: { accepted: true },
    todoOk: { applied: true },
    listBody: { items: taskList, workspaces, nextCursor: null, serverTime: at(0) },
    RUNNING_TASK,
    IDLE_TASK,
  };
}
