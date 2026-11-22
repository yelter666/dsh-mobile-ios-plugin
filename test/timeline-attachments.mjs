// test/timeline-attachments.mjs — 消息里的附件不再被时间线吞掉（2026-11-22）。
//
// 两起真机事故在这里锁住：
//   1) 纯图片消息整条消失：`session-history.mjs` 先算 text，`if (!text) break`。
//      真机会话 session-b77cabee 的 seq=318 **只有两张 image 块、没有 text**，
//      于是「发了图，聊天记录里什么都没有」。现在无正文时用占位行 + attachments。
//   2) mock 的待办自创形状 `{question, options:[{id,label}], createdAt}`，
//      违反 `spec/openapi.yaml` 的 Todo（required: todoId/type/state/prompt）。
//      客户端严格解码时一条坏待办把整份 TaskDetail 解崩 → 看起来像「没输出」。
//      mock 是契约样本，形状只能比契约少，不能自创。
//
// 另附两条边界：系统注入的 user/message 仍要过滤（不是真人发的）；
// 正文+图片的消息文本必须保持正文原样（手机本地回声按文本去重，拼占位会多一个气泡）。

import { createGateway } from '../src/server.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { translateRecords, translateLiveEvent, mediaSummaries, mediaPlaceholder } from '../src/adapter/session-history.mjs';
import { httpJson } from './lib/wsclient.mjs';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push({ name, detail }); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 真机会话取证形状：seq=318 只有两张 image 块（source.kind=user，无 text）。
function imageRecord(overrides = {}) {
  return {
    type: 'user/message',
    seq: 318,
    time: Date.now(),
    data: {
      source: { kind: 'user' },
      content: [
        { type: 'image', attachment: { attachmentId: 'sha256:' + 'b1'.repeat(32), mediaType: 'image/jpeg', width: 1120, height: 1600, bytes: 360968, name: '001' } },
        { type: 'image', attachment: { attachmentId: 'sha256:' + 'c2'.repeat(32), mediaType: 'image/jpeg', width: 1122, height: 1600, bytes: 391706, name: '002' } },
      ],
      ...overrides,
    },
  };
}

console.log('\n▶ 时间线里的附件（历史翻译）\n');

{
  const out = translateRecords([imageRecord()]);
  check('纯图片消息不再被丢弃', out.items.length === 1 && out.items[0].kind === 'user', JSON.stringify(out.items));
  const item = out.items[0] ?? {};
  check('无正文 → text 用占位行，含张数与体积', /图片 2 张/.test(item.text ?? '') && /共\s*\d+\s*(KB|MB)/.test(item.text ?? ''), item.text);
  check('attachments 带元数据（kind/mediaType/bytes/尺寸）',
    Array.isArray(item.attachments) && item.attachments.length === 2
    && item.attachments[0].kind === 'image' && item.attachments[0].mediaType === 'image/jpeg'
    && item.attachments[0].bytes === 360968 && item.attachments[0].width === 1120, JSON.stringify(item.attachments));
  check('attachments 带可下载的相对 URL',
    typeof item.attachments?.[0]?.downloadUrl === 'string'
    && item.attachments[0].downloadUrl.startsWith('/mobile/v1/attachments/sha256:'), JSON.stringify(item.attachments?.[0]));
  check('时间线不携带图片 base64（避免冷启动几十兆）',
    !JSON.stringify(out.items).includes('data:image') && !JSON.stringify(out.items).includes('base64,'));
}

{
  const textImage = imageRecord({
    content: [
      { type: 'text', text: '看这两张图' },
      { type: 'image', attachment: { attachmentId: 'sha256:' + 'a1'.repeat(32), mediaType: 'image/png', bytes: 1024, name: 'shot.png' } },
    ],
  });
  const out = translateRecords([textImage]);
  const item = out.items[0] ?? {};
  check('图文消息：text 只保留正文（本地回声靠文本相等去重）', item.text === '看这两张图', item.text);
  check('图文消息：附件仍进 attachments', item.attachments?.length === 1 && item.attachments[0].kind === 'image');
}

{
  // 宿主把 ptc-mode / system-reminder 也塞成 user/message；它们可能带图片，
  // 但那是工具喂给模型的截图，不是用户说的话，不能进手机时间线。
  const injected = imageRecord({ source: { kind: 'ptc-mode' } });
  const out = translateRecords([injected, imageRecord()]);
  check('系统注入（ptc-mode）的带图消息仍被过滤', out.items.length === 1, JSON.stringify(out.items.map((i) => i.kind)));
}

{
  // 文件块形状（通用文件经 fileUploads 换 receiptId，宿主落盘后是 file 块）。
  const fileRecord = imageRecord({
    content: [{ type: 'file', attachment: { attachmentId: 'sha256:' + 'f0'.repeat(32), mediaType: 'application/pdf', bytes: 204800, name: '报价.pdf' } }],
  });
  const out = translateRecords([fileRecord]);
  const item = out.items[0] ?? {};
  check('纯文件消息也进时间线，占位带文件名', /文件/.test(item.text ?? '') && /报价\.pdf/.test(item.text ?? ''), item.text);
  check('文件块 kind=file', item.attachments?.[0]?.kind === 'file');
}

console.log('\n▶ 实时帧与历史同口径\n');

{
  const frames = translateLiveEvent(imageRecord());
  check('实时纯图片消息也推送（不能只在刷新后才有）',
    frames.length === 1 && frames[0].data?.type === 'user_message', JSON.stringify(frames));
  check('实时帧同样带 attachments', frames[0]?.data?.attachments?.length === 2);
  const textFrames = translateLiveEvent(imageRecord({ content: [{ type: 'text', text: '看这张' }] }));
  check('实时图文消息 text 与历史一致（正文原样）', textFrames[0]?.data?.text === '看这张');
}

console.log('\n▶ 附件摘要 / 占位文案（纯函数）\n');

{
  check('单行图片：尺寸与体积都在',
    mediaPlaceholder(mediaSummaries([{ type: 'image', attachment: { width: 800, height: 600, bytes: 4096 } }]))
      .includes('800×600') && mediaPlaceholder(mediaSummaries([{ type: 'image', attachment: { width: 800, height: 600, bytes: 4096 } }]))
      .includes('4 KB'));
  check('没有附件 → 占位为空', mediaPlaceholder([]) === '');
  check('未知块类型不进摘要', mediaSummaries([{ type: 'tool_result', text: 'x' }]).length === 0);
}

// ---- HTTP 端到端：mock 网关 ----
const host = createMockHost({ log: () => {} });
const gw = await createGateway({ host, port: 3219, dev: true, log: () => {} });
const addr = await gw.start();
const port = addr.port;
try {
  const codeRes = await httpJson({ port, method: 'POST', path: '/mobile/v1/pairing/code', body: { deviceName: 'timeline-test' } });
  const redeem = await httpJson({
    port, method: 'POST', path: '/mobile/v1/pairing/redeem',
    body: { code: codeRes.body.code, installId: 'ins_timeline', deviceName: 'timeline-test', platform: 'ios', appVersion: 'test' },
  });
  const token = redeem.body.deviceToken;
  check('配对成功（后续断言需要凭证）', redeem.status === 200 && Boolean(token));

  console.log('\n▶ mock 待办形状（按 spec/openapi.yaml 的 Todo）\n');
  const detail = await httpJson({ port, path: '/mobile/v1/tasks/tsk_a41f9c', token });
  const todos = detail.body?.pendingTodos ?? [];
  check('详情解出一列表待办', detail.status === 200 && todos.length === 2, JSON.stringify(detail.body?.error ?? todos));
  const REQUIRED = ['todoId', 'type', 'state', 'prompt'];
  check('每条待办都有 required 四字段',
    todos.every((t) => REQUIRED.every((k) => typeof t[k] === 'string' && t[k].length > 0)), JSON.stringify(todos));
  check('type 是契约枚举（approval/question/secret）',
    todos.every((t) => ['approval', 'question', 'secret'].includes(t.type)), JSON.stringify(todos.map((t) => t.type)));
  check('state 是契约枚举（pending/resolved/expired）',
    todos.every((t) => ['pending', 'resolved', 'expired'].includes(t.state)));
  check('不再出现自创字段 question / createdAt',
    todos.every((t) => !('question' in t) && !('createdAt' in t)));
  check('options 是字符串枚举，不是 {id,label} 对象',
    todos.filter((t) => 'options' in t).every((t) => t.options.every((o) => typeof o === 'string' && ['allow_once', 'allow_always', 'deny'].includes(o))));
  check('pendingTodoCount 与待办条数一致', detail.body?.task?.pendingTodoCount === todos.length);

  console.log('\n▶ 模型目录：输入模态\n');
  const appSettings = await httpJson({ port, path: '/mobile/v1/settings', token });
  const models = appSettings.body?.model?.groups?.flatMap((g) => g.models) ?? [];
  check('模型条目透传 inputModalities（有就有，不替宿主补默认）',
    models.length > 0 && models.every((m) => Array.isArray(m.inputModalities)), JSON.stringify(models));
  check('同时有支持图片与不支持图片的样本',
    models.some((m) => m.inputModalities.includes('image')) && models.some((m) => !m.inputModalities.includes('image')));

  console.log('\n▶ 时间线里的图片可下载\n');
  // 用一条真实的「图片+文字」消息验证整条写链路：POST /messages → 宿主落历史 →
  // GET /events 翻译出 attachments。内置演示任务没有历史记录，不能拿它断言。
  const sent = await httpJson({
    port, method: 'POST', path: '/mobile/v1/tasks/tsk_a41f9c/messages', token,
    body: {
      submissionId: 'sub_timeline_1', text: '配个图',
      attachments: [{ kind: 'image', name: 'shot.png', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
    },
  });
  check('图片+文字消息被接收', sent.status === 202, JSON.stringify(sent.body));
  const events = await httpJson({ port, path: '/mobile/v1/tasks/tsk_a41f9c/events', token });
  const echo = (events.body?.items ?? []).find((i) => i.kind === 'user' && Array.isArray(i.attachments) && i.attachments.length);
  check('历史里有带附件的用户消息（图片没被吞）', Boolean(echo), JSON.stringify(events.body?.items?.map((i) => `${i.kind}:${i.text ?? ''}`)).slice(0, 300));
  check('历史里图文消息的正文保持原样', echo?.text === '配个图', echo?.text);

  const testId = 'sha256:' + 'a7'.repeat(32);
  const img = await fetch(`http://127.0.0.1:${port}/mobile/v1/attachments/${testId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bytes = Buffer.from(await img.arrayBuffer());
  check('附件端点 200 + image/png', img.status === 200 && String(img.headers.get('content-type')).startsWith('image/png'), `status=${img.status} ct=${img.headers.get('content-type')}`);
  check('附件字节是可解码的 PNG（magic 正确）', bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), bytes.subarray(0, 8).toString('hex'));
  check('附件端点带 inline + 缓存头', String(img.headers.get('content-disposition')).startsWith('inline') && Boolean(img.headers.get('cache-control')));

  const bad = await httpJson({ port, path: '/mobile/v1/attachments/not-a-hash', token });
  check('非法附件 id → 4400（不试路径穿越）', bad.status === 400 && bad.body?.error?.code === 4400, JSON.stringify(bad.body));
} finally {
  await gw.stop();
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  process.exitCode = 1;
}
