// adapter/cordis-host.mjs — 真实宿主适配器（X2 方法表，2026-11-16 考古闭环）
//
// 证据链（全部来自 app.asar 反编译核对，见 RUNBOOK §10）：
//   · 宿主业务通过 Typert RPC 动作暴露：session/list | state | create | prompt |
//     cancel | follow | events …（@deepseek-ai/dsh-api-session-controller，服务名
//     `sessionController`，namespace "session"）；
//   · 对外传输 = 宿主 Gateway（服务名 `typertGateway`）把 RPC 挂在 webServer 的
//     WebSocket `/api` 上（RemoteStreamMuxServer——「mux」的真身）；历史上推测的
//     `/api/remote.mux` HTTP 端点**不存在**（asar 内 16 处 mux 命中全是 tmux-context）；
//   · 我们的插件与控制器同处宿主进程、同一个 cordis 上下文树——loader 给插件的是
//     根上下文的子上下文，服务向上解析，因此**进程内直取服务**是最短且受信任
//     （principalOf：非 Remote 调用视同 owner）的路径。本适配器即此路径。
//
// 纪律（ADR-12 不变）：这一层是唯一允许出现宿主服务的地方；
// 映射不到的方法显式抛 4021，绝不假装成功。

import crypto from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join as joinPath } from 'node:path';
import os from 'node:os';
import { fail, GatewayError } from '../protocol.mjs';
import { displayHostName } from '../host-name.mjs';
import { translateLiveEvent } from './session-history.mjs';
import { deriveArtifacts, decodeArtifactId, mimeOf, sniffMime } from './artifacts.mjs';

import { toGatewayError, isHostRemoteError } from './host-errors.mjs';

/** 宿主服务名清单（诊断与 services 证据用；来源：各控制器 `static inject` 与 super(ctx, 名)）。 */
const WATCHED_SERVICES = [
  'sessionController', 'jobController', 'workspaceController',
  'terminalController', 'settingsController', 'remoteAccess',
  'agents', 'sessions', 'sessionQuery', 'sessionProjections', 'llm', 'typert',
  // 2026-11-17 会话设置同步：权限目录（permissionPresets）与斜杠命令面（commands，
  // 权限切换实证 = 会话命令 `/permission <preset>`，与桌面端 PermissionSelect 同一条写路径）。
  'permissionPresets', 'commands',
  // 2026-11-18 附件上送：图片内联 prompt，通用文件经 fileUploads.uploadStream 换 receiptId。
  'fileUploads',
  // 2026-11-18 会话动作（置顶/归档）：权威集合来自 workspaceRegistry（feed.ts 同源），
  // workspaceController 提供 pinSession/archiveSession 等写动作。
  'workspaceRegistry', 'workspaceController',
];

/**
 * cordis 适配器**实际提供**的协议能力（caps 语义与 mock 对齐：客户端据此判 UI）。
 * 如实边界：todos.answer / events.resume 未映射（4021），绝不虚报；
 * ws.ticket 由网关统一并入（server.mjs GATEWAY_CAPS）。
 *
 * artifacts.read 是 2026-11-17 新加的：宿主没有「会话产物」端点，但会话事件里
 * 的写类工具调用带完整路径，配上 session/list 给的 cwd 就能核对出真文件
 * （见 artifacts.mjs）。能列、能下载，才敢写进 caps。
 *
 * tasks.settings 是同日新增：权限当前值/目录 + 模型目录/切换（见 sessionSettings）。
 */
const SERVED_CAPS = [
  'tasks.read', 'tasks.write', 'tasks.cancel', 'artifacts.read', 'tasks.settings',
  // 2026-11-18：与桌面端右键菜单同源的会话动作（置顶/归档/重命名/分叉/复制 ID）。
  // 复制 ID 纯客户端，不需要宿主能力；这里声明的四个都需要宿主动作可达。
  'tasks.sessionActions',
  // 2026-11-18：提示词增强（真调宿主 llm，一次性补全）。客户端据此点亮增强按钮。
  'prompt.enhance',
];

/** 从 cwd 取展示标题（宿主 summary 不带标题；标题投影在 projections 里，命中即用）。 */
function deriveTitle(summary) {
  const projTitle = summary?.projections?.values?.title ?? summary?.projections?.title;
  if (typeof projTitle === 'string' && projTitle.trim()) return projTitle.trim();
  const cwd = typeof summary?.cwd === 'string' ? summary.cwd : '';
  if (cwd) {
    const base = cwd.split('/').filter(Boolean).pop();
    if (base) return base;
  }
  const id = String(summary?.sessionId ?? '');
  return `会话 ${id.slice(-6)}`;
}

/**
 * 宿主会话 summary → 我们的 TaskSummary。
 * status 映射（v1 如实边界）：
 *   · running === true                → running
 *   · agentAvailable 但没在跑          → idle（「空闲 · 可续」）
 *   · 冷会话同样进 listTasks（映射为 idle）——手机侧栏与桌面端同口径，
 *
 * 为什么不能把「没在跑」写成 interrupted：宿主 summary 只有
 * `{sessionId, updatedAt, agentAvailable, running, blank, cwd, projections}`，
 * **没有「上一回合是被打断的、还是正常说完的」这个事实**。把两者合并成 interrupted，
 * 结果是每个空闲会话都顶着「已中断 · 可续」的告警徽标——用户看到的是「怎么老是中断」
 * （2026-11-17 真机反馈，起因就是这里）。真正被打断只在我们能观测到证据时才说：
 * 客户端侧监听 WS gen 变化，把「原本 running 的任务」降级为 interrupted（FR-TASK-06）。
 *
 * needsYou/pendingTodoCount v1 恒 false/0：宿主 summary 不暴露审批态，不编造。
 */
/**
 * 从会话事件推导「最近一轮」的 token 用量。
 *
 * 宿主的权威字段取自 app.asar 实证：`assistant/message` 的 `data.usage`
 * （或 stream 里最后一段 usage），形状是
 * `{ inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens }`。
 * 同一轮可能有多次尝试（step），每个 step 取最后一次采样，跨 step 求和——
 * 与宿主 `dsh-token-meter/turn-usage.ts` 的 deriveTurnTokenUsage 同口径。
 * 拿不到就返回 null：面板只能如实省略，不能编一个数字。
 */
function latestTurnUsage(records) {
  const events = (Array.isArray(records) ? records : [])
    .map((r) => r?.event ?? r)
    .filter((e) => e && typeof e === 'object');
  let endIdx = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'turn/end') { endIdx = i; break; }
  }
  if (endIdx < 0) return null;
  const turn = events[endIdx].data?.turn;
  let startIdx = 0;
  if (turn !== undefined) {
    for (let i = endIdx - 1; i >= 0; i -= 1) {
      if (events[i].type === 'turn/start' && events[i].data?.turn === turn) { startIdx = i; break; }
    }
  }
  const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const streamUsage = (stream) => {
    if (!Array.isArray(stream)) return null;
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      if (stream[i]?.usage && isCount(stream[i].usage.inputTokens)) return stream[i].usage;
    }
    return null;
  };
  const samples = new Map();
  for (let i = startIdx; i <= endIdx; i += 1) {
    const e = events[i];
    if (e.type !== 'assistant/message') continue;
    const d = e.data ?? {};
    const u = d.usage ?? streamUsage(d.stream);
    if (!isCount(u?.inputTokens) || !isCount(u?.outputTokens)) continue;
    samples.set(String(d.step ?? '0'), u);
  }
  if (!samples.size) return null;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const u of samples.values()) {
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    totalTokens += isCount(u.totalTokens) ? u.totalTokens : u.inputTokens + u.outputTokens;
    if (isCount(u.cacheReadTokens)) cacheReadTokens += u.cacheReadTokens;
    if (isCount(u.cacheWriteTokens)) cacheWriteTokens += u.cacheWriteTokens;
  }
  return { totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function summaryToTask(summary, hostName, workspaceIndex = null) {
  const running = summary.running === true;
  const workspace = workspaceIndex?.bySession.get(String(summary.sessionId));
  return {
    taskId: summary.sessionId,
    title: deriveTitle(summary),
    status: running ? 'running' : 'idle',
    // 宿主 list 只给 running / agentAvailable，没有阶段进度——**不编**。
    // 之前拼的「第 5/5 步 · 已中断·可续」既不是宿主事实，又和状态标签重复，
    // 手机端会读成「连不上」，实际只是会话被宿主重启打断（2026-11-16 修复）。
    phase: null,
    startedAt: null,
    lastActivityAt: typeof summary.updatedAt === 'number' ? new Date(summary.updatedAt).toISOString() : null,
    hostId: 'host_cordis',
    hostName,
    cwd: summary.cwd ?? null,
    // 桌面侧栏的工作区分组（workspaceRegistry.list() 的 title/sessionIds）。
    // 没有归属的会话留 null，手机端归到「未分组」——与 tree.ts 的 UNGROUPED_KEY 同口径。
    workspaceId: workspace?.id ?? null,
    workspaceName: workspace?.title ?? null,
    needsYou: false,
    pendingTodoCount: 0,
    artifactsCount: 0,
    // 宿主侧痕迹字段，诊断与测试用（协议允许额外字段；iOS 解码忽略未知键）
    hostAgentAvailable: summary.agentAvailable === true,
  };
}

/**
 * 清洗模型输出：模型偶尔会把整段包成代码块，或加一句「以下是增强后的提示词：」。
 * 只做这两类**确定性**剥离，不去猜测正文边界。
 */
function unwrapEnhancedText(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return '';
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();
  const lines = text.split('\n');
  if (lines.length > 1) {
    const first = lines[0].trim();
    if (first.length <= 24 && /[：:]\s*$/.test(first)
      && /^(以下是|下面是|这是|增强后|改写后|优化后|好的)/.test(first)) {
      text = lines.slice(1).join('\n').trim();
    }
  }
  return text;
}

export function createCordisHost({ ctx, log = () => {}, hostname = displayHostName(), user = undefined } = {}) {
  if (!ctx || (typeof ctx.get !== 'function' && typeof ctx !== 'object')) {
    throw new Error('createCordisHost 需要 cordis 上下文（ctx）');
  }

  /**
   * 桌面端登录账号（0.3.9，供手机设置页显示）。来源按序：
   *   1. 插件 config.user（显式注入，运营可控）；
   *   2. 宿主上下文宽容读取（ctx.get('user') / ctx.user —— 未来宿主提供
   *      登录身份服务时零配置生效；字段名对齐 OpenAPI HostUser）。
   * 都取不到就**不发 user 字段**——客户端显示「未登录」态。铁律：不编造数据。
   */
  function resolveUser() {
    const cands = [user];
    try {
      if (typeof ctx.get === 'function') cands.push(ctx.get('user'));
    } catch { /* 服务不存在视为未提供 */ }
    try { cands.push(ctx.user); } catch { /* 受控代理读取失败视为未提供 */ }
    for (const c of cands) {
      if (!c || typeof c !== 'object') continue;
      // 别名宽容（与 iOS 端解码同一套）：id/uid、nickname/displayName/username、
      // avatarUrl/avatar/avatarURL/avatarUri、maskedContact/contact。
      const id = c.id ?? c.uid ?? c.userId;
      const nickname = c.nickname ?? c.displayName ?? c.username;
      if (id === undefined && nickname === undefined) continue;
      const avatarUrl = c.avatarUrl ?? c.avatar ?? c.avatarURL ?? c.avatarUri;
      const maskedContact = c.maskedContact ?? c.contact;
      const out = {};
      if (typeof id === 'string') out.id = id;
      if (typeof nickname === 'string') out.nickname = nickname;
      if (typeof avatarUrl === 'string') out.avatarUrl = avatarUrl;
      if (typeof maskedContact === 'string') out.maskedContact = maskedContact;
      if (Object.keys(out).length > 0) return out;
    }
    return undefined;
  }
  const hostUser = resolveUser();

  /** 解析宿主服务：cordis 服务在子上下文上向上解析；取不到显式 4021。 */
  function service(name, method) {
    let svc;
    try {
      svc = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
      if (svc === undefined || svc === null) svc = ctx[name];
    } catch {
      /* get 抛错视为不可用，走下方统一 4021 */
    }
    if (svc === undefined || svc === null) {
      throw fail(4021, `宿主服务 ${name} 不可用（方法 ${method} 无法执行）`, {
        detail: `service=${name}`,
      });
    }
    return svc;
  }

  /** 统一执行宿主调用：错误翻译 + 永不外抛。协议自身的 GatewayError 原样透传。 */
  async function call(method, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      const translated = toGatewayError(err, method);
      log(`cordis ${method} 失败：${translated.code ?? 'unknown'}`);
      throw translated;
    }
  }

  let requestIdOf = null;

  // MARK: 实时事件流（v2）
  //
  // 为什么是轮询而不是订阅：宿主确实有推送面（sessionController.observeEvent/2、
  // observeState/2），但它们的请求形状没有取证过——猜错就是「静默不推送」，
  // 比不做更糟。而 events(request) 的契约已经在 X2 里跑通（冷启动历史用的就是它），
  // 所以实时这条先按 1.2s 轮询落地：手机的观感是「一两秒内出现」，不是「一片死寂」。
  //
  // 关键取舍：**首轮只记水位，不补历史**。任务的历史由 REST /tasks/:id/events 提供，
  // 实时通道只负责「从现在起新发生的」。否则每次重连都会把 40 条旧事件重推一遍，
  // 手机端时间线会整段重复。
  const LIVE_POLL_MS = 1200;
  const LIVE_KEEP_MS = 10 * 60_000; // 停下来的任务再观察 10 分钟，收尾帧不至于丢
  const LIVE_PAGE = 40;

  const watched = new Map(); // sessionId → { hostSeq|null, running, lastActiveAt }
  let liveListener = null;
  let liveTimer = null;
  let liveBusy = false;
  let liveFirstOk = false;

  /**
   * 把一个会话放进观察集。
   *
   * `baseline` = 「这次写操作**之前**宿主已经到哪了」。手机刚发出的那条指令，
   * 宿主通常在我们 markWatched 之前就写进了事件日志；如果此时把水位设成「当前最大值」，
   * 这条指令自己会被当成历史跳过——用户看到的是「我问了，它答了，但我的问题不见了」。
   * 所以写操作路径必须带上写前水位。
   */
  function markWatched(taskId, baseline) {
    if (!taskId) return;
    const existing = watched.get(taskId);
    if (existing) {
      if (typeof baseline === 'number' && existing.hostSeq !== null) {
        existing.hostSeq = Math.min(existing.hostSeq, baseline);
      }
      existing.lastActiveAt = Date.now();
      return;
    }
    // 轮询发现的新会话没有 baseline：水位留空，首轮设成当前最大值（历史由 REST 给）。
    watched.set(taskId, {
      hostSeq: typeof baseline === 'number' ? baseline : null,
      running: null,
      lastActiveAt: Date.now(),
    });
  }

  /** 写前水位：读最新一条事件的 seq（读不到就返回 0，等于「从头观察」）。 */
  async function preWriteSeq(taskId) {
    try {
      const page = await eventPage(taskId, { maxMessages: 1 });
      const latest = page.records
        .map((r) => (r && r.event ? r.event : r))
        .filter((e) => e && typeof e.seq === 'number')
        .reduce((max, e) => Math.max(max, e.seq), 0);
      return latest;
    } catch {
      return 0;
    }
  }

  async function pollTaskEvents(taskId) {
    const page = await eventPage(taskId, { maxMessages: LIVE_PAGE });
    const records = page.records.map((r) => (r && r.event ? r.event : r)).filter(Boolean);
    let maxSeq = 0;
    for (const e of records) if (typeof e.seq === 'number') maxSeq = Math.max(maxSeq, e.seq);

    const state = watched.get(taskId) ?? { hostSeq: null, running: null, lastActiveAt: Date.now() };
    if (state.hostSeq === null) {
      state.hostSeq = maxSeq;
      watched.set(taskId, state);
      return;
    }

    const fresh = records.filter((e) => (typeof e.seq === 'number' ? e.seq : 0) > state.hostSeq);
    // 宿主日志按 seq 升序；万一不是，也保证手机端按发生顺序追加。
    fresh.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    let pushed = 0;
    for (const event of fresh) {
      for (const frame of translateLiveEvent(event)) {
        liveListener?.({ taskId, ...frame });
        pushed += 1;
      }
    }
    if (pushed > 0) log(`live push ${taskId} +${pushed} 帧（宿主 seq ${state.hostSeq}→${maxSeq}）`);
    if (fresh.length) state.lastActiveAt = Date.now();
    state.hostSeq = Math.max(state.hostSeq, maxSeq);
    watched.set(taskId, state);
  }

  async function pollLive() {
    if (liveBusy || !liveListener) return;
    liveBusy = true;
    try {
      const summaries = await summaryList();
      const now = Date.now();

      for (const s of summaries) {
        if (s.running === true) markWatched(s.sessionId);
        const state = watched.get(s.sessionId);
        if (!state) continue;
        const running = s.running === true;
        // 状态翻转立刻推一帧：手机端的「运行中 / 空闲」不该等列表刷新。
        if (state.running !== running) {
          state.running = running;
          state.lastActiveAt = now;
          liveListener?.({ taskId: s.sessionId, kind: 'state', data: { status: running ? 'running' : 'idle' } });
        }
      }

      for (const [taskId, state] of [...watched]) {
        if (now - state.lastActiveAt > LIVE_KEEP_MS) {
          watched.delete(taskId);
          continue;
        }
        try {
          await pollTaskEvents(taskId);
        } catch (err) {
          // 单个会话读失败（正在被压缩 / 刚建还没落盘）不该拖垮整轮；
          // 退避一件事：把它挪出观察集，下轮重新按 running 进入。
          if (err instanceof GatewayError && err.code === 4011) watched.delete(taskId);
          log(`live poll ${taskId} 失败：${err?.code ?? err?.message ?? 'unknown'}`);
        }
      }
      if (!liveFirstOk) {
        liveFirstOk = true;
        log(`live poll ok（首轮成功，观察 ${watched.size} 个会话）`);
      }
    } catch (err) {
      // 启动瞬间服务还没挂上（sessionController 尚未 provide）是常态，
      // 每 1.2s 会再试，不必惊动用户；但要在日志里看得见。
      log(`live poll 失败：${err?.message ?? String(err)}`);
    } finally {
      liveBusy = false;
    }
  }

  /** RPC 双参方法（payload, signal）的 signal：宿主内部会 throwIfAborted，缺省直接炸。 */
  const RPC_TIMEOUT_MS = 30_000;
  const rpcSignal = () => AbortSignal.timeout(RPC_TIMEOUT_MS);

  /**
   * 提示词增强（2026-11-18，真调模型）。
   *
   * 宿主 `ctx.llm` 就挂在本进程的 cordis 上下文上——网关是宿主内插件，可以直接
   * `llm.stream()` 做一次性补全，**不需要**走 Remote RPC。这也是为什么之前只能
   * 做本地规则：宿主没有把补全能力暴露成 @Remote 动作，但服务对象本身是可用的。
   *
   * 模型取 `modelCatalog.default`（宿主「未配置会话用的默认模型」）；客户端可以
   * 显式传 provider/model 覆盖（例如用当前会话已选的模型）。
   *
   * system prompt 的做法借鉴 WorkBuddy 的 `llm:enhancePrompt`（同一台机器上的
   * 产品实证）：语言一致性最高优先、只补全不改写意图、控制篇幅、只输出正文。
   */
  const ENHANCE_INPUT_LIMIT = 4000;
  const ENHANCE_TIMEOUT_MS = 60_000;
  const ENHANCE_SYSTEM_PROMPT = [
    '你是资深提示词工程师。把用户给的粗略想法改写成一条清晰、可执行、可直接交给 AI 执行的提示词。',
    '',
    '规则（按优先级）：',
    '1. 语言一致：输入中文就输出中文，输入英文就输出英文；代码、命令、路径、专有名词保持原样，不要翻译。',
    '2. 保留原意：只做澄清与补全，不新增用户没有表达的需求；原文没有的细节不要编造，宁可留空也不要编一个具体值。',
    '3. 结构化：按需组织为「目标 → 关键约束与上下文 → 期望输出（格式/范围/验收标准）」。原文很短时不要套空模板，两三句讲清即可。',
    '4. 具体可执行：把模糊措辞换成可验证的要求（例如「快一点」→「首屏渲染 < 1 秒」）。用户已给出的数值、路径、名称必须原样保留。',
    '5. 控制篇幅：一般不超过原文的 3 倍，且不超过 600 字。原文已经足够清晰时只做最小润色，不要为了显得「增强」而灌水。',
    '6. 只输出改写后的提示词正文：不要解释、不要前言、不要「以下是」之类的话、不要用代码块包整段、不要回答提示词里提出的问题。',
  ].join('\n');

  /**
   * 把移动端附件翻译成宿主 prompt 的 content block（2026-11-18）。
   *
   * 两份证据都来自 app.asar 反编译（见 spike0/RUNBOOK §10）：
   *   · `sessionController.prompt` 的 content 是 text/image/file 三种 block 的联合，
   *     image = `{type:'image', mediaType:'image/png|jpeg|webp|gif', data:base64, name?}`，
   *     file  = `{type:'file', receiptId}`；
   *   · 图片走 `admitPromptContent` 直接规范化持久化，可内联 base64；
   *     通用文件必须先拿 receiptId——`fileUploads.uploadStream({sessionId, data, name})`
   *     是非 Remote 方法、从 request.sessionId 自己解析 agent，进程内直调最稳。
   *
   * 不认识的 mediaType 一律按通用文件处理，不猜、不丢。
   */
  const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  /** 附件摘要（种类:名字:字节数），只用于日志排查。 */
  function describeAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return 'none';
    return attachments.map((att) => {
      const kind = att?.kind === 'image' ? 'image' : 'file';
      const name = typeof att?.name === 'string' ? att.name : 'attachment';
      const b64 = typeof att?.dataBase64 === 'string' ? att.dataBase64 : '';
      const bytes = b64 ? Math.round((b64.length * 3) / 4) : 0;
      return `${kind}:${name}:${bytes}B${att?.mediaType ? `(${att.mediaType})` : ''}`;
    }).join(' | ');
  }

  /**
   * 把「选中的工作区」翻成新建会话要用的 cwd。
   *
   * 宿主里工作区就是一个目录注册（`workspaceRegistry.list()` 元素带 `path`），
   * 而 `Workspace.attachSession` 会用会话 header 的 cwd 与 `workspace.path` 做
   * **严格相等**校验（app.asar 实证）。所以：先按 id 取目录，再带着这个 cwd 建会话，
   * 最后把会话归入工作区——三步少一步，会话就会掉进「未分组」。
   */
  function resolveWorkspaceTarget(workspaceId, cwd) {
    const id = String(workspaceId ?? '').trim();
    if (!id) return { cwd: cwd ? String(cwd).trim() : '', workspace: null, entity: null };
    let entity = null;
    try {
      const reg = service('workspaceRegistry', 'workspace/attach');
      entity = typeof reg.get === 'function' ? reg.get(id) : null;
    } catch {
      entity = null;
    }
    const snapshot = workspaceIndex().byId.get(id);
    const path = String(entity?.path ?? snapshot?.path ?? '').trim();
    if (!path) {
      throw fail(4400, '选中的工作区已不在电脑端 — 刷新任务列表后重新选。', {
        detail: `workspace=${id}`, reason: 'workspace-unavailable',
      });
    }
    return {
      cwd: path,
      workspace: { id, title: String(entity?.title ?? snapshot?.title ?? ''), path },
      entity,
    };
  }

  /**
   * 把新会话归入工作区。失败**不影响**已经建好的会话：它仍然可用，
   * 只是从「某工作区」掉到「未分组」，日志里留下原因。
   */
  async function attachToWorkspace(sessionId, workspace, entity) {
    if (!workspace) return;
    try {
      let ws = entity;
      if (!ws) {
        const reg = service('workspaceRegistry', 'workspace/attach');
        ws = typeof reg.get === 'function' ? reg.get(workspace.id) : null;
      }
      if (ws && typeof ws.attachSession === 'function') {
        await ws.attachSession(sessionId);
        log(`cordis 会话 ${sessionId} 归入工作区「${workspace.title || workspace.id}」`);
      } else {
        log(`cordis 会话 ${sessionId} 归入工作区失败：宿主没有可用的 attachSession`);
      }
    } catch (err) {
      log(`cordis 会话 ${sessionId} 归入工作区失败：${err?.message ?? String(err)}`);
    }
  }

  async function attachmentBlocks(sessionId, attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    // 附件摘要进日志：真机排查「附件无效」时，唯一能看到的就是这几个字段
    // （绝不打印字节或正文）。
    log(`attachments ${sessionId} ${describeAttachments(attachments)}`);
    const blocks = [];
    for (const att of attachments) {
      const name = typeof att?.name === 'string' && att.name ? att.name : 'attachment';
      const data = typeof att?.dataBase64 === 'string' ? att.dataBase64 : '';
      if (!data) throw fail(4400, `附件 ${name} 缺少数据`);
      if (att.kind === 'image' && INLINE_IMAGE_TYPES.has(att.mediaType)) {
        blocks.push({ type: 'image', mediaType: att.mediaType, data, name });
        continue;
      }
      // 通用文件：字节 → async iterable → uploadStream → receiptId。
      let bytes;
      try {
        bytes = Buffer.from(data, 'base64');
      } catch {
        throw fail(4400, `附件 ${name} 的 base64 不合法`);
      }
      if (bytes.length === 0) throw fail(4400, `附件 ${name} 解码后为空`);
      const fileUploads = service('fileUploads', 'attachments.upload');
      async function* chunks() {
        const CHUNK = 64 * 1024;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          yield new Uint8Array(bytes.subarray(i, i + CHUNK));
        }
      }
      const staged = await call('fileUploads.uploadStream', () =>
        fileUploads.uploadStream({ sessionId, data: chunks(), name }));
      const receiptId = staged?.receiptId;
      if (!receiptId) throw fail(4500, '宿主上传附件未返回 receiptId');
      blocks.push({ type: 'file', receiptId });
    }
    return blocks;
  }

  /**
   * 提交用户指令。mode 合法值考古实证只有 `steer` / `append`
   * （client.js：input.mode==='steer'?'steering':'queued'）——
   * 此前的 'queue' 是无效值，宿主直接拒绝：手机发消息卡「发送中」、
   * 新建任务桌面无反应的根因。steer 先试（运行中注入当前回合），
   * 非会话不存在类失败退 append（排队/续话）。
   *
   * @param {string|undefined} text 可为空（纯附件消息），但 content 不能空。
   * @param {Array} attachments 已翻译成 block；调用方先经 attachmentBlocks。
   */
  async function submitPrompt(ctrl, sessionId, text, extraBlocks = []) {
    requestIdOf = crypto.randomUUID();
    const content = [
      ...(text ? [{ type: 'text', text }] : []),
      ...extraBlocks,
    ];
    if (content.length === 0) throw fail(4400, 'prompt content 不能为空');
    const payload = (mode) => ({
      requestId: requestIdOf,
      sessionId,
      mode,
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    try {
      await ctrl.prompt(payload('steer'), rpcSignal());
    } catch (err) {
      const hostCode = isHostRemoteError(err) ? err.code : '';
      if (hostCode === 'session/not-found' || hostCode === 'workspace/not-found') throw err;
      await ctrl.prompt(payload('append'), rpcSignal());
    }
  }

  async function summaryList() {
    const ctrl = service('sessionController', 'session/list');
    const raw = await ctrl.list({}, rpcSignal());
    // 宿主 session.list({}) 走信封 {ok, value:{items}}（考古 client.js 实证）；
    // 兼容裸数组与其他常见信封键，命中路径记到 host.listEnvelope 供 diag 取证。
    const candidates = [
      ['array', Array.isArray(raw) ? raw : null],
      ['value.items', Array.isArray(raw?.value?.items) ? raw.value.items : null],
      ['items', Array.isArray(raw?.items) ? raw.items : null],
      ['sessions', Array.isArray(raw?.sessions) ? raw.sessions : null],
      ['values', Array.isArray(raw?.values) ? raw.values : null],
      ['list', Array.isArray(raw?.list) ? raw.list : null],
    ];
    const hit = candidates.find(([, v]) => v !== null);
    if (!hit) {
      const shape = raw === null || raw === undefined
        ? String(raw)
        : typeof raw !== 'object'
          ? `${typeof raw}`
          : `keys=[${Object.keys(raw).join(',')}]; `
            + Object.entries(raw).map(([k, v]) => `${k}:${Array.isArray(v) ? 'array' : typeof v}`).join(', ');
      throw fail(4500, '宿主 session/list 返回了非数组', { detail: shape });
    }
    host.listEnvelope = hit[0];
    return hit[1];
  }

  /**
   * 会话历史页（FR-CHAT-01 冷启动数据源）。
   * 宿主契约（app.asar typert 实证）：sessionController.events(request, signal)，
   * request = { address:{kind:'session',sessionId}, beforeSeq?, throughSeq?, maxMessages?, turnWindow? }
   * → { records:[{event}], hasMore, projections, assistantStream? }
   */
  async function eventPage(taskId, { beforeSeq, maxMessages = 60 } = {}) {
    const ctrl = service('sessionController', 'session/events');
    const request = { address: { kind: 'session', sessionId: taskId }, maxMessages };
    if (Number.isFinite(beforeSeq) && beforeSeq > 0) request.beforeSeq = beforeSeq;
    const raw = await ctrl.events(request, rpcSignal());
    const page = raw && typeof raw === 'object' && raw.value && typeof raw.value === 'object'
      ? raw.value
      : raw;
    const records = Array.isArray(page?.records) ? page.records : [];
    // 形状取证：首条记录的键名/type/seq 记进 diag，供翻译层对齐（不落内容）。
    if (records.length && !host.eventShape) {
      const ev = records[0]?.event ?? records[0];
      host.eventShape = `keys=${Object.keys(ev || {}).join(',')} type=${ev?.type} seq=${ev?.seq}`;
      log(`cordis events 形状: ${host.eventShape}`);
    }
    return { records, hasMore: Boolean(page?.hasMore) };
  }

  /**
   * X2 取证：宿主服务方法面（方法名/形参个数）。只暴露元信息，
   * 不含任何会话内容——用于核对 prompt/create 等动作的真实签名。
   */
  function methodSurface(svc) {
    if (!svc || (typeof svc !== 'object' && typeof svc !== 'function')) return null;
    const names = new Set();
    let proto = svc;
    for (let depth = 0; depth < 3 && proto && proto !== Object.prototype; depth += 1) {
      for (const n of Object.getOwnPropertyNames(proto)) names.add(n);
      proto = Object.getPrototypeOf(proto);
    }
    return [...names].filter((n) => {
      try { return typeof svc[n] === 'function'; } catch { return false; }
    }).map((n) => {
      try { return `${n}/${svc[n].length}`; } catch { return n; }
    }).sort();
  }

  /** 会话的工作目录。产物定位、路径收边都靠它；宿主没给就如实返回 null。 */
  async function taskCwd(taskId) {
    const summaries = await summaryList();
    const summary = summaries.find((s) => s.sessionId === taskId);
    if (!summary) throw fail(4011);
    return summary.cwd ?? null;
  }

  /**
   * 会话产物清单（推导）。`getTask` 与 `listArtifacts` 共用同一条口径，
   * 免得「详情页说没有产物、产物面板里却有五个」这种两处各说各话。
   */
  async function taskArtifacts(taskId) {
    const cwd = await taskCwd(taskId);
    if (!cwd) return { items: [], hasMore: false, reason: 'host 未提供工作目录（cwd 为空）' };
    const page = await eventPage(taskId, { maxMessages: 200 });
    const { items, skipped } = deriveArtifacts(page.records, { cwd });
    return { items, hasMore: false, skipped };
  }

  // MARK: 会话设置同步辅助（权限 / 模型，方法体在 host 对象内）

  /** 宿主返回值统一解信封：{ok:true,value} 直接取 value，其余原样（list 已实证这个形状）。 */
  function unwrapHost(raw) {
    return raw && typeof raw === 'object' && raw.ok === true && 'value' in raw ? raw.value : raw;
  }

  /** 会话投影（权限当前值 / 模型选择）。拿不到返回 null，不影响其他面。 */
  async function readProjections(taskId) {
    const ctrl = service('sessionController', 'session/projections');
    const raw = await ctrl.projections({ sessionId: taskId }, rpcSignal());
    return unwrapHost(raw);
  }

  /**
   * 把权限预设套到某条会话上（新建会话默认权限，2026-11-21 修）。
   *
   * 失败**不抛出**：会话已经建好了，为了权限去中断创建只会留下一条没有提示的
   * 空会话，比权限没套上更难收场。返回 true/false 让回执如实说明，
   * 手机端据此提示「权限未套用」，不假装成功。
   */
  async function applyPermissionPreset(sessionId, preset) {
    const body = String(preset ?? '').trim();
    if (!body) return undefined;
    try {
      const switched = await switchPermission(sessionId, body);
      if (switched.kind === 'error') {
        log(`cordis 新建会话权限被拒：${sessionId} ${body} — ${switched.text}`);
        return false;
      }
      log(`cordis 新建会话权限 ${sessionId} → ${body}（${switched.via}）`);
      return true;
    } catch (err) {
      log(`cordis 新建会话权限失败：${sessionId} ${body} — ${err?.code ?? err?.message ?? 'unknown'}`);
      return false;
    }
  }

  /**
   * 新建会话时应用用户在新建页选的模型（2026-11-21）。
   *
   * 走宿主 `session/selectModel({sessionId, provider, model, reasoningEffort?})`，
   * 与详情页模型胶囊同一动作，不另造协议。必须在 submitPrompt 之前调用——
   * 否则首条提示已经用电脑端默认模型跑完了，用户选的模型形同虚设。
   * provider / model 缺一不可（与 selectModel 的校验一致）；没选就返回 undefined，
   * 由 JSON.stringify 丢掉，客户端据此区分「没要求」。
   * 失败如实记日志并返回 false，不阻断建会话（模型没切成不该让会话建不起来）。
   */
  async function applyInitialModel(sessionId, { provider, model, reasoningEffort } = {}) {
    const providerId = String(provider ?? '').trim();
    const modelId = String(model ?? '').trim();
    if (!providerId || !modelId) return undefined;
    try {
      const ctrl = service('sessionController', 'session/selectModel');
      const request = { sessionId, provider: providerId, model: modelId };
      if (reasoningEffort) request.reasoningEffort = String(reasoningEffort);
      await ctrl.selectModel(request, rpcSignal());
      log(`cordis 新建会话模型 ${sessionId} → ${providerId}/${modelId}`);
      return true;
    } catch (err) {
      log(`cordis 新建会话模型失败：${sessionId} ${providerId}/${modelId} — ${err?.code ?? err?.message ?? 'unknown'}`);
      return false;
    }
  }

  /**
   * 切换会话权限预设（2026-11-21 二次修正：以宿主真写路径 permissionPresets.set 为主）。
   *
   * app.asar 铁证（本轮逐条核对，推翻上一轮的 Agent 对象推断）：
   *   · 桌面端自己的 `SessionController.command(line)` =
   *       `ctx.remote.commands.execute(this.sessionId, line, [])` —— 第一个参数是
   *       **sessionId 字符串**，不是 Agent；上一轮改成传 Agent 是误判。
   *   · `commands/execute` 的 zod schema：parameter_0 = z.string()（sessionId）。
   *   · 权限**真写**在 `@deepseek-ai/dsh-permission-presets`：
   *       `permissionPresets.set(session, presetName)`（session 来自 sessions.list()，
   *       "written through to their own session events"）—— 桌面端 auto-review
   *       卸载时就是 `permissionPresets.set(session, "danger-full-access")`。
   *
   * 因此直接用宿主的真写 setter，session 从宿主内存里按 id 取：
   *   `sessions.get(taskId)` 或退回 `sessions.list().find(...)`（两种宿主版本都兼容）。
   * 不再经过 `/permission` 命令注册表（那是给 UI 用的 human command registry，
   * 远程调用实测 4500，具体宿主异常已随 detail 记进日志）。
   * 会话不在宿主内存 → 4007 人话提示，不假装成功。
   */
  async function switchPermission(taskId, preset) {
    const sessions = service('sessions', 'sessions/get');
    let session = typeof sessions.get === 'function' ? sessions.get(taskId) : undefined;
    if (!session && typeof sessions.list === 'function') {
      const all = sessions.list();
      session = (Array.isArray(all) ? all : []).find(
        (s) => s?.id === taskId || s?.sessionId === taskId);
    }
    if (!session) {
      throw fail(4007, '会话当前不在电脑端内存里：先在电脑端打开它，再切换权限');
    }
    const presets = service('permissionPresets', 'permissionPresets/set');
    try {
      presets.set(session, preset);
    } catch (err) {
      // 记下真实宿主异常：真机再失败时可从日志确诊，不靠猜。
      log(`cordis permission set 失败 ${taskId} ${preset}: ${err?.message ?? String(err)}`);
      return { kind: 'error', text: err?.message ?? String(err), via: 'preset' };
    }
    log(`cordis permission ${taskId} → ${preset}（permissionPresets.set）`);
    return { kind: 'ok', via: 'preset' };
  }

  /** 进程级权限目录。 */
  async function permissionCatalog() {
    const svc = service('permissionPresets', 'permissionPresets/catalog');
    const raw = await svc.catalog();
    return unwrapHost(raw);
  }

  /** 模型目录（provider 分组 + 部署默认）。 */
  async function readModelCatalog() {
    const ctrl = service('sessionController', 'session/modelCatalog');
    const raw = await ctrl.modelCatalog();
    return unwrapHost(raw);
  }

  async function assertTaskExists(taskId) {
    const summaries = await summaryList();
    if (!summaries.some((s) => s.sessionId === taskId)) throw fail(4011);
  }

  /**
   * 会话置顶/归档集合（2026-11-18，与桌面端右键菜单同源）。
   * 权威源 = workspaceRegistry（feed.ts 用它构建 baseline 的同一处）：
   * pinnedSessionIds / archivedSessionIds。尽力而为的附加字段——拿不到回空集合，
   * 绝不让 listTasks 因它失败（否则整个侧栏空白）。
   */
  function workspaceFlags() {
    const empty = { pinned: new Set(), archived: new Set() };
    try {
      const reg = service('workspaceRegistry', 'workspace/flags');
      const toSet = (v) => new Set(Array.isArray(v) ? v.map(String) : []);
      return { pinned: toSet(reg.pinnedSessionIds), archived: toSet(reg.archivedSessionIds) };
    } catch {
      return empty;
    }
  }

  /**
   * 桌面侧栏的工作区分组（与桌面 tree.ts / WorkspaceFeed 对齐）。
   *
   * 权威源 = workspaceRegistry.list()（`WorkspaceFeed.baseline()` 与
   * `workspaces()` 用的是同一处）。**返回形状以宿主源码为准**：
   * `list()` 是同步方法，元素是 Workspace 对象
   * `{ id, title, path, sessionIds: Set<string> }`。
   *
   * 2026-11-21 真机返工（分组条三点菜单整条消失）根因就在这两处形状误判：
   *   1) 之前按 `ws.workspaceId` 取 id —— 字段其实叫 `id`，于是每个工作区都被
   *      `continue` 跳过，`workspaces` 恒为 `[]`；
   *   2) 之前用 `Array.isArray(ws.sessionIds)` 判会话归属 —— 它是个 **Set**，
   *      判空后 bySession 永远为空。
   * 两处叠加的结果：所有任务 workspaceId 都是 null → 手机端全部退化成
   * `cwd:` 兜底分组 → 分组头菜单被"非真实工作区"过滤条件全部挡掉。
   * 实测证据：修复前 `/mobile/v1/tasks` 返回 `items:15, workspaces:[]`。
   *
   * 现在两种形状都收（`id ?? workspaceId`、Set 与数组都支持），
   * 拿不到就回空索引——移动端退化为「未分组」，绝不猜 cwd 冒充工作区名。
   */
  function workspaceIndex() {
    const empty = { bySession: new Map(), byId: new Map(), groups: [] };
    try {
      const reg = service('workspaceRegistry', 'workspace/list');
      const list = typeof reg.list === 'function' ? reg.list() : [];
      if (!Array.isArray(list)) return empty;
      const bySession = new Map();
      const byId = new Map();
      const groups = [];
      for (const ws of list) {
        if (!ws) continue;
        const id = String(ws.id ?? ws.workspaceId ?? '').trim();
        if (!id) continue;
        // 真实宿主是 title；旧快照里出现过 name（mock fixture 同形），两者都认。
        const title = String(ws.title || ws.name || '').trim();
        if (!title) continue;
        // path 只给网关自己用（新建会话时当 cwd 用）；客户端拿到也只当提示，
        // 但不下发到任务行——手机上没有「打开这个目录」的动作，摆出来是噪声。
        const path = typeof ws.path === 'string' ? ws.path : '';
        groups.push({ id, name: title, ...(path ? { path } : {}) });
        // 按 id 取工作区实体（attachSession 要实体，不是快照）。
        if (path) byId.set(id, { id, title, path });
        // sessionIds 在宿主里是 Set，别用 Array.isArray 判——那会把归属全丢掉。
        const ids = ws.sessionIds instanceof Set
          ? [...ws.sessionIds]
          : (Array.isArray(ws.sessionIds) ? ws.sessionIds : []);
        for (const sid of ids) {
          if (!sid) continue;
          bySession.set(String(sid), { id, title });
        }
      }
      return { bySession, byId, groups };
    } catch {
      return empty;
    }
  }

  function withFlags(task, flags) {
    return {
      ...task,
      pinned: flags.pinned.has(task.taskId),
      archived: flags.archived.has(task.taskId),
    };
  }

  const host = {
    kind: 'cordis',

    info() {
      // caps = 协议能力（与 mock 同语义，客户端判 UI 用）；
      // services = 宿主服务可见性证据（X2 运行时快照，诊断用）。
      const services = WATCHED_SERVICES.filter((n) => {
        try {
          const svc = typeof ctx.get === 'function' ? ctx.get(n) : undefined;
          return svc !== undefined && svc !== null;
        } catch {
          return false;
        }
      });
      return {
        hostId: 'host_cordis',
        hostName: hostname,
        hostVersion: 'unknown',
        platform: process.platform,
        protocolVersion: '1.0',
        caps: [...SERVED_CAPS],
        services,
        maxConcurrentTasks: 3,
        ...(hostUser ? { user: { ...hostUser } } : {}),
      };
    },

    async listTasks({ limit = 50, includeArchived = false } = {}) {
      return call('session/list', async () => {
        const summaries = await summaryList();
        // 与桌面端侧栏同口径：冷会话（agentAvailable=false）也进列表，
        // 由 summaryToTask 映射为 idle（可续）——之前只放行 running，
        // 手机侧栏只剩 1 条（2026-11-17 真机反馈）。
        //
        // 可见性严格对齐桌面端 tree.ts 的 isVisible（2026-11-18 真机对账）：
        //   · origin==='subagent' / 有 parentSessionId 的子会话只挂在父行的
        //     子代理目录里，**不单独占任务条**；
        //   · blank 是「新会话」占位，桌面端只显示当前选中的那一条；
        //   · archived 默认隐藏，只在「已归档」视图（includeArchived）里出现。
        // 真机实测：宿主 list 返回 48 条，其中 25 条已归档 + 一批子会话/空占位，
        // 桌面端侧栏只有十几条——差异全部来自这三条规则。之前把归档项留在
        // 列表里（怕没有恢复入口），结果用户点「删除/归档」后任务条纹丝不动，
        // 读起来就是「点了没反应」。现在改为默认隐藏 + 独立归档视图恢复。
        const flags = workspaceFlags();
        const workspaces = workspaceIndex();
        const visible = summaries.filter((s) => {
          const id = String(s.sessionId);
          if (s.origin === 'subagent') return false;
          if (s.parentSessionId) return false;
          // 正在跑的 blank 说明已经在产出内容（新建即发消息），保留，避免刚建的会话闪没。
          if (s.blank === true && s.running !== true) return false;
          return includeArchived ? flags.archived.has(id) : !flags.archived.has(id);
        });
        const items = visible
          .sort((a, b) => {
            const pa = flags.pinned.has(String(a.sessionId)) ? 1 : 0;
            const pb = flags.pinned.has(String(b.sessionId)) ? 1 : 0;
            if (pa !== pb) return pb - pa;
            return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
          })
          .slice(0, limit)
          .map((s) => withFlags(summaryToTask(s, hostname, workspaces), flags));
        // 分组配置随列表下发：手机端据此给出与桌面一致的工作区标题与顺序。
        return {
          items,
          workspaces: workspaces.groups,
          nextCursor: null,
          serverTime: new Date().toISOString(),
        };
      });
    },

    async getTask(taskId) {
      return call('session/state', async () => {
        const summaries = await summaryList();
        const summary = summaries.find((s) => s.sessionId === taskId);
        if (!summary) throw fail(4011);
        const task = withFlags(summaryToTask(summary, hostname, workspaceIndex()), workspaceFlags());
        // 产物清单要跟着详情一起回来。
        //
        // 为什么：手机端「对话里那句话提到的文件」要靠 `task.artifacts` 才认得出，
        // 只给 `artifactsPreview: []` 的后果是——产物面板里有五个文件，对话里却
        // 一个入口都没有（2026-11-17 实测）。推导成本与产物面板同一次事件读取，
        // 所以直接复用同一条口径。
        const artifacts = await taskArtifacts(taskId).catch(() => ({ items: [] }));
        const items = artifacts.items ?? [];
        task.artifactsCount = items.length;
        // token 用量与产物同源（会话事件）；宿主没给就 null，手机端省略而不是编造。
        const tokenUsage = await eventPage(taskId, { maxMessages: 80 })
          .then((page) => latestTurnUsage(page.records))
          .catch(() => null);
        return {
          task,
          // budget/pendingTodos 如实缺省（iOS 端全部可选解码）；
          // budget 走宿主 job/workingDirectory 语义后 v2 再接。
          pendingTodos: [],
          // 预览带前 12 条即可：手机上「对话里提到的」通常就是最近这几个，
          // 完整清单仍由产物面板按需拉。
          artifactsPreview: items.slice(0, 12),
          tokenUsage,
          lastSeq: 0,
          serverTime: new Date().toISOString(),
        };
      });
    },

    async events(taskId, { beforeSeq, limit } = {}) {
      return call('session/events', async () => {
        const page = await eventPage(taskId, { beforeSeq, maxMessages: limit });
        return {
          taskId,
          records: page.records,
          hasMore: page.hasMore,
          eventShape: host.eventShape ?? null,
        };
      });
    },

    async listArtifacts(taskId) {
      // 宿主无「会话产物」端点。产物从**会话事件**里还原：写类工具调用带路径，
      // 再拿 cwd 收边、去磁盘核对存在性与大小。这样点开的一定是真文件；
      // 任务被回滚或文件被删掉，清单会自己变短，不会给用户一个 404。
      return call('artifacts/derive', () => taskArtifacts(taskId));
    },

    async readArtifact(taskId, artifactId) {
      return call('artifacts/read', async () => {
        const cwd = await taskCwd(taskId);
        if (!cwd) throw fail(4021, '主机未提供工作目录，产物无法定位');
        const file = decodeArtifactId(cwd, artifactId);
        if (!file) throw fail(4404, '产物不存在，或不在该任务的工作目录内');
        const info = statSync(file);
        if (info.size > 25 * 1024 * 1024) throw fail(4021, '产物过大，请在电脑端打开');
        const name = file.split(/[\\/]/).pop();
        return { name, mime: mimeOf(name), sizeBytes: info.size, data: readFileSync(file) };
      });
    },

    /**
     * 读宿主附件对象（2026-11-22）：手机时间线里「我发的那张图」。
     *
     * 宿主的附件对象库由 `attachmentId` 决定路径，文件名就是摘要本身（无扩展名）：
     *   ~/.dsh/attachments/v1/objects/<hex 前两位>/<hex 其余 62 位>
     * 真机取证：会话 session-b77cabee 的 seq=318 里 `sha256:b1166d2e…`，
     * 对象库 objects/b1/b1166d2e… 大小 360,968 B，与消息里的 bytes 完全一致。
     *
     * 边界：只读；只接受 `sha256:<64 位十六进制>`；只拼在 DSH_HOME 之下。
     * 不接受任意路径，也不解 base64——字节就是字节，让客户端直接显示。
     */
    async readAttachment(attachmentId) {
      return call('attachments/read', async () => {
        const id = String(attachmentId ?? '');
        const matched = /^sha256:([0-9a-f]{64})$/.exec(id);
        if (!matched) throw fail(4400, 'attachmentId 必须是 sha256:<64 位小写十六进制>');
        const hex = matched[1];
        const home = process.env.DSH_HOME || joinPath(os.homedir(), '.dsh');
        const file = joinPath(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex.slice(2));
        let info;
        try {
          info = statSync(file);
        } catch {
          throw fail(4404, '附件不在本机对象库里（可能已被清理）', { detail: `attachment=${hex.slice(0, 12)}…` });
        }
        if (!info.isFile()) throw fail(4404, '附件不在本机对象库里（可能已被清理）');
        if (info.size > 25 * 1024 * 1024) throw fail(4021, '附件过大，请在电脑端查看');
        const data = readFileSync(file);
        return {
          name: `attachment-${hex.slice(0, 8)}`,
          mime: sniffMime(data),
          sizeBytes: info.size,
          data,
        };
      });
    },

    async createTask({
      prompt, cwd, workspaceId, attachments, permission, provider, model, reasoningEffort,
    } = {}) {
      return call('session/create+prompt', async () => {
        if ((!prompt || !String(prompt).trim()) && !(Array.isArray(attachments) && attachments.length)) {
          throw fail(4400, 'prompt 不能为空');
        }
        // 工作区（2026-11-22）：手机上新任务可以选「放进哪个工作区」。
        // 工作区在宿主里就是一个目录，所以 cwd 必须与它一致，建完再把会话归进去。
        const target = resolveWorkspaceTarget(workspaceId, cwd);
        const ctrl = service('sessionController', 'session/create');
        const created = await ctrl.create(target.cwd ? { cwd: target.cwd } : {});
        // create 也走 {ok, value} 信封（考古 client.js：result.value.sessionId）
        const sessionId = created?.ok === true ? created?.value?.sessionId : created?.sessionId;
        if (!sessionId) throw fail(4500, '宿主 create 未返回 sessionId');
        await attachToWorkspace(sessionId, target.workspace, target.entity);
        // 新会话还没有任何事件：基线就是 0，从第一条开始都在观察范围内。
        const baseline = await preWriteSeq(sessionId);
        // 新建会话默认权限（2026-11-20）：必须排在**提交首条提示之前**。
        // 顺序反了就等于「第一回合仍按电脑端默认策略跑」——用户以为选了只读，
        // 模型却已经在首回合写过文件了。契约里这个字段一直存在，此前被网关丢掉，
        // 手机端的权限选择器因此一直是空转的。
        const permissionApplied = await applyPermissionPreset(sessionId, permission);
        // 新建会话指定模型（2026-11-21）：与权限同理，必须排在**提交首条提示之前**，
        // 否则第一句话仍走电脑端默认模型，用户在新建页选的模型等于没选。
        // 复用宿主 session/selectModel（与详情页模型胶囊同一动作），不另造协议。
        const modelApplied = await applyInitialModel(sessionId, { provider, model, reasoningEffort });
        // 首条提示被拒时，会话已经建出来了（宿主 create 成功）但一句话都没有。
        // 这里必须先把证据写进日志再外抛：会话 id + 宿主 reason + 附件摘要，
        // 否则线上只剩一句「4500」，只能靠猜。错误本身的分类见 HOST_CODE_MAP
        // （attachment-invalid → 4400，不可重试）。
        let blocks;
        try {
          blocks = await attachmentBlocks(sessionId, attachments);
          await submitPrompt(ctrl, sessionId, prompt ? String(prompt) : '', blocks);
        } catch (err) {
          log(`cordis create+prompt 首条被拒 session=${sessionId} `
            + `error=${err?.code ?? err?.message ?? 'unknown'} `
            + `reason=${err?.details?.reason ?? '-'} `
            + `attachments=${describeAttachments(attachments)}`);
          throw err;
        }
        // 新会话立刻进入观察集：宿主 running 标志可能晚一拍，等它就漏掉首条回复。
        markWatched(sessionId, baseline);
        log(`cordis create+prompt session=${sessionId}`);
        // 响应字段按契约补齐。少了 `accepted` 的后果是灾难性的：客户端把它当
        // 必填布尔，解码失败 → 判成可重试 → 队列无限重放同一 submissionId，
        // 界面上就是「新建任务永远发不出去、气泡一直发送中」。
        return { accepted: true, taskId: sessionId, queued: false, acceptedAt: new Date().toISOString(),
          // 只有请求了权限才带这个字段（undefined 会被 JSON.stringify 丢掉）——
          // 客户端据此区分「没要求」与「要求了但电脑端拒绝」。
          permissionApplied, modelApplied };
      });
    },

    async appendMessage(taskId, { text, attachments } = {}) {
      return call('session/prompt', async () => {
        const body = String(text ?? '').trim();
        if (!body && !(Array.isArray(attachments) && attachments.length)) throw fail(4400, '消息不能为空');
        const ctrl = service('sessionController', 'session/prompt');
        // 先记写前水位，再提交：宿主会把这条指令写成 user/message，
        // 水位若在提交后才取，刚好把它自己排除掉（实测「我的问题不见了，只看到回答」）。
        const baseline = await preWriteSeq(taskId);
        // 附件先翻译（文件要先上传宿主换 receiptId），再和文本一起提交。
        const blocks = await attachmentBlocks(taskId, attachments);
        await submitPrompt(ctrl, taskId, body, blocks);
        // 提交成功即进入观察集：手机随后发的那条消息要能被推回来。
        markWatched(taskId, baseline);
        return {
          accepted: true,
          taskId,
          turnId: requestIdOf,
          mode: 'append',
          acceptedAt: new Date().toISOString(),
        };
      });
    },

    async cancelTask(taskId) {
      return call('session/cancel', async () => {
        const ctrl = service('sessionController', 'session/cancel');
        await ctrl.cancel({ sessionId: taskId });
        log(`cordis cancel session=${taskId}`);
        // cancelRequested / irreversible 同为契约字段：缺一个客户端就解码失败，
        // 用户点「停止」看到的是转圈，而不是「已请求停止」。
        return {
          accepted: true,
          cancelRequested: true,
          irreversible: false,
          taskId,
          at: new Date().toISOString(),
        };
      });
    },

    // MARK: 提示词增强（真调模型，2026-11-18）

    /**
     * 一次性补全：把草稿改写成结构化提示词。
     *
     * 走宿主 `llm.stream()`（GenerateOptions: provider/model/system/messages/
     * temperature/maxTokens/signal）。流式块里只累加 `text-delta`；`finish`
     * 的 reason 原样回传，便于客户端区分「被截断」与「正常结束」。
     */
    async enhancePrompt({ text, provider, model } = {}) {
      return call('prompt/enhance', async () => {
        const source = String(text ?? '').trim();
        if (!source) throw fail(4400, '待增强的提示词不能为空');
        if (source.length > ENHANCE_INPUT_LIMIT) {
          throw fail(4400, `提示词过长（上限 ${ENHANCE_INPUT_LIMIT} 字）`);
        }

        const llm = service('llm', 'prompt/enhance');
        if (typeof llm.stream !== 'function') {
          throw fail(4021, '宿主 llm 服务不支持一次性补全（缺 stream 方法）');
        }

        // 路由：显式指定 > 宿主默认模型。默认模型来自 modelCatalog.default。
        let routeProvider = provider ? String(provider) : '';
        let routeModel = model ? String(model) : '';
        if (!routeProvider || !routeModel) {
          const catalog = await readModelCatalog();
          routeProvider = routeProvider || String(catalog?.default?.provider ?? '');
          routeModel = routeModel || String(catalog?.default?.model ?? '');
        }
        if (!routeProvider || !routeModel) {
          throw fail(4021, '宿主没有可用的默认模型，无法增强提示词');
        }

        let output = '';
        let finishReason = null;
        try {
          const stream = llm.stream({
            provider: routeProvider,
            model: routeModel,
            system: ENHANCE_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: [{ type: 'text', text: source }] }],
            temperature: 0.2,
            maxTokens: 1200,
            // 生成可能比普通 RPC 慢，用独立超时而不是 30s 的 rpcSignal。
            signal: AbortSignal.timeout(ENHANCE_TIMEOUT_MS),
            purpose: 'prompt-enhance',
          });
          for await (const chunk of stream) {
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
              output += chunk.text;
            } else if (chunk?.type === 'finish') {
              // 宿主 FinishReason 实测是对象 `{kind:'stop'}`（deepseek-official 路由），
              // 早期契约写的是字符串。这里统一压成字符串再回给客户端——
              // iOS 的 finishReason 是 String?，对象会直接解码失败（实测踩到）。
              const reason = chunk.reason;
              finishReason = typeof reason === 'string' ? reason : (reason?.kind ?? null);
            }
          }
        } catch (err) {
          // 模型侧失败要给用户一句能读懂的话，而不是裸错误。
          throw fail(4500, `模型调用失败：${err?.message ?? String(err)}`);
        }

        const enhanced = unwrapEnhancedText(output);
        if (!enhanced) throw fail(4500, '模型返回了空结果，请重试或换一个模型');

        log(`cordis enhance provider=${routeProvider} model=${routeModel}`
          + ` in=${source.length} out=${enhanced.length} finish=${finishReason ?? '?'}`);
        return {
          text: enhanced,
          provider: routeProvider,
          model: routeModel,
          finishReason,
          at: new Date().toISOString(),
        };
      });
    },

    // MARK: 会话动作（2026-11-18，与桌面端 Session 右键菜单同源）
    //
    // 全部来自 app.asar 反编译的 @Remote 实证（见 spike0/RUNBOOK §10）：
    //   · 置顶/归档 → workspaceController，单参数请求，无 signal 形参；
    //     返回完整集合 pinnedSessionIds / archivedSessionIds（{ok,value} 信封）。
    //   · 重命名/分叉 → sessionController，rename({sessionId,title}) 与
    //     fork({sessionId,atSeq?,allowMigration?})，同样单参数。
    // 宿主码 workspace/session-active（归档运行中会话未带 stopActivity）走
    // HOST_CODE_MAP 默认 4500；归档前由 REST 层显式带 stopActivity=true 规避。

    // MARK: 工作区写动作（2026-11-21，与桌面端分组右键菜单同源）
    //
    // app.asar 铁证：桌面端分组三点菜单「重命名 / 删除工作区」走宿主
    // workspaceController 的 @Remote('rename') / @Remote('delete')，与 pin/archive
    // 同一个 service、同样单参数无 signal（RPC 元数据 invocation.kind='direct'）。
    //   · rename({ workspaceId, title }) → WorkspaceValue
    //   · delete({ workspaceId })        → { deleted: true }
    // 删除只移除分组注册：文件夹与会话保留，会话落到「未分组」（桌面端 delete.desc
    // 原文），不是删文件——这点必须在 UI 文案里如实说明。
    // owner-only 不是障碍：适配器与控制器同处宿主进程，直调视同 owner。
    async renameWorkspace(workspaceId, { title } = {}) {
      return call('workspace/rename', async () => {
        const id = String(workspaceId ?? '').trim();
        const name = String(title ?? '').trim();
        if (!id) throw fail(4400, 'workspaceId 不能为空');
        if (!name) throw fail(4400, '工作区名称不能为空');
        const ctrl = service('workspaceController', 'workspace/rename');
        const raw = await ctrl.rename({ workspaceId: id, title: name });
        const value = unwrapHost(raw);
        const finalTitle = String(
          value?.workspace?.title ?? value?.title ?? name);
        log(`cordis rename workspace=${id} → ${finalTitle}`);
        return { applied: true, workspaceId: id, title: finalTitle, at: new Date().toISOString() };
      });
    },

    async deleteWorkspace(workspaceId) {
      return call('workspace/delete', async () => {
        const id = String(workspaceId ?? '').trim();
        if (!id) throw fail(4400, 'workspaceId 不能为空');
        const ctrl = service('workspaceController', 'workspace/delete');
        const raw = await ctrl.delete({ workspaceId: id });
        unwrapHost(raw);
        log(`cordis delete workspace=${id}（会话落到未分组，文件保留）`);
        return { applied: true, workspaceId: id, deleted: true, at: new Date().toISOString() };
      });
    },

    /**
     * 新建工作区（2026-11-22）：把电脑上一个**已存在**的目录注册成分组。
     *
     * 宿主 `workspaceController.create({ path })` 是「Create or idempotently
     * resolve one Workspace over an existing directory」——路径必须绝对、存在、
     * 且是目录，重复注册同一个目录会拿回原实体（不会建出两个同名分组）。
     * 标题默认取目录末段；手机端可以另起一个（走 registry.setTitle，
     * 与桌面端重命名同一条写路径）。
     */
    async createWorkspace({ path, title } = {}) {
      return call('workspace/create', async () => {
        const dir = String(path ?? '').trim();
        if (!dir) throw fail(4400, '目录路径不能为空');
        // 宿主 create 只接受**绝对路径**，且目录必须已存在；相对路径在宿主那里
        // 会抛一个普通 Error → 落到 4500（可重试），客户端就会白刷 15 秒。
        // 在这里先拦成 4400，把「路径写错了」这件事一次讲清楚。
        if (!isAbsolute(dir)) {
          throw fail(4400, '目录路径要用电脑上的完整路径，例如 /Users/你/Documents/项目', {
            detail: `path=${dir}`, reason: 'workspace-path-not-absolute',
          });
        }
        const ctrl = service('workspaceController', 'workspace/create');
        const raw = await ctrl.create({ path: dir });
        const value = unwrapHost(raw);
        const workspace = value?.workspace ?? value;
        const id = String(workspace?.workspaceId ?? workspace?.id ?? '').trim();
        if (!id) throw fail(4500, '宿主 create 工作区未返回 workspaceId');
        let name = String(workspace?.title ?? '').trim();
        const wanted = String(title ?? '').trim();
        if (wanted && wanted !== name) {
          // RPC 的 create 只收 path；标题走 registry（与桌面重命名同一条写路径）。
          // 改标题失败不该让「工作区已建好」变成报错——它已经是成立的实体。
          try {
            const reg = service('workspaceRegistry', 'workspace/title');
            const entity = typeof reg.get === 'function' ? reg.get(id) : null;
            if (entity && typeof entity.setTitle === 'function') {
              await entity.setTitle(wanted);
              name = wanted;
            }
          } catch (err) {
            log(`cordis 新工作区改标题失败：${err?.message ?? String(err)}`);
          }
        }
        const finalPath = String(workspace?.path ?? dir);
        log(`cordis create workspace=${id} path=${finalPath} created=${value?.created === true}`);
        return {
          applied: true, workspaceId: id, title: name || finalPath.split('/').pop() || finalPath,
          path: finalPath, created: value?.created === true, at: new Date().toISOString(),
        };
      });
    },

    async pinTask(taskId, { pinned = true } = {}) {
      return call('workspace/pinSession', async () => {
        const ctrl = service('workspaceController', 'workspace/pinSession');
        const action = pinned ? 'pinSession' : 'unpinSession';
        const raw = await ctrl[action]({ sessionId: taskId });
        const value = unwrapHost(raw);
        const ids = Array.isArray(value?.pinnedSessionIds) ? value.pinnedSessionIds.map(String) : [];
        log(`cordis ${action} session=${taskId} total=${ids.length}`);
        return { applied: true, taskId, pinned, pinnedSessionIds: ids, at: new Date().toISOString() };
      });
    },

    async archiveTask(taskId, { archived = true, stopActivity = false } = {}) {
      return call('workspace/archiveSession', async () => {
        const ctrl = service('workspaceController', 'workspace/archiveSession');
        const action = archived ? 'archiveSession' : 'unarchiveSession';
        const request = { sessionId: taskId };
        // 只有归档（非恢复）且显式要求时才带 stopActivity；恢复动作的请求类型无此字段。
        if (archived && stopActivity === true) request.stopActivity = true;
        const raw = await ctrl[action](request);
        const value = unwrapHost(raw);
        const ids = Array.isArray(value?.archivedSessionIds) ? value.archivedSessionIds.map(String) : [];
        log(`cordis ${action} session=${taskId} total=${ids.length}`);
        return { applied: true, taskId, archived, archivedSessionIds: ids, at: new Date().toISOString() };
      });
    },

    async renameTask(taskId, { title } = {}) {
      return call('session/rename', async () => {
        const name = String(title ?? '').trim();
        if (!name) throw fail(4400, '标题不能为空');
        await assertTaskExists(taskId);
        const ctrl = service('sessionController', 'session/rename');
        const raw = await ctrl.rename({ sessionId: taskId, title: name });
        const value = unwrapHost(raw);
        log(`cordis rename session=${taskId} seq=${value?.seq ?? '?'}`);
        return {
          applied: true,
          taskId,
          title: String(value?.title ?? name),
          seq: Number.isFinite(value?.seq) ? value.seq : 0,
          at: new Date().toISOString(),
        };
      });
    },

    async forkTask(taskId) {
      return call('session/fork', async () => {
        await assertTaskExists(taskId);
        const ctrl = service('sessionController', 'session/fork');
        const raw = await ctrl.fork({ sessionId: taskId });
        const value = unwrapHost(raw);
        const newId = value?.sessionId;
        if (!newId) throw fail(4500, '宿主 fork 未返回新会话 ID');
        // 新会话立刻进入观察集（与 create 同理由：首轮回复不能漏）。
        markWatched(String(newId), 0);
        log(`cordis fork session=${taskId} → ${newId}`);
        return { accepted: true, taskId, forkedTaskId: String(newId), at: new Date().toISOString() };
      });
    },

  async answerTodo() {
    // 宿主审批面走 session/control（namespace 下存在该动作），请求形状 v2 考古后接入。
    throw fail(4021, '待办答复尚未与宿主 session/control 对齐', { detail: 'method=todos.answer' });
  },

  // MARK: 会话设置同步（2026-11-17，工作区权限 + 模型选择与桌面端同源）
  //
  // 考古证据（app.asar 实证，全部为 sessionController / permissionPresets / commands
  // 的进程内动作）：
  //   · 权限当前值：session/projections → values.permissions.currentValue
  //     （"a configured preset key, `auto`, or `custom`"）；
  //   · 权限可选项：permissionPresets.catalog() → { options: [{value, name, description?}] }；
  //   · 权限切换：桌面端 PermissionSelect 走 `session.command("/permission <preset>")`，
  //     进程内 = commands/execute(**Agent**, "/permission x", [], signal)；
  //     会话还没起回合（无活体 Agent）时退回 permissionPresets.set(Session, name)
  //     ——第一个形参是 Agent / Session 对象，不是 id 字符串（见 switchPermission）；
  //   · 模型当前值：session/projections → values.modelSelection.next ?? lastUsed；
  //   · 模型目录：session/modelCatalog() → { default, groups: [{id,name,models}] }；
  //   · 模型切换：session/selectModel({sessionId, provider, model, reasoningEffort?})。
  // 任何一个面取不到都降级为 supported:false——手机端如实显示，不编造目录。
  async sessionSettings(taskId) {
    return call('session/settings', async () => {
      await assertTaskExists(taskId);
      // 三个面彼此独立：缺哪个就把哪一节标成 supported:false，绝不让整个接口 500。
      const [projection, presets, catalog] = await Promise.all([
        readProjections(taskId).catch((err) => {
          log(`cordis projections 失败：${err?.code ?? err?.message ?? 'unknown'}`);
          return null;
        }),
        permissionCatalog().catch((err) => {
          log(`cordis permissionPresets 失败：${err?.code ?? err?.message ?? 'unknown'}`);
          return null;
        }),
        readModelCatalog().catch((err) => {
          log(`cordis modelCatalog 失败：${err?.code ?? err?.message ?? 'unknown'}`);
          return null;
        }),
      ]);

      const values = projection?.values ?? null;
      const permissionValue = values?.permissions?.currentValue ?? null;
      const selection = values?.modelSelection ?? null;
      const currentModel = selection?.next ?? selection?.lastUsed ?? null;

      const presetOptions = Array.isArray(presets?.options) ? presets.options : [];
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];

      return {
        taskId,
        permission: {
          supported: presetOptions.length > 0 && permissionValue !== null,
          currentValue: permissionValue,
          options: presetOptions.map((o) => ({
            value: o.value,
            name: o.name,
            ...(typeof o.description === 'string' ? { description: o.description } : {}),
          })),
        },
        model: {
          supported: groups.length > 0,
          current: currentModel,
          default: catalog?.default ?? null,
          groups: groups.map((g) => ({
            id: g.id,
            name: g.name,
            models: (Array.isArray(g.models) ? g.models : []).map((m) => ({
              id: m.id,
              name: m.name,
              ...(typeof m.description === 'string' ? { description: m.description } : {}),
              ...(m.reasoning?.defaultEffort ? { defaultEffort: m.reasoning.defaultEffort } : {}),
              // 输入模态（2026-11-22）：手机选图前就能提示「这个模型不接受图片」，
              // 而不是等宿主在 prompt 准入处拒了才发现。宿主没声明就不带，
              // 客户端按「未声明=只有 text」处理——如实透传，不替宿主补默认值。
              ...(Array.isArray(m.inputModalities) ? { inputModalities: m.inputModalities } : {}),
            })),
          })),
          failures: Array.isArray(catalog?.failures) ? catalog.failures : [],
        },
        serverTime: new Date().toISOString(),
      };
    });
  },

  /**
   * App 级设置目录（2026-11-20）：与「某条会话」无关的进程级两面。
   *
   * 手机端设置面板要能先选「新建会话默认权限」和查看「跟随电脑端的模型」，
   * 而 `GET /tasks/:id/settings` 必须先有会话——第一次打开 App 时一条都没有，
   * 面板就会空着。permissionPresets / modelCatalog 本来就是**进程级服务**，
   * 这里直接把两面取出来，不编任何目录。
   *
   * 与 sessionSettings 的差别只有一处：没有 currentValue（那是会话级事实）。
   * 某个面取不到 → supported:false，手机端如实显示「跟随电脑端」。
   */
  async appSettings() {
    return call('app/settings', async () => {
      const [presets, catalog] = await Promise.all([
        permissionCatalog().catch((err) => {
          log(`cordis permissionPresets 失败：${err?.code ?? err?.message ?? 'unknown'}`);
          return null;
        }),
        readModelCatalog().catch((err) => {
          log(`cordis modelCatalog 失败：${err?.code ?? err?.message ?? 'unknown'}`);
          return null;
        }),
      ]);

      const presetOptions = Array.isArray(presets?.options) ? presets.options : [];
      const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];

      return {
        permission: {
          supported: presetOptions.length > 0,
          options: presetOptions.map((o) => ({
            value: o.value,
            name: o.name,
            ...(typeof o.description === 'string' ? { description: o.description } : {}),
          })),
        },
        model: {
          supported: groups.length > 0,
          default: catalog?.default ?? null,
          groups: groups.map((g) => ({
            id: g.id,
            name: g.name,
            models: (Array.isArray(g.models) ? g.models : []).map((m) => ({
              id: m.id,
              name: m.name,
              ...(typeof m.description === 'string' ? { description: m.description } : {}),
              ...(m.reasoning?.defaultEffort ? { defaultEffort: m.reasoning.defaultEffort } : {}),
              // 输入模态（2026-11-22）：手机选图前就能提示「这个模型不接受图片」，
              // 而不是等宿主在 prompt 准入处拒了才发现。宿主没声明就不带，
              // 客户端按「未声明=只有 text」处理——如实透传，不替宿主补默认值。
              ...(Array.isArray(m.inputModalities) ? { inputModalities: m.inputModalities } : {}),
            })),
          })),
          failures: Array.isArray(catalog?.failures) ? catalog.failures : [],
        },
        serverTime: new Date().toISOString(),
      };
    });
  },

  async setPermission(taskId, { preset } = {}) {
    return call('permission/switch', async () => {
      const body = String(preset ?? '').trim();
      if (!body) throw fail(4400, 'preset 不能为空');
      await assertTaskExists(taskId);
      // 与桌面端同一条写路径；活体与直写两条分支的取舍见 switchPermission。
      const switched = await switchPermission(taskId, body);
      if (switched.kind === 'error') {
        throw fail(4500, `权限切换被宿主拒绝：${switched.text ?? '未知原因'}`);
      }
      log(`cordis permission ${taskId} → ${body}（${switched.via}）`);
      return { applied: true, taskId, value: body, via: switched.via, at: new Date().toISOString() };
    });
  },

  async selectModel(taskId, { provider, model, reasoningEffort } = {}) {
    return call('model/select', async () => {
      const providerId = String(provider ?? '').trim();
      const modelId = String(model ?? '').trim();
      if (!providerId || !modelId) throw fail(4400, 'provider 与 model 不能为空');
      await assertTaskExists(taskId);
      const ctrl = service('sessionController', 'session/selectModel');
      const request = { sessionId: taskId, provider: providerId, model: modelId };
      if (reasoningEffort) request.reasoningEffort = String(reasoningEffort);
      const raw = await ctrl.selectModel(request, rpcSignal());
      unwrapHost(raw);
      log(`cordis selectModel ${taskId} → ${providerId}/${modelId}`);
      return {
        applied: true,
        taskId,
        selection: { provider: providerId, model: modelId, ...(reasoningEffort ? { reasoningEffort } : {}) },
        at: new Date().toISOString(),
      };
    });
  },

    /**
     * X2 取证：宿主服务方法面（方法名/形参个数）。只暴露元信息，
     * 不含任何会话内容——用于核对 prompt/create 等动作的真实签名。
     */
    async diag() {
      const present = [];
      const missing = [];
      for (const n of WATCHED_SERVICES) {
        try {
          const svc = typeof ctx.get === 'function' ? ctx.get(n) : undefined;
          (svc !== undefined && svc !== null ? present : missing).push(n);
        } catch {
          missing.push(n);
        }
      }
      const methods = {};
      const sources = {};
      for (const n of present) {
        try { methods[n] = methodSurface(ctx.get(n)); } catch { /* 内省失败不挡诊断 */ }
      }
      // 关键动作源码取证（RPC 包装器会暴露动作名与参数映射；只取我们映射用到的方法）
      try {
        const sc = ctx.get('sessionController');
        if (sc) {
          for (const m of ['prompt', 'list', 'create', 'cancel', 'state', 'rename', 'fork']) {
            if (typeof sc[m] === 'function') sources[m] = String(sc[m]).slice(0, 1600);
          }
        }
        const wc = ctx.get('workspaceController');
        if (wc) {
          for (const m of ['pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession']) {
            if (typeof wc[m] === 'function') sources[`workspace.${m}`] = String(wc[m]).slice(0, 1600);
          }
        }
      } catch { /* 忽略 */ }
      return {
        adapter: 'cordis',
        services: { present, missing },
        methods,
        ...(Object.keys(sources).length ? { sources } : {}),
        hostName: hostname,
      };
    },
    /**
     * 实时事件流 v2：轮询宿主 events()，把新事件翻译成网关 `turn` 帧推出去。
     *
     * 上一版这里是空实现（只打一行日志），后果是所有写操作都「看起来没反应」：
     * 手机发了消息，网关收下了、宿主也跑了，但没有任何帧能到达手机，
     * 时间线永远停在原地（2026-11-17 真机反馈「发出信息都无反应」的真因）。
     */
    subscribe(fn) {
      liveListener = fn;
      if (!liveTimer) {
        // 立刻来一轮：手机连上就能拿到当前状态，不用等一个轮询周期。
        void pollLive();
        liveTimer = setInterval(() => void pollLive(), LIVE_POLL_MS);
        if (typeof liveTimer.unref === 'function') liveTimer.unref();
      }
      return () => {
        liveListener = null;
        if (liveTimer) clearInterval(liveTimer);
        liveTimer = null;
        watched.clear();
      };
    },

    async close() {},
  };

  return host;
}
