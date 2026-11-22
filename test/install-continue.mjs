// test/install-continue.mjs — cloudflared 安装确认链路回归
//
// 用户诉求：点「安装 cloudflared 并开启远程」→ 确认后应有即时反馈，
// 下载期间显示**真实字节进度**，可取消并改手动安装，装完自动继续出码。
// 本套件用最小 DOM stub 走真实链路 apply→面板→主按钮→确认按钮，
// 可控 setInterval 逐步推进任务状态，不靠真等 1.2 秒。

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-windows-amd64.exe';
const TOTAL = 55483112;

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), children: [], className: '', _text: '',
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
    remove() { this._removed = true; const i = (this._parent?.children || []).indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] || ''; },
    select() {}, focus() {},
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
 * @param {boolean} [opts.installFails]     任务失败
 * @param {boolean} [opts.alreadyInstalled] 服务端直接复用（不下载）
 * @param {Array}   [opts.steps]            GET 依次返回的任务状态
 */
function makeHarness({ installFails = false, alreadyInstalled = false, steps = null } = {}) {
  const body = makeEl('body');
  const documentStub = {
    body, head: makeEl('head'), documentElement: makeEl('html'),
    createElement: (t) => makeEl(t),
    getElementById: (id) => queryTree(body, '#' + id)[0] || null,
    addEventListener() {}, removeEventListener() {}, execCommand: () => true,
    querySelector(sel) { return queryTree(body, sel)[0] || null; },
  };
  let captured = null;
  const fetchCalls = [];
  const intervals = [];
  const tunnel = { executable: 'missing', state: 'stopped', canAutoInstall: true, dnsOk: true, provisioned: false };
  let canceled = false;
  const queue = steps
    ? [...steps]
    : [
      { state: 'running', loaded: 5 * 1048576, total: TOTAL, percent: 9 },
      { state: 'running', loaded: 28 * 1048576, total: TOTAL, percent: 52 },
      { state: 'done', loaded: TOTAL, total: TOTAL, percent: 100 },
    ];

  const sandbox = {
    window: { matchMedia: () => ({ matches: false }), __ModuleLoader__: { load(mod) { captured = mod; } } },
    document: documentStub,
    navigator: { clipboard: { writeText: async () => {} } },
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout, clearTimeout,
    // 轮询定时器交给测试手动 tick，避免测试真的等 1.2 秒
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    AbortController, AbortSignal,
    fetch: async (url, opts) => {
      const method = opts?.method || 'GET';
      fetchCalls.push({ url, method });
      if (url.includes('/health')) return { ok: true, json: async () => ({ ok: true }) };
      if (url.includes('/install-cloudflared/cancel')) {
        canceled = true;
        return { ok: true, json: async () => ({ ok: true, canceled: true }) };
      }
      if (url.includes('install-cloudflared') && method === 'POST') {
        // 失败发生在下载任务里（超时），不是启动请求：这才是 0.3.0 的真实链路。
        if (alreadyInstalled) {
          tunnel.executable = 'found';
          return { ok: true, json: async () => ({ ok: true, installed: true, reused: true, executable: 'x', downloadUrl: DOWNLOAD_URL }) };
        }
        return { ok: true, json: async () => ({ ok: true, started: true, jobId: 'job-1', downloadUrl: DOWNLOAD_URL }) };
      }
      if (url.includes('install-cloudflared') && method === 'GET') {
        const st = canceled
          ? { state: 'canceled', error: { code: 'DOWNLOAD_CANCELLED', message: '已取消下载' } }
          : installFails
            ? { state: 'failed', error: { code: 'DOWNLOAD_TIMEOUT', message: '下载超时（国内访问 GitHub 较慢）' } }
            : (queue.shift() || { state: 'running', loaded: 0, total: TOTAL, percent: 0 });
        if (st.state === 'done') tunnel.executable = 'found';
        return { ok: true, json: async () => ({ ok: true, ...st, downloadUrl: DOWNLOAD_URL }) };
      }
      if (url.includes('tunnel/start')) {
        tunnel.state = 'running';
        return { ok: true, json: async () => ({ ok: true, state: 'running', url: 'https://example.trycloudflare.com' }) };
      }
      if (url.includes('/summary')) {
        return { ok: true, json: async () => ({ ok: true, version: '0.3.0', tunnel: { ...tunnel, downloadUrl: DOWNLOAD_URL } }) };
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
    mod, ctx, body, documentStub, fetchCalls, tunnel,
    getTrigger: () => registeredEl,
    setFooter: () => footerRender?.({ wide: true }),
    // 手动推进一次轮询；轮询内部 await fetch，故这里也要等一个微任务
    tick: async () => { for (const fn of intervals) await fn(); await sleep(10); },
  };
}

/** 打开面板并点到安装确认弹窗，返回确认按钮 */
async function openInstallConfirm(h) {
  h.mod.apply(h.ctx);
  await sleep(250);
  h.setFooter();
  h.getTrigger()?.click();
  await sleep(80);
  const mainBtn = h.documentStub.getElementById('dsh-mios-remote-main');
  mainBtn?.click();
  await sleep(40);
  return queryTree(h.body, '.modal-actions')[0]?.children?.find((b) => (b._text || '').includes('确认下载并安装'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\ncloudflared 安装确认链路回归\n');

// 1. 进度链路：确认前给地址 → 确认后真实进度 → 完成后自动继续出码
{
  const h = makeHarness();
  const confirm = await openInstallConfirm(h);
  check('缺依赖时主按钮显示安装文案', (h.documentStub.getElementById('dsh-mios-remote-main')?._text || '').includes('安装 cloudflared'));
  check('弹出安装确认框', !!confirm);
  check('确认前弹窗给出官方下载地址', allTexts(h.body).some((t) => t.includes('releases/download/2026.11.1')));
  h.fetchCalls.length = 0;
  confirm?.click();
  await sleep(80);
  check('确认后发出安装请求', h.fetchCalls.some((c) => c.url.includes('install-cloudflared') && c.method === 'POST'));
  check('下载弹窗显示进度条', !!queryTree(h.body, '.modal-progress')[0]);
  check('下载弹窗提供取消出口', allTexts(h.body).some((t) => t.includes('取消并改手动安装')));
  check('下载弹窗给出官方地址', allTexts(h.body).some((t) => t.includes('releases/download/2026.11.1')));
  await h.tick();
  check('第 1 次轮询显示真实字节进度（9%）', allTexts(h.body).some((t) => t.includes('9%')));
  await h.tick();
  check('第 2 次轮询进度递进（52%）', allTexts(h.body).some((t) => t.includes('52%')));
  check('进度中未提前出码', !h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
  await h.tick();
  check('下载完成弹窗出现', allTexts(h.body).some((t) => t.includes('安装完成')));
  await sleep(1200);
  check('安装成功后自动继续开启远程（tunnel/start）', h.fetchCalls.some((c) => c.url.includes('tunnel/start') && c.method === 'POST'));
}

// 2. 失败路径：失败弹窗带下载地址与手动步骤，不触发自动继续
{
  const h = makeHarness({ installFails: true });
  const confirm = await openInstallConfirm(h);
  h.fetchCalls.length = 0;
  confirm?.click();
  await sleep(80);
  await h.tick();
  check('失败时显示失败弹窗', allTexts(h.body).some((t) => t.includes('安装失败')));
  check('失败说明写明下载超时', allTexts(h.body).some((t) => t.includes('下载超时')));
  check('失败弹窗带官方下载地址', allTexts(h.body).some((t) => t.includes('releases/download/2026.11.1')));
  check('失败弹窗带手动安装目录', allTexts(h.body).some((t) => t.includes('components\\cloudflared\\2026.11.1')));
  check('失败时提供重试入口', allTexts(h.body).some((t) => t.includes('重试安装')));
  check('失败时不自动开启远程', !h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
}

// 3. 慢下载：进度持续可见，不因耗时长而消失
{
  const slowSteps = Array.from({ length: 6 }, (_, i) => ({
    state: 'running', loaded: (i + 1) * 5 * 1048576, total: TOTAL, percent: (i + 1) * 9,
  })).concat([{ state: 'done', loaded: TOTAL, total: TOTAL, percent: 100 }]);
  const h = makeHarness({ steps: slowSteps });
  const confirm = await openInstallConfirm(h);
  confirm?.click();
  await sleep(80);
  for (let i = 0; i < 4; i += 1) {
    await h.tick();
    check(`慢下载第 ${i + 1} 次轮询仍在安装中`, allTexts(h.body).some((t) => t.includes('正在安装')));
  }
  check('慢下载期间进度已更新', allTexts(h.body).some((t) => t.includes('36%')));
  check('慢下载期间没有自动出码', !h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
  for (let i = 0; i < 3; i += 1) await h.tick();
  await sleep(1200);
  check('慢下载完成后仍能自动继续', h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
}

// 4. 取消：点「取消并改手动安装」→ 发取消请求 → 给手动指引 → 不出码
{
  const h = makeHarness();
  const confirm = await openInstallConfirm(h);
  h.fetchCalls.length = 0;
  confirm?.click();
  await sleep(80);
  await h.tick();
  const cancelBtn = queryTree(h.body, '.modal-actions')[0]?.children?.find((b) => (b._text || '').includes('取消并改手动安装'));
  check('下载中存在取消按钮', !!cancelBtn);
  cancelBtn?.click();
  await sleep(150);
  check('取消请求已发出', h.fetchCalls.some((c) => c.url.includes('/install-cloudflared/cancel') && c.method === 'POST'));
  check('取消后明确提示未安装', allTexts(h.body).some((t) => t.includes('已取消安装')));
  check('取消后仍给官方地址', allTexts(h.body).some((t) => t.includes('releases/download/2026.11.1')));
  check('取消后给出手动安装步骤', allTexts(h.body).some((t) => t.includes('重开桌面端面板')));
  check('取消后不自动出码', !h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
}

// 5. 复用：服务端说已装好，跳过进度直接继续（兼容旧同步语义）
{
  const h = makeHarness({ alreadyInstalled: true });
  const confirm = await openInstallConfirm(h);
  h.fetchCalls.length = 0;
  confirm?.click();
  await sleep(100);
  check('复用时直接显示安装完成', allTexts(h.body).some((t) => t.includes('安装完成')));
  check('复用时不进入下载进度', !queryTree(h.body, '.modal-progress')[0]);
  await sleep(1200);
  check('复用后仍能自动继续出码', h.fetchCalls.some((c) => c.url.includes('tunnel/start')));
}

console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
if (failures.length) process.exit(1);
