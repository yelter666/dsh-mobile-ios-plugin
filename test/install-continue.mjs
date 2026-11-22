// test/install-continue.mjs — cloudflared「交给 Harness Agent 安装」链路回归
//
// 0.3.1 起插件彻底不再自己下载 cloudflared（慢网络/自定义协议下反复表现为「点了没反应」）。
// 缺依赖时只弹一个可复制指令框：用户复制给 DeepSeek Harness 桌面端 Agent 安装调试。
// 本套件走真实 apply → 面板 → 主按钮 → 弹窗按钮，验证「复制拿得到」且「不再碰下载」。

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const DOWNLOAD_BASE = 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), children: [], className: '', _text: '', value: '',
    style: { cssText: '', setProperty() {} }, listeners: {}, id: '', type: '', disabled: false,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) on = !this._set.has(c); on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    append(...els) { for (const e of els) { e._parent = this; this.children.push(e); } },
    insertBefore(el, ref) {
      el._parent = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i >= 0) this.children.splice(i, 0, el); else this.children.push(el);
      return el;
    },
    remove() { this._removed = true; const i = (this._parent?.children || []).indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] || ''; },
    select() { this._selected = true; }, focus() { this._focused = true; },
    setSelectionRange(a, b) { this._range = [a, b]; },
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { if (this.listeners[ev]) this.listeners[ev] = this.listeners[ev].filter((f) => f !== fn); },
    querySelector(sel) { return queryTree(this, sel)[0] || null; },
    querySelectorAll(sel) { return queryTree(this, sel, [], true); },
    click() { if (this.disabled) return; (this.listeners.click || []).slice().forEach((fn) => fn({ target: this, stopPropagation() {} })); },
    replaceChildren(...els) { for (const c of this.children) c._parent = null; this.children = []; for (const e of els) { e._parent = this; this.children.push(e); } },
    insertAdjacentHTML(pos, html) { const d = makeEl(); d._text = html; this.append(d); },
    get innerHTML() { return this._text || ''; },
    set innerHTML(v) { this._text = v; this.children = []; },
    closest(sel) { let cur = this; while (cur) { if (sel.startsWith('.') ? (cur.className || '').split(/\s+/).includes(sel.slice(1)) : cur.tagName === sel.toUpperCase()) return cur; cur = cur._parent; } return null; },
  };
  return el;
}
function queryTree(root, sel, out = [], all = false) {
  for (const c of (root.children || []).slice()) {
    c._parent = root;
    let hit = false;
    if (sel.startsWith('#')) hit = c.id === sel.slice(1);
    else if (sel.startsWith('.')) hit = (c.className || '').split(/\s+/).includes(sel.slice(1));
    else hit = c.tagName === sel.toUpperCase();
    if (hit) { out.push(c); if (!all) return out; }
    queryTree(c, sel, out, all);
    if (out.length && !all) return out;
  }
  return out;
}
function allTexts(root, out = []) {
  if (root._text) out.push(root._text);
  for (const c of root.children || []) allTexts(c, out);
  return out;
}

/**
 * @param {object} opts
 * @param {boolean} [opts.clipboardFails] 剪贴板与 execCommand 全失败（验证手动兜底）
 */
function makeHarness({ clipboardFails = false } = {}) {
  const body = makeEl('body');
  let execOk = !clipboardFails;
  const documentStub = {
    body, head: makeEl('head'), documentElement: makeEl('html'),
    createElement: (t) => makeEl(t),
    getElementById: (id) => queryTree(body, '#' + id)[0] || null,
    addEventListener() {}, removeEventListener() {},
    execCommand: () => execOk,
    querySelector(sel) { return queryTree(body, sel)[0] || null; },
  };
  let captured = null;
  const fetchCalls = [];
  // canAutoInstall=false：新方案必须不再依赖这个门槛（未知平台也有出口）
  const tunnel = { executable: 'missing', state: 'stopped', canAutoInstall: false, dnsOk: true, provisioned: false };
  const copied = [];

  const sandbox = {
    window: { matchMedia: () => ({ matches: false }), __ModuleLoader__: { load(mod) { captured = mod; } } },
    document: documentStub,
    navigator: {
      clipboard: {
        writeText: async (t) => {
          if (clipboardFails) throw new Error('clipboard unavailable');
          copied.push(t);
        },
      },
    },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout,
    // 面板自身有 summary 轮询定时器；测试里挂起而不真跑，避免进程不退出
    setInterval: () => 0, clearInterval: () => {},
    AbortController, AbortSignal,
    fetch: async (url, opts) => {
      const method = opts?.method || 'GET';
      fetchCalls.push({ url, method, body: opts?.body });
      if (url.includes('/health')) return { ok: true, json: async () => ({ ok: true }) };
      if (url.includes('/mobile/v1/clipboard')) {
        // 复制一级走网关写系统剪贴板；失败场景让所有一级都失败，逼出降级链
        if (clipboardFails) return { ok: false, status: 500, json: async () => ({ ok: false, error: { message: 'unavailable' } }) };
        return { ok: true, json: async () => ({ ok: true, tool: 'pbcopy' }) };
      }
      if (url.includes('/summary')) {
        return { ok: true, json: async () => ({ ok: true, version: '0.3.2', tunnel: { ...tunnel } }) };
      }
      if (url.includes('tunnel/start')) {
        tunnel.state = 'running';
        return { ok: true, json: async () => ({ ok: true, state: 'running', url: 'https://example.trycloudflare.com' }) };
      }
      return { ok: true, json: async () => ({ ok: true, code: 'PAIR123', url: 'https://example' }) };
    },
    crypto: { randomUUID: () => '11111111-2222-3333-4444-000000000001' },
    localStorage: (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    getComputedStyle: () => ({ backgroundColor: 'rgb(20,20,20)' }),
    require: (id) => id === 'react' ? {
      createElement: (tag, props, ...kids) => {
        const el = makeEl(tag);
        for (const [k, v] of Object.entries(props || {})) {
          if (k === 'onClick') el.addEventListener('click', v);
          else if (k === 'className') el.className = v;
          else if (k === 'style') el.style = { ...el.style, ...v };
          else el[k] = v;
        }
        for (const kid of kids) if (kid && kid.tagName) el.append(kid);
        return el;
      },
    } : {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  const mod = captured.factory(sandbox.require);

  let footerRender = null;
  let registeredEl = null;
  const ctx = {
    get: () => null,
    slots: {
      inject: (name, fn) => { footerRender = fn; return () => {}; },
      register: (cfg, renderFn) => { registeredEl = typeof renderFn === 'function' ? renderFn({ wide: true }) : null; return { dispose() {} }; },
    },
  };
  return {
    mod, ctx, body, documentStub, fetchCalls, tunnel, copied,
    markInstalled: () => { tunnel.executable = 'found'; },
    getTrigger: () => registeredEl,
    setFooter: () => footerRender?.({ wide: true }),
    actions: () => queryTree(body, '.modal-actions')[0]?.children || [],
    action: (label) => (queryTree(body, '.modal-actions')[0]?.children || []).find((b) => (b._text || '').includes(label)),
    promptEl: () => queryTree(body, '.modal-prompt')[0] || null,
    copyBtn: () => queryTree(body, '.modal-copy-btn')[0] || null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openInstallPrompt(h) {
  h.mod.apply(h.ctx);
  await sleep(200);
  h.setFooter();
  h.getTrigger()?.click();
  await sleep(60);
  h.documentStub.getElementById('dsh-mios-remote-main')?.click();
  await sleep(60);
}

console.log('\ncloudflared → Harness Agent 安装指令链路回归\n');

// 1. 缺依赖弹窗：文案、可复制指令、六平台官方地址、目标目录、Agent 引导
{
  const h = makeHarness();
  await openInstallPrompt(h);
  check('主按钮明确是「查看安装指引」', (h.documentStub.getElementById('dsh-mios-remote-main')?._text || '').includes('查看 cloudflared 安装指引'));
  check('弹出「需要安装 cloudflared」弹窗', allTexts(h.body).some((t) => t.includes('需要安装 cloudflared')));
  const ta = h.promptEl();
  check('弹窗内含可复制指令文本框', !!ta);
  check('指令文本框为只读', ta?.readOnly === true);
  check('指令文本框自动全选（复制失败也能手动 ⌘C）', ta?._selected === true && Array.isArray(ta?._range));
  const text = ta?.value || '';
  check('指令写明交给 DeepSeek Harness 桌面端 Agent', text.includes('DeepSeek Harness') || allTexts(h.body).some((t) => t.includes('DeepSeek Harness')));
  check('指令含 6 个平台官方地址', ['cloudflared-darwin-arm64.tgz', 'cloudflared-darwin-amd64.tgz', 'cloudflared-windows-amd64.exe', 'cloudflared-windows-386.exe', 'cloudflared-linux-amd64', 'cloudflared-linux-arm64'].every((f) => text.includes(`${DOWNLOAD_BASE}/${f}`)));
  check('指令含 macOS/Linux 目标目录', text.includes('~/.dsh/mobile-access/components/cloudflared/2026.11.1/cloudflared'));
  check('指令含 Windows 目标目录', text.includes('\\.dsh\\mobile-access\\components\\cloudflared\\2026.11.1\\cloudflared.exe'));
  check('指令含 --version 校验', text.includes('cloudflared --version'));
  check('指令含重开 Harness 让插件重新探测', text.includes('重启 DeepSeek Harness'));
  check('指令含验收标准', text.includes('【验收】'));
}

// 2. 关键：整条链路不再发起网关下载；复制走行内按钮 + 系统剪贴板端点
{
  const h = makeHarness();
  await openInstallPrompt(h);
  h.fetchCalls.length = 0;
  const btn = h.copyBtn();
  check('指令框右侧有行内复制按钮', !!btn);
  check('复制按钮不触发 install-cloudflared 下载', !h.fetchCalls.some((c) => c.url.includes('install-cloudflared')));
  btn?.click();
  await sleep(80);
  check('点击复制走网关系统剪贴板端点', h.fetchCalls.some((c) => c.url.includes('/mobile/v1/clipboard') && c.method === 'POST'));
  check('复制仍不触发 install-cloudflared 下载', !h.fetchCalls.some((c) => c.url.includes('install-cloudflared')));
  check('复制成功有可见提示', allTexts(h.body).some((t) => t.includes('已复制到剪贴板')));
  check('复制后弹窗仍保留指令框', !!h.promptEl());
  h.fetchCalls.length = 0;
  h.action('我装好了，继续')?.click();
  await sleep(60);
  check('未装好时点继续也不触发下载', !h.fetchCalls.some((c) => c.url.includes('install-cloudflared')));
}

// 3. 复制成功路径：剪贴板端点收到完整指令
{
  const h = makeHarness();
  await openInstallPrompt(h);
  h.copyBtn()?.click();
  await sleep(80);
  const clipCall = h.fetchCalls.find((c) => c.url.includes('/mobile/v1/clipboard'));
  check('剪贴板端点收到完整指令', clipCall?.body?.text === h.promptEl()?.value, JSON.stringify(clipCall?.body).slice(0, 120));
}

// 4. 复制全线失败：明确提示手动复制并补一个已全选的输入框，不演「点了没反应」
{
  const h = makeHarness({ clipboardFails: true });
  await openInstallPrompt(h);
  h.copyBtn()?.click();
  await sleep(120);
  check('复制失败明确提示手动复制', allTexts(h.body).some((t) => t.includes('按 Ctrl/⌘+C 即可')));
  const pick = queryTree(h.body, '.modal-pick')[0];
  check('复制失败补出手动输入框', !!pick);
  check('手动输入框内容是同一段指令', pick?.value === h.promptEl()?.value);
}

// 5. 装好后点「我装好了，继续」→ 先弹固定地址引导（新机器无凭据）→ 可选临时地址出码
{
  const h = makeHarness();
  await openInstallPrompt(h);
  h.markInstalled();
  h.fetchCalls.length = 0;
  h.action('我装好了，继续')?.click();
  await sleep(150);
  check('装好后弹固定地址引导（新机器无凭据）', allTexts(h.body).some((t) => t.includes('分配固定地址')));
  check('引导弹窗有「登录 Cloudflare」入口', allTexts(h.body).some((t) => t.includes('登录 Cloudflare')));
  check('引导阶段还没有出码', !h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
  const skip = h.action('先用临时地址出码');
  check('保留「先用临时地址出码」出口', !!skip);
  h.fetchCalls.length = 0;
  skip?.click();
  await sleep(150);
  check('选择临时地址后继续开启远程（tunnel/start）', h.fetchCalls.some((c) => c.url.includes('tunnel/start') && c.method === 'POST'));
  check('选择临时地址后不再重复引导', !allTexts(h.body).some((t) => t.includes('分配固定地址')));
}

// 6. 还没装就点继续：原地提示，既不关窗也不假装成功
{
  const h = makeHarness();
  await openInstallPrompt(h);
  h.fetchCalls.length = 0;
  h.action('我装好了，继续')?.click();
  await sleep(120);
  check('未装好时明确提示还没检测到', allTexts(h.body).some((t) => t.includes('还没检测到 cloudflared')));
  check('未装好时不关弹窗', !!h.promptEl());
  check('未装好时不出码', !h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
