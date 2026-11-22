// lib/client.js — 桌面端 UI 注入模块（X3）
//
// 契约（考古自社区 dsh-mobile 0.8.11 的 lib/client.js）：
//   宿主 web app 按包的 `exports["./client"]` 加载本文件，浏览器里执行到
//   `window.__ModuleLoader__.load({ id, factory })` 注册模块；
//   factory 返回的模块需导出 `apply(ctx)` 与 `inject = ["slots"]`，
//   宿主把 slots 服务注入进来，UI 通过 slots 挂载。
//
// 我们挂两个东西：
//   1. 左下角侧栏 banner（slot: sidebar.footer.action）——手机图标 + 「iOS移动伴侣」
//      + 连接状态点；窄栏（rail）只留图标。
//   2. 点击展开的状态面板（原生 DOM overlay，宿主未提供 react-dom）——
//      网关状态 / 适配器 / 已配对设备 / 隧道 / 生成配对码。
//
// 如实边界：网关端口被占会自动顺延（3081–3085 探测）；面板数据来自
// /mobile/v1/desktop/summary（回环-only，无敏感字段），拿不到就明确显示
// 「网关不可达」，绝不编造状态。
window.__ModuleLoader__.load({
	id: 'dsh-mobile-ios',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let react = require('react');

		// ── 状态 ─────────────────────────────────────────────────────
		const PORT_CANDIDATES = [3081, 3082, 3083, 3084, 3085];
		let gatewayPort = null;
		let summary = null;        // /desktop/summary 结果或 null
		let probing = false;

		function baseUrl() {
			return gatewayPort ? `http://127.0.0.1:${gatewayPort}` : null;
		}

		async function fetchJson(path, options, timeoutMs = 1500) {
			const base = baseUrl();
			if (!base) throw new Error('gateway-not-found');
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await fetch(base + path, { ...options, signal: controller.signal });
				const body = await res.json();
				if (!res.ok) throw Object.assign(new Error(body?.error?.message || res.statusText), { body });
				return body;
			} finally {
				clearTimeout(timer);
			}
		}

		/** 探测网关端口（顺延容忍），成功后拉一次摘要 */
		async function probe() {
			if (probing) return;
			probing = true;
			try {
				let found = null;
				for (const port of PORT_CANDIDATES) {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), 700);
					try {
						const res = await fetch(`http://127.0.0.1:${port}/mobile/v1/health`, { signal: controller.signal });
						if (res.ok) { found = port; break; }
					} catch {} // 端口不是我们/没起，继续探
					finally { clearTimeout(timer); }
				}
				// 必须跟着探到的结果走：只在成功时赋值、失败时清空。
				// 以前失败会保留旧端口，网关换端口后一直去敲那个死端口（若被别的服务
				// 占用还会解析出非 JSON），面板就一直红着。
				gatewayPort = found;
				if (gatewayPort) summary = await fetchJson('/mobile/v1/desktop/summary').catch(() => null);
				else summary = null;
			} finally {
				probing = false;
			}
		}

		/** 面板打开时的轻量刷新：端口已经探到，只拉摘要并重绘，不再重复扫端口。 */
		async function refreshSummary() {
			if (!gatewayPort || summaryFetching) return;
			summaryFetching = true;
			try {
				const next = await fetchJson('/mobile/v1/desktop/summary').catch(() => null);
				if (next?.ok) {
					summary = next;
					renderSummary();
				}
			} finally {
				summaryFetching = false;
			}
		}

		/**
		 * 首屏快速补探。
		 *
		 * 宿主重启时插件先于网关绑端口加载，第一次探测必然落空；
		 * 只靠 15 秒轮询会让面板红着不动，用户看到的就是「插件坏了」。
		 */
		async function probeUntilUp(attempts = 5, delayMs = 1200) {
			for (let i = 0; i < attempts; i += 1) {
				await probe();
				if (summary && summary.ok) return;
				if (i < attempts - 1) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
			}
		}

		/** 生成配对码（本机动作，回环-only 端点）。route 显式选路：'lan' | 'tunnel' | undefined=自动 */
		async function issuePairingCode(route) {
			return fetchJson('/mobile/v1/pairing/code', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceName: '待连接设备', ...(route ? { route } : {}) }),
			}, 2500);
		}

		/** 隧道启停（本机管理面动作，回环-only 端点） */
		/** 单台下线：管理面动作，与出码同样的本机约束，绝不走公网域名。 */
		async function revokeDevice(deviceId) {
			return fetchJson('/mobile/v1/pairing/revoke-device', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceId }),
			}, 2500);
		}

		async function tunnelAction(action) {
			// start 首次会顺带「开通固定地址 + 等公网注册 + DNS 复查」，实测经常超过 20s；
			// 以前 20s 就掐断，用户点第一次报错、点第二次才出码——就是这里太短。
			return fetchJson(`/mobile/v1/tunnel/${action}`, { method: 'POST' }, action === 'start' ? 60000 : 25000);
		}

		// ── 样式 ─────────────────────────────────────────────────────
		const STYLE_ID = 'dsh-mios-style';
		function installStyle() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement('style');
			style.id = STYLE_ID;
			// 主题跟随宿主：颜色全部走 CSS 变量，.light 类由 detectHostTheme() 动态切换。
			// 以前全硬编码深色，宿主开浅色主题时面板像一块黑补丁（2026-11-18 真机反馈）。
			style.textContent = `
.dsh-mios-trigger { display: inline-flex; align-items: center; gap: 7px; background: none;
  border: none; color: inherit; cursor: pointer; padding: 6px 8px; border-radius: 8px;
  font: inherit; line-height: 1; }
.dsh-mios-trigger:hover { background: rgba(255,255,255,.08); }
.dsh-mios-trigger.is-rail { padding: 8px; }
.dsh-mios-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dsh-mios-dot.ok { background: #3fb27f; }
.dsh-mios-dot.down { background: #d94f3d; }
.dsh-mios-panel { --bg: #171b24; --fg: #e8eaf0; --muted: #8b93a3; --border: #303a52;
  --border-hover: #4a5678; --shadow: rgba(0,0,0,.5); --fg-soft: rgba(232,234,240,.7);
  --muted-border: rgba(139,147,163,.45); --muted-bg: rgba(139,147,163,.12);
  --muted-bg-hover: rgba(139,147,163,.2); }
.dsh-mios-panel.light { --bg: #ffffff; --fg: #1f2430; --muted: #6b7280; --border: #d9dee8;
  --border-hover: #9aa5bd; --shadow: rgba(31,36,48,.18); --fg-soft: rgba(31,36,48,.7);
  --muted-border: rgba(107,114,128,.4); --muted-bg: rgba(107,114,128,.1);
  --muted-bg-hover: rgba(107,114,128,.18); }
.dsh-mios-panel { position: fixed; left: 14px; bottom: 52px; width: 300px; z-index: 99990;
  background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 14px 44px var(--shadow); font: 13px/1.6 -apple-system, "PingFang SC", sans-serif;
  padding: 14px; }
.dsh-mios-panel h3 { margin: 0 0 10px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.dsh-mios-upd { margin-left: auto; background: none; border: 1px solid var(--border); border-radius: 7px;
  color: var(--muted); font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1.4;
  cursor: pointer; padding: 3px 8px; }
.dsh-mios-upd:hover { color: var(--fg); border-color: var(--border-hover); }
.dsh-mios-modal-mask { --modal-bg:#1c2230; --modal-fg:#e8eaf0; --modal-muted:#8b93a3;
  --modal-border:#3a4560; --modal-btn:rgba(139,147,163,.12); --modal-accent:#3fb27f; --modal-shadow:rgba(0,0,0,.6);
  position:fixed; inset:0; z-index:2147483000; background:var(--modal-shadow);
  display:flex; align-items:center; justify-content:center; padding:20px;
  font-family:-apple-system, "PingFang SC", sans-serif; font-size:13px; line-height:1.6; }
.dsh-mios-modal-mask.light { --modal-bg:#ffffff; --modal-fg:#1f2430; --modal-muted:#6b7280;
  --modal-border:#d9dee8; --modal-btn:rgba(107,114,128,.1); --modal-accent:#2f9d70; --modal-shadow:rgba(31,36,48,.35); }
.dsh-mios-modal { width:100%; max-width:340px; box-sizing:border-box; background:var(--modal-bg);
  color:var(--modal-fg); border:1px solid var(--modal-border); border-radius:14px; padding:18px;
  box-shadow:0 18px 60px var(--modal-shadow); }
.dsh-mios-modal h4 { margin:0 0 12px; font-size:15px; display:flex; align-items:center; gap:8px; }
.dsh-mios-modal .modal-banner { margin:0 0 12px; padding:9px 11px; border-radius:9px; font-size:12px;
  font-weight:600; line-height:1.5; background:rgba(63,178,127,.12); color:var(--modal-accent);
  border:1px solid var(--modal-accent); }
.dsh-mios-modal .modal-banner.success { background:rgba(63,178,127,.16); color:#2f9d70; }
.dsh-mios-modal .modal-banner.warn { background:rgba(224,160,60,.14); color:#d18a26; border-color:#d18a26; }
.dsh-mios-modal .modal-banner.error { background:rgba(217,79,61,.14); color:#d94f3d; border-color:#d94f3d; }
.dsh-mios-modal .modal-x { margin-left:auto; background:none; border:none; color:var(--modal-muted);
  font-size:16px; cursor:pointer; line-height:1; padding:2px 4px; }
.dsh-mios-modal .modal-line { display:flex; justify-content:space-between; gap:10px;
  font-size:12px; color:var(--modal-muted); margin:6px 0; }
.dsh-mios-modal .modal-line b { color:var(--modal-fg); font-weight:600; max-width:200px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-mios-modal .modal-line b.new { color:var(--modal-accent); }
.dsh-mios-modal .modal-note { margin:12px 0 4px; font-size:11px; color:var(--modal-muted); line-height:1.6; }
.dsh-mios-modal .modal-actions { display:flex; gap:8px; margin-top:14px; }
.dsh-mios-modal .modal-actions button { flex:1; padding:8px 0; border-radius:8px; cursor:pointer;
  font-family:inherit; font-size:12px; font-weight:600; line-height:1.4;
  border:1px solid var(--modal-border); background:var(--modal-btn); color:var(--modal-fg); }
.dsh-mios-modal .modal-actions button.primary { border-color:var(--modal-accent);
  background:rgba(63,178,127,.16); color:var(--modal-accent); }
.dsh-mios-modal .modal-actions button:disabled { opacity:.6; cursor:default; }
/* 兜底文字链（重置本机状态之类）：不抢主按钮的位置，但要能看见、能点 */
.dsh-mios-modal .modal-link { display:block; width:100%; margin:10px 0 0; padding:2px 0;
  background:none; border:none; color:var(--modal-muted); font-family:inherit; font-size:11px;
  text-align:left; text-decoration:underline; cursor:pointer; }
.dsh-mios-modal .modal-link:hover { color:var(--modal-fg); }
/* 复制结果必须看得见：dsh-app:// 页面里剪贴板可能不可用，只改按钮文字容易被无视。
   .modal-toast 常驻在动作条上方，成功/失败都留痕。 */
.dsh-mios-modal .modal-toast { margin:10px 0 0; padding:7px 10px; border-radius:8px; font-size:11px;
  font-weight:600; line-height:1.5; background:rgba(139,147,163,.14); color:var(--modal-muted); }
.dsh-mios-modal .modal-toast.success { background:rgba(63,178,127,.16); color:#2f9d70; }
.dsh-mios-modal .modal-toast.error { background:rgba(217,79,61,.14); color:#d94f3d; }
/* 复制全线失败时的兜底：给一个已自动全选的输入框，用户 Ctrl/⌘+C 就能拿走 */
.dsh-mios-modal .modal-pick { width:100%; box-sizing:border-box; margin:10px 0 0; padding:8px 10px;
  border-radius:8px; border:1px solid var(--modal-accent); background:rgba(63,178,127,.10);
  color:var(--modal-fg); font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px;
  user-select:text; -webkit-user-select:text; }
/* 交给 Harness Agent 的安装指令：一个自动全选的多行文本框。按钮再出问题，
   用户直接 ⌘C/Ctrl+C 也能拿走——复制这件事不能只押在 JS 剪贴板 API 上。 */
.dsh-mios-modal .modal-prompt { display:block; width:100%; box-sizing:border-box; margin:12px 0 0;
  padding:10px 11px; min-height:150px; max-height:280px; resize:vertical;
  border-radius:8px; border:1px solid var(--modal-accent); background:rgba(63,178,127,.08);
  color:var(--modal-fg); font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size:11px; line-height:1.6; user-select:text; -webkit-user-select:text; }
.dsh-mios-modal .modal-steps { margin:10px 0 0; padding-left:18px; font-size:11px;
  color:var(--modal-muted); line-height:1.7; }
.dsh-mios-modal .modal-steps li { margin:2px 0; }
/* 下载进度必须是真实字节进度：慢网络下「正在安装」四个字等于假死。 */
.dsh-mios-modal .modal-progress { margin:12px 0 2px; }
.dsh-mios-modal .modal-progress-bar { height:8px; border-radius:6px; overflow:hidden;
  background:var(--modal-btn); border:1px solid var(--modal-border); }
.dsh-mios-modal .modal-progress-fill { height:100%; width:0; background:var(--modal-accent);
  transition:width .25s linear; }
.dsh-mios-modal .modal-progress-label { margin-top:6px; font-size:11px; color:var(--modal-muted);
  font-variant-numeric:tabular-nums; }
.dsh-mios-panel .row { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); margin: 3px 0; }
.dsh-mios-panel .row b { color: var(--fg); font-weight: 600; text-align: right; max-width: 170px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mios-device-toggle { background: none; border: none; color: var(--muted); cursor: pointer;
  font: inherit; padding: 0; display: inline-flex; align-items: center; gap: 5px; }
.dsh-mios-device-toggle:hover { color: var(--fg); }
.dsh-mios-devices { margin: 2px 0 6px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.dsh-mios-devices[hidden] { display: none; }
.dsh-mios-device-row { display: flex; align-items: center; gap: 8px; padding: 5px 10px;
  font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); }
.dsh-mios-device-row:first-child { border-top: none; }
.dsh-mios-device-name { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: normal;
  line-height: 1.35; color: var(--fg); }
.dsh-mios-device-online { color: #3fb27f; flex: none; }
.dsh-mios-device-offline { color: var(--muted); flex: none; }
.dsh-mios-device-kick { margin-left: auto; background: none; border: 1px solid rgba(217,79,61,.4); border-radius: 4px;
  color: #c97a6d; cursor: pointer; font-family: inherit; font-size: 9px; font-weight: 500;
  line-height: 1.3; padding: 1px 5px; flex: none; }
.dsh-mios-device-kick:hover { color: #d94f3d; border-color: rgba(217,79,61,.7); }
.dsh-mios-devices-empty { padding: 6px 8px; font-size: 11px; color: var(--muted); }
.dsh-mios-panel .pairbtn { width: 100%; margin-top: 10px; padding: 8px 0; border-radius: 9px;
  border: 1px solid rgba(63,178,127,.45); background: rgba(63,178,127,.14); color: #3fb27f;
  font: 600 13px/1.4 inherit-font, sans-serif; cursor: pointer; }
.dsh-mios-panel .pairbtn:disabled { opacity: .5; cursor: default; }
.dsh-mios-banner { border: 1px solid var(--border); border-radius: 10px; padding: 10px 10px 11px; margin-top: 10px; }
.dsh-mios-banner h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--fg);
  display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.dsh-mios-banner .banner-state { font-size: 11px; font-weight: 400; color: var(--muted);
  max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mios-banner .banner-guide { margin-top: 4px; font-size: 11px; color: var(--muted); line-height: 1.5; }
.dsh-mios-banner .banner-addr { margin-top: 4px; font-size: 11px; color: var(--muted);
  font-family: ui-monospace, "SF Mono", Menlo, monospace; word-break: break-all; line-height: 1.5; }
.dsh-mios-banner .pairbtn { margin-top: 8px; }
.dsh-mios-banner .tunnelbtn { border-color: var(--muted-border); background: var(--muted-bg); color: var(--muted); }
.dsh-mios-banner .tunnelbtn:hover:not(:disabled) { border-color: var(--fg-soft); color: var(--fg); background: var(--muted-bg-hover); }
.dsh-mios-banner .tunnelbtn:disabled { opacity: .5; cursor: default; }
.dsh-mios-banner .stopbtn { margin-top: 6px; padding: 5px 0; font-weight: 500;
  border-color: rgba(217,79,61,.4); background: none; color: #c97a6d; }
.dsh-mios-banner .stopbtn:hover:not(:disabled) { border-color: rgba(217,79,61,.7); color: #d94f3d; }
.dsh-mios-panel .code { margin-top: 10px; text-align: center; font-size: 30px; letter-spacing: 8px;
  font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; }
.dsh-mios-qr { margin-top: 10px; padding: 10px; background: #fff; border-radius: 10px;
  display: flex; justify-content: center; }
.dsh-mios-qr svg { width: 180px; height: 180px; display: block; }
.dsh-mios-panel .err { margin-top: 10px; font-size: 12px; color: #d94f3d; text-align: center; }
.dsh-mios-panel footer { margin-top: 10px; font-size: 11px; color: var(--muted); text-align: center; }
.dsh-mios-close { margin-left: auto; background: none; border: none; color: var(--muted);
  font-size: 16px; cursor: pointer; padding: 2px 6px; }
`;
			document.head.append(style);
		}

		// ── 面板（原生 DOM；宿主无 react-dom） ───────────────────────
		// 双 banner 布局：上面「局域网连接」，下面「远程通道连接」。
		// 远程 banner 是合并后的单一主按钮：没开过→开通；开过没跑→开启并出码；
		// 跑着→直接出码。停止远程是旁边的小按钮，只在该停的时候出现。
		const PANEL_TITLE = 'DSH iOS移动伴侣';
		const BANNER_LABEL = '📱 iOS移动伴侣';
		// 插件更新检查：读 npm registry 的 latest（与「添加插件」安装源同源）。
		// npm 官方源带 CORS *，桌面端 webview 可直接 fetch；npmmirror 作国内备用。
		const PLUGIN_NAME = 'dsh-mobile-ios';
		const PLUGIN_REGISTRIES = [
			'https://registry.npmjs.org',
			'https://registry.npmmirror.com',
		];
		const stripUrl = (u) => String(u || '').replace(/^https?:\/\//, '');
		const stripLocal = (h) => String(h || '').replace(/\.local$/i, '');

		// 宿主插件管理服务（remote.pluginManager）。注入模块经 apply 拿到；
		// 非 Desktop 或老宿主拿不到时保持 null，更新入口降级为「复制包名」手动安装。
		let pluginManager = null;
		let updateInFlight = false; // 一步更新的并发锁：更新中禁止再次触发
		let panelEl = null;
		let tunnelBusy = false;
		const bannerBusy = { lan: false, remote: false };
		let outsideCloser = null;
		let devicesExpanded = false;
		let kickingDeviceId = null;
		// 面板打开期间的摘要刷新：probe() 只更新数据不重绘，正是「扫码后要关掉重开才更新」的根因。
		let summaryPollTimer = null;
		let summaryFetching = false;
		let lastDeviceSignature = null;

		/** 探测宿主主题：显式标记（class/data-theme）→ body 亮度启发 → 系统偏好。
		 *  Electron 宿主切换主题只改页面 class，matchMedia 不一定跟着变，所以三级都查。 */
		function detectHostTheme() {
			const root = document.documentElement;
			const body = document.body;
			const marked = `${root.className} ${body?.className || ''} ${root.getAttribute('data-theme') || ''} ${body?.getAttribute('data-theme') || ''} ${root.getAttribute('data-color-mode') || ''}`.toLowerCase();
			if (/\bdark\b/.test(marked)) return 'dark';
			if (/\blight\b/.test(marked)) return 'light';
			// 亮度启发：宿主页面底色亮就是浅色主题（面板挂在这个页面上，跟它一致最直观）。
			// 全黑或全透明底色不可判，落到系统偏好。
			const bgc = body ? getComputedStyle(body).backgroundColor
				: getComputedStyle(root).backgroundColor;
			const m = bgc.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
			if (m && (+m[1] + +m[2] + +m[3]) > 0) {
				return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) > 140 ? 'light' : 'dark';
			}
			return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
		}

		/** 面板主题实时跟随宿主：每次渲染都重判（用户可能中途切主题）。 */
		function applyPanelTheme() {
			if (!panelEl) return;
			panelEl.classList.toggle('light', detectHostTheme() === 'light');
		}

		function removePanel() {
			panelEl?.remove();
			panelEl = null;
			closeUpdateModal();
			if (summaryPollTimer) {
				clearInterval(summaryPollTimer);
				summaryPollTimer = null;
			}
			lastDeviceSignature = null;
			if (outsideCloser) {
				document.removeEventListener('pointerdown', outsideCloser);
				outsideCloser = null;
			}
		}

		function row(label, valueId) {
			const div = document.createElement('div');
			div.className = 'row';
			const l = document.createElement('span');
			l.textContent = label;
			const v = document.createElement('b');
			v.id = valueId;
			v.textContent = '—';
			div.append(l, v);
			return div;
		}

		/** 「同时在线设备」行：标签可点开展开在线设备清单，右侧显示 在线/上限。 */
		function deviceRows() {
			const wrap = document.createElement('div');
			const head = document.createElement('div');
			head.className = 'row';
			const toggle = document.createElement('button');
			toggle.className = 'dsh-mios-device-toggle';
			toggle.id = 'dsh-mios-device-toggle';
			toggle.type = 'button';
			toggle.textContent = '▸';
			toggle.setAttribute('aria-label', '展开或收起当前在线设备清单');
			const label = document.createElement('span');
			label.textContent = '同时在线设备(最多5台)';
			const left = document.createElement('span');
			left.append(toggle, label);
			const value = document.createElement('b');
			value.id = 'dsh-mios-devices';
			value.textContent = '—';
			head.append(left, value);
			toggle.addEventListener('click', () => {
				devicesExpanded = !devicesExpanded;
				renderDeviceList();
			});
			const list = document.createElement('div');
			list.className = 'dsh-mios-devices';
			list.id = 'dsh-mios-devices-list';
			list.hidden = true;
			wrap.append(head, list);
			return wrap;
		}

		/** 在线设备清单：默认折叠；只列当前在线设备（同时在线上限 5 台），下线逐台二次确认。 */
		function renderDeviceList() {
			const box = panelEl?.querySelector('#dsh-mios-devices-list');
			if (!box) return;
			box.hidden = !devicesExpanded;
			const toggle = panelEl.querySelector('#dsh-mios-device-toggle');
			if (toggle) toggle.textContent = devicesExpanded ? '▾' : '▸';
			box.replaceChildren();
			if (!summary?.ok) return;
			// 后端已限制活跃设备上限；这里再按在线态筛选并截到 5，保证面板只展示真实并发连接。
			const devices = (summary.pairing?.devices || []).filter((d) => d.online).slice(0, 5);
			if (!devices.length) {
				const empty = document.createElement('div');
				empty.className = 'dsh-mios-devices-empty';
				empty.textContent = '当前没有在线设备';
				box.append(empty);
				return;
			}
			for (const device of devices) {
				const line = document.createElement('div');
				line.className = 'dsh-mios-device-row';
				const name = document.createElement('span');
				name.className = 'dsh-mios-device-name';
				name.textContent = device.deviceName || '未命名设备';
				name.title = name.textContent;
				const state = document.createElement('span');
				state.className = device.online ? 'dsh-mios-device-online' : 'dsh-mios-device-offline';
				state.textContent = device.online ? '在线' : '离线';
				const kick = document.createElement('button');
				kick.className = 'dsh-mios-device-kick';
				kick.textContent = kickingDeviceId === device.deviceId ? '处理中' : '下线';
				kick.disabled = kickingDeviceId !== null;
				kick.title = `将 ${name.textContent} 从这台电脑移除`;
				kick.addEventListener('click', async () => {
					// 二次确认：下线会让那台手机立刻失去读任务的能力，不能误点。
					if (!window.confirm(`确定让「${name.textContent}」下线？该设备需要重新扫码才能再次连接。`)) return;
					kickingDeviceId = device.deviceId;
					renderDeviceList();
					try {
						await revokeDevice(device.deviceId);
						await probe();
					} catch (err) {
						window.alert('下线失败：' + (err?.body?.error?.message || err.message));
					} finally {
						kickingDeviceId = null;
						renderSummary();
					}
				});
				line.append(name, state, kick);
				box.append(line);
			}
		}

		function renderSummary() {
			if (!panelEl) return;
			applyPanelTheme();
			const dot = panelEl.querySelector('#dsh-mios-panel-dot');
			const ok = !!(summary && summary.ok);
			dot.className = 'dsh-mios-dot ' + (ok ? 'ok' : 'down');
			const set = (id, text) => { const el = panelEl.querySelector('#' + id); if (el) el.textContent = text; };
			set('dsh-mios-adapter', ok ? `v${summary.version}` : '—');
			set('dsh-mios-host', ok ? (stripLocal(summary.hostName) || '未上报') : '—');
			if (ok) {
				const max = summary.pairing?.maxDevices ?? 5;
				const online = summary.pairing?.onlineDevices ?? 0;
				set('dsh-mios-devices', `${online}/${max} 台`);
			} else {
				set('dsh-mios-devices', '—');
			}
			// 只有设备名/在线态/顺序变化才重建列表：1.2s 刷新不能让 hover 提示和下线按钮闪烁。
			const devices = ok ? (summary.pairing?.devices || []) : [];
			const signature = devices
				.map((d) => `${d.deviceId}\u0000${d.deviceName || ''}\u0000${d.online ? 1 : 0}`)
				.join('\u0001');
			if (signature !== lastDeviceSignature) {
				lastDeviceSignature = signature;
				renderDeviceList();
			}

			// ── 局域网 banner ──
			const lan = ok ? summary.lan : null;
			const lanState = panelEl.querySelector('#dsh-mios-lan-state');
			if (lanState) lanState.textContent = ok ? (lan ? `电脑地址 ${lan}` : '未获取到局域网地址') : '网关不可达';
			const lanCodeBtn = panelEl.querySelector('#dsh-mios-lan-code');
			if (lanCodeBtn) {
				lanCodeBtn.disabled = !ok || !lan || bannerBusy.lan;
				lanCodeBtn.title = ok && lan ? '' : '网关不可达或没有局域网地址';
			}

			// ── 远程通道 banner ──
			// 四种事实分开说：运行中 / 已开通但没开 / 根本没开通 / 域名没生效。
			// 「域名未生效」必须单列：地址开出来了但公网解析不到，显示「已开通」会误导人去扫码。
			const tunnel = ok ? summary.tunnel : null;
			const dnsBroken = tunnel && tunnel.dnsOk === false;
			// 解析失败已经归因到 zone 层时，别再用「解析异常」这种症状词：
			// moved 是归属冲突（改 NS 或换账号才能解），重探一万次也不会变。
			const zoneCode = tunnel?.zone?.code || null;
			// 「进程在跑」与「地址可用」是两件事：域名没生效时隧道进程可能已经起来了，
			// 但扫码必然连不上，所以 running 仍然要求 dnsOk 不为 false。
			const processUp = !!(tunnel && tunnel.state === 'running');
			const running = processUp && !dnsBroken;
			const remoteState = panelEl.querySelector('#dsh-mios-remote-state');
			if (remoteState) {
				remoteState.textContent = !tunnel
					? '—'
					: dnsBroken
						? (zoneCode === 'moved'
							? '域名归属冲突'
							: processUp ? '已开启 · 域名未生效' : '解析异常 · 未开启')
						: running
							? '已开启'
							: tunnel.provisioned && tunnel.fixedUrl
								? '已开通 · 未开启'
								: tunnel.mode === 'named' ? '未开通固定地址' : tunnel.state;
			}
			// 固定地址独占一行完整显示，不再和状态词挤在一起被省略号截断
			const remoteAddr = panelEl.querySelector('#dsh-mios-remote-addr');
			if (remoteAddr) {
				const addr = tunnel && (tunnel.fixedUrl || tunnel.url);
				remoteAddr.textContent = tunnel && tunnel.provisioned ? stripUrl(addr) : '—';
				// 默认色交给 CSS 变量（跟随主题）；只有解析异常时才覆盖成红色
				remoteAddr.style.color = dnsBroken ? '#d94f3d' : '';
			}
			const mainBtn = panelEl.querySelector('#dsh-mios-remote-main');
			if (mainBtn) {
				// 出码态走绿色主按钮；开启态走灰色次按钮（悬浮变白），视觉上分清两件事
				mainBtn.className = 'pairbtn' + (running || dnsBroken ? '' : ' tunnelbtn');
				mainBtn.style.display = tunnel && tunnel.state !== 'disabled' ? '' : 'none';
				// 关键：dnsBroken 不再禁用按钮。
				// 以前 disabled = ... || dnsBroken，而唯一的重探入口就在点击之后 ——
				// 按钮永远点不到，NS 改对了也不恢复，只能删状态文件（自锁死）。
				mainBtn.disabled = tunnelBusy || bannerBusy.remote;
				const needsInstall = tunnel.executable === 'missing';
				// 凭据确定不可用时先把「换账号登录」摆在前面：此刻点开启必然在写 DNS 处失败，
				// 直接给可执行的出口，比让人反复点一个注定失败的按钮有用。
				const credBlocked = Boolean(tunnel.credentials?.blocking) && !running && !needsInstall;
				mainBtn.textContent = needsInstall
					? '查看 cloudflared 安装指引'
					: credBlocked
						? '开启远程（需重新授权）'
						: dnsBroken
							? (zoneCode === 'moved' ? '查看原因（域名被占用）' : '重新检测域名解析')
							: running
								? (bannerBusy.remote ? '生成中…' : '生成配对码（远程）')
								: tunnel.mode === 'named'
									? (tunnel.provisioned ? '开启远程并生成配对码' : '开启远程（分配固定地址）')
									: '启动隧道（外网连接）';
			}
			const stopBtn = panelEl.querySelector('#dsh-mios-remote-stop');
			if (stopBtn) {
				// 停止按钮只在该停的时候出现：没开过/没在跑都没有「停」可言。
				// 域名未生效但进程在跑时仍要给「停止」——否则用户无法收尾。
				stopBtn.style.display = processUp && !tunnelBusy ? '' : 'none';
				stopBtn.disabled = tunnelBusy;
			}
			// 远程码跟着可用性走：不是 running 就收起（与「停止即收码」同一语义，
			// 兜住任何没经过停止按钮的路径，比如进程意外退出）。
			if (!running && !bannerBusy.remote) {
				panelEl.querySelector('#dsh-mios-remote-main')?.closest('.dsh-mios-banner')
					?.querySelectorAll('.dsh-mios-code-slot, .err').forEach((e) => e.remove());
			}

			// 提示行承载告警与错误：warning 优先，其次是 tunnel.error。
			// 以前只读 warning，服务端明确报的 error（如「主机未安装 cloudflared」）
			// 被 1.2s 一次的刷新瞬间清空，用户点了按钮只看到一闪而过、误以为「无反应」。
			const hint = panelEl.querySelector('#dsh-mios-hint');
			if (hint) {
				const t = ok ? summary.tunnel : null;
				// 凭据预检不通过是「确定写不了 DNS」：要在用户点按钮之前就说，
				// 而不是等他点了、写失败了，再看到一句 cloudflared 的命令回显。
				const credBlocked = t?.credentials?.blocking ? t.credentials : null;
				const msg = t?.warning || t?.error || credBlocked?.hint || null;
				hint.textContent = msg ? `⚠️ ${msg}` : '';
				hint.style.color = t?.error && !t?.warning ? '#d94f3d' : '#e0a03c';
				hint.style.display = msg ? '' : 'none';
			}
		}

		/** 双 banner 里的一块：标题 + 状态行 + 指引一句 + 内容区 */
		function bannerBox(title, stateId, guideText) {
			const box = document.createElement('div');
			box.className = 'dsh-mios-banner';
			const head = document.createElement('h4');
			head.textContent = title;
			const state = document.createElement('span');
			state.className = 'banner-state';
			state.id = stateId;
			state.textContent = '—';
			head.append(state);
			const guide = document.createElement('div');
			guide.className = 'banner-guide';
			guide.textContent = guideText;
			box.append(head, guide);
			return box;
		}

		/** 出码结果挂进所属 banner：QR + 码 + 地址说明（同一 banner 只保留最新一码） */
		function mountCode(banner, issued) {
			banner.querySelectorAll('.dsh-mios-code-slot').forEach((e) => e.remove());
			const slot = document.createElement('div');
			slot.className = 'dsh-mios-code-slot';
			if (issued.qrSvg) {
				const qr = document.createElement('div');
				qr.className = 'dsh-mios-qr';
				qr.innerHTML = issued.qrSvg;
				slot.append(qr);
			}
			const code = document.createElement('div');
			code.className = 'code';
			code.textContent = issued.code;
			const addr = document.createElement('div');
			addr.style.cssText = 'margin-top:6px;text-align:center;font-size:12px;color:#3fb27f;';
			addr.textContent = issued.route === 'tunnel'
				? `扫码连接 · 公网固定地址 ${stripUrl(issued.address)}`
				: issued.address
					? `扫码连接 · 局域网 ${issued.address}`
					: '手机填电脑局域网地址 + 此码';
			slot.append(code, addr);
			banner.append(slot);
		}

		/** banner 内的出码按钮统一行为：busy → 出码 → 失败在 banner 内显错 */
		function bindCodeBtn(btn, banner, route) {
			btn.addEventListener('click', async () => {
				if (bannerBusy[route]) return;
				bannerBusy[route] = true;
				btn.disabled = true;
				btn.textContent = '生成中…';
				try {
					mountCode(banner, await issuePairingCode(route));
				} catch (err) {
					banner.querySelectorAll('.dsh-mios-code-slot').forEach((e) => e.remove());
					const errEl = document.createElement('div');
					errEl.className = 'err';
					errEl.textContent = '生成失败：' + (err?.body?.error?.message || err.message);
					banner.append(errEl);
				} finally {
					bannerBusy[route] = false;
					btn.textContent = '重新生成配对码';
					renderSummary();
				}
			});
		}

		function showPanel() {
			if (panelEl) return;
			// 打开期间持续轻量刷新：扫码上线、改名、下线都能立刻反映，无需关掉重开。
			if (summaryPollTimer) clearInterval(summaryPollTimer);
			summaryPollTimer = setInterval(refreshSummary, 1200);
			installStyle();
			panelEl = document.createElement('div');
			panelEl.className = 'dsh-mios-panel';

			const header = document.createElement('h3');
			const dot = document.createElement('span');
			dot.id = 'dsh-mios-panel-dot';
			dot.className = 'dsh-mios-dot down';
			const title = document.createElement('span');
			title.textContent = PANEL_TITLE;
			// 插件更新：放在关闭按钮左边，点击弹出更新对话框（版本对比 + 更新与否由用户选）
			const updBtn = document.createElement('button');
			updBtn.className = 'dsh-mios-upd';
			updBtn.textContent = '插件更新';
			updBtn.addEventListener('click', () => {
				// 点击务必先有可见反馈再联网，避免「无反应」错觉（缓存旧模块时旧逻辑写已移除的内联元素）。
				try { checkPluginUpdate(); } catch (e) {
					console.error('[dsh-mobile-ios] checkPluginUpdate failed:', e);
					showUpdateModal({ title: '插件更新', lines: [], note: `打开更新检查失败：${e?.message || e}`, actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }] });
				}
			});
			const close = document.createElement('button');
			close.className = 'dsh-mios-close';
			close.textContent = '✕';
			close.setAttribute('aria-label', '关闭面板');
			close.addEventListener('click', removePanel);
			header.append(dot, title, updBtn, close);

			const body = document.createElement('div');
			body.append(
				row('插件版本', 'dsh-mios-adapter'),
				row('电脑名称', 'dsh-mios-host'),
				deviceRows(),
			);

			// ── banner 1：局域网连接（在家 · 直连 · 始终可用） ──
			const lanBanner = bannerBox('局域网连接', 'dsh-mios-lan-state', '手机与电脑连同一个 Wi-Fi，直连不走外网。适合在家日常用。');
			const lanCodeBtn = document.createElement('button');
			lanCodeBtn.className = 'pairbtn';
			lanCodeBtn.id = 'dsh-mios-lan-code';
			lanCodeBtn.textContent = '生成配对码';
			bindCodeBtn(lanCodeBtn, lanBanner, 'lan');
			lanBanner.append(lanCodeBtn);

			// ── banner 2：远程通道连接（出门 · 固定域名 · 一个主按钮走完） ──
			// 「开启远程」与「生成配对码」合并成一个主按钮：没开过→开通；
			// 开过没跑→开启并出码；跑着→直接出码。停止是旁边的小按钮。
			const remoteBanner = bannerBox('远程通道连接', 'dsh-mios-remote-state', '出门在外扫码连固定域名，电脑和手机不必在同一网络。');
			const remoteAddr = document.createElement('div');
			remoteAddr.id = 'dsh-mios-remote-addr';
			remoteAddr.className = 'banner-addr';
			remoteAddr.textContent = '—';
			remoteBanner.append(remoteAddr);
			const mainBtn = document.createElement('button');
			mainBtn.className = 'pairbtn';
			mainBtn.id = 'dsh-mios-remote-main';
			mainBtn.textContent = '开启远程并生成配对码';
			mainBtn.addEventListener('click', () => remoteMainAction(remoteBanner));
			const stopBtn = document.createElement('button');
			stopBtn.className = 'pairbtn stopbtn';
			stopBtn.id = 'dsh-mios-remote-stop';
			stopBtn.textContent = '停止远程';
			stopBtn.addEventListener('click', stopRemoteAction);
			remoteBanner.append(mainBtn, stopBtn);

			const hint = document.createElement('div');
			hint.id = 'dsh-mios-hint';
			hint.style.cssText = 'margin-top:8px;font-size:11px;color:#e0a03c;line-height:1.5;';
			hint.style.display = 'none';

			const footer = document.createElement('footer');
			footer.textContent = 'iPhone/iPad App → 连接 → 扫码（约 2 分钟有效）';

			panelEl.append(header, body, lanBanner, remoteBanner, hint, footer);
			document.body.append(panelEl);
			applyPanelTheme();
			placePanelAboveTrigger();
			renderSummary();
			probe();

			// 点击面板/触发 banner 以外的任意区域即关闭（✕ 之外的第二条路）
			outsideCloser = (ev) => {
				if (!panelEl) return;
				const t = ev.target;
				if (panelEl.contains(t) || (t.closest && t.closest('.dsh-mios-trigger'))) return;
				removePanel();
			};
			document.addEventListener('pointerdown', outsideCloser);
		}

		/** 面板底边对齐触发 banner 顶边：不遮挡 banner，屏幕放不下就整体上推并内滚。 */
		function placePanelAboveTrigger() {
			const trigger = document.querySelector('.dsh-mios-trigger');
			if (trigger) {
				const rect = trigger.getBoundingClientRect();
				panelEl.style.left = `${Math.max(10, Math.round(rect.left))}px`;
				panelEl.style.bottom = `${Math.max(10, Math.round(window.innerHeight - rect.top + 8))}px`;
			}
			panelEl.style.maxHeight = 'min(72vh, 640px)';
			panelEl.style.overflowY = 'auto';
		}

		/** 更新检查：与「添加插件」同源，读 npm registry 的 latest 比对当前版本。
		 *  404 = 包未发布（本地开发版）；网络失败 = 如实报不可达，二者不混为一谈。 */
		/** 更新对话框：显示版本对比，更新与否由用户选；随面板销毁清理。 */
		let updateModal = null;
		function closeUpdateModal() {
			updateModal?.remove();
			updateModal = null;
		}
		function showUpdateModal({ title, banner, lines, note, steps, actions, footLink, progress, prompt }) {
			closeUpdateModal();
			const mask = document.createElement('div');
			mask.className = 'dsh-mios-modal-mask';
			if (detectHostTheme() === 'light') mask.classList.add('light');
			const box = document.createElement('div');
			box.className = 'dsh-mios-modal';

			const h = document.createElement('h4');
			h.textContent = title;
			const x = document.createElement('button');
			x.className = 'modal-x';
			x.textContent = '✕';
			x.setAttribute('aria-label', '关闭');
			x.addEventListener('click', closeUpdateModal);
			h.append(x);
			box.append(h);

			// banner：一步更新流程的状态横幅（发现新版 / 更新中 / 成功 / 失败）
			if (banner) {
				const b = document.createElement('div');
				b.className = `modal-banner${banner.tone ? ' ' + banner.tone : ''}`;
				b.textContent = banner.text;
				box.append(b);
			}

			for (const line of lines || []) {
				const row = document.createElement('div');
				row.className = 'modal-line';
				const label = document.createElement('span');
				label.textContent = line.label;
				const value = document.createElement('b');
				value.textContent = line.value;
				if (line.highlight) value.className = 'new';
				row.append(label, value);
				box.append(row);
			}
			// 进度条：同一弹窗原地更新，不重建 DOM（重建会吞掉按钮点击、闪一下像卡死）。
			if (progress) {
				const wrap = document.createElement('div');
				wrap.className = 'modal-progress';
				const bar = document.createElement('div');
				bar.className = 'modal-progress-bar';
				const fill = document.createElement('div');
				fill.className = 'modal-progress-fill';
				const label = document.createElement('div');
				label.className = 'modal-progress-label';
				bar.append(fill);
				wrap.append(bar, label);
				box.append(wrap);
				const applyProgress = (next = {}) => {
					const pct = Math.max(0, Math.min(100, Number(next.percent) || 0));
					fill.style.width = `${pct}%`;
					label.textContent = next.label || `已下载 ${pct}%`;
				};
				applyProgress(progress);
				mask._setProgress = applyProgress;
			}
			if (note) {
				const n = document.createElement('div');
				n.className = 'modal-note';
				n.textContent = note;
				box.append(n);
			}
			// 排障步骤：域名/NS 这类问题光说「异常」没用，得给出下一步点哪里。
			if (steps?.length) {
				const ol = document.createElement('ol');
				ol.className = 'modal-steps';
				for (const s of steps) {
					const li = document.createElement('li');
					li.textContent = s;
					ol.append(li);
				}
				box.append(ol);
			}
			// 可直接复制的指令框：自动全选，复制失败也能手动 ⌘C。
			// 这是「点了没反应」类问题的最终兜底——不依赖任何按钮或异步请求。
			if (prompt?.text) {
				const ta = document.createElement(prompt.compact ? 'input' : 'textarea');
				ta.className = prompt.compact ? 'modal-pick' : 'modal-prompt';
				ta.readOnly = true;
				ta.value = prompt.text;
				ta.setAttribute('aria-label', prompt.label || '可复制内容');
				box.append(ta);
				mask._promptEl = ta;
				try {
					ta.focus();
					ta.select();
					ta.setSelectionRange?.(0, prompt.text.length);
				} catch { /* 焦点/选区拿不到也不影响手动复制 */ }
			}

			const bar = document.createElement('div');
			bar.className = 'modal-actions';
			for (const action of actions || []) {
				const btn = document.createElement('button');
				btn.textContent = action.label;
				if (action.primary) btn.className = 'primary';
				// 异步动作一律包一层：onClick 里抛异常时，原来等价于「点了没反应」。
				// 现在至少把错误摆到弹窗里（toast），用户能复制给我们。
				btn.addEventListener('click', () => {
					try {
						const ret = action.onClick?.(btn);
						if (ret && typeof ret.catch === 'function') {
							ret.catch((err) => {
								console.error('modal action failed', err);
								showModalToast(`操作失败：${err?.message || err}`, 'error');
							});
						}
					} catch (err) {
						console.error('modal action failed', err);
						showModalToast(`操作失败：${err?.message || err}`, 'error');
					}
				});
				bar.append(btn);
			}
			box.append(bar);
			// 兜底动作（如「重置本机状态」）做成弱化的文字链，避免主按钮挤成四个
			if (footLink) {
				const link = document.createElement('button');
				link.className = 'modal-link';
				link.textContent = footLink.label;
				link.addEventListener('click', () => {
					try { footLink.onClick?.(); } catch (err) { console.error('modal link failed', err); }
				});
				box.append(link);
			}
			mask.append(box);
			mask.addEventListener('click', (e) => { if (e.target === mask) closeUpdateModal(); });
			document.body.append(mask);
			updateModal = mask;
		}

		/**
		 * 复制文本。四级降级，任一级成功即返回 true：
		 *   1) navigator.clipboard —— **必须带超时**。dsh-app:// 这类自定义协议下
		 *      writeText() 可能既不 resolve 也不 reject，直接 await 会把点击处理永久挂起，
		 *      按钮文字/toast 全不更新 —— 用户看到的就是「点了没反应」。竞速 800ms 后立即降级。
		 *   2) 弹窗里真实可见、已自动全选的文本框 —— execCommand 只作用于屏幕上真元素，
		 *      屏幕外/透明元素在 Electron 里拿不到选区，这是上一版降级也失效的原因。
		 *   3) 屏幕外 textarea + execCommand —— 无弹窗文本框时的兜底。
		 *   4) contenteditable 兜底。全部失败才返回 false，由调用方补可手选输入框。
		 */
		const CLIPBOARD_RACE_MS = 800;
		async function copyToClipboard(text) {
			const value = String(text ?? '');
			if (!value) return false;
			try {
				if (navigator.clipboard?.writeText) {
					const wrote = Promise.resolve(navigator.clipboard.writeText(value)).then(() => true, () => false);
					const timedOut = new Promise((r) => setTimeout(() => r(false), CLIPBOARD_RACE_MS));
					if (await Promise.race([wrote, timedOut])) return true;
				}
			} catch { /* 落到下一级 */ }
			// 可见文本框优先：它已经 focus + select，Electron 里 execCommand('copy') 命中率最高
			const visible = updateModal?.querySelector?.('.modal-prompt') || updateModal?.querySelector?.('.modal-pick');
			if (visible) {
				try {
					visible.focus?.();
					visible.select?.();
					visible.setSelectionRange?.(0, value.length);
					if (document.execCommand('copy')) return true;
				} catch { /* 落到下一级 */ }
			}
			try {
				const ta = document.createElement('textarea');
				ta.value = value;
				ta.setAttribute('readonly', '');
				// 用屏幕外定位而不是 opacity:0：透明元素在部分引擎里无法获得选区
				ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;'
					+ 'padding:0;border:0;outline:none;box-shadow:none;background:transparent;';
				document.body.append(ta);
				ta.focus();
				ta.select();
				ta.setSelectionRange(0, value.length);
				const ok = document.execCommand('copy');
				ta.remove();
				if (ok) return true;
			} catch { /* 落到下一级 */ }
			try {
				const holder = document.createElement('div');
				holder.contentEditable = 'true';
				holder.textContent = value;
				holder.style.cssText = 'position:fixed;top:0;left:-9999px;white-space:pre;';
				document.body.append(holder);
				const range = document.createRange();
				range.selectNodeContents(holder);
				const sel = window.getSelection();
				sel.removeAllRanges();
				sel.addRange(range);
				const ok = document.execCommand('copy');
				sel.removeAllRanges();
				holder.remove();
				return Boolean(ok);
			} catch {
				return false;
			}
		}

		/** 弹窗内结果提示：复制/更新这类动作必须有可见反馈，不能只改按钮文字。 */
		function showModalToast(text, tone = 'info') {
			const box = updateModal?.querySelector?.('.dsh-mios-modal');
			if (!box) return;
			let el = box.querySelector('.modal-toast');
			if (!el) {
				el = document.createElement('div');
				box.insertBefore(el, box.querySelector('.modal-actions'));
			}
			el.className = `modal-toast${tone ? ' ' + tone : ''}`;
			el.textContent = text;
		}

		/**
		 * 复制全线失败时的兜底：在弹窗里放一个已全选的输入框。
		 * 用户按 Ctrl/⌘+C 就能拿到，不依赖任何剪贴板 API。
		 */
		function offerManualCopy(text) {
			const box = updateModal?.querySelector?.('.dsh-mios-modal');
			if (!box) return;
			if (box.querySelector('.modal-pick')) return;
			const input = document.createElement('input');
			input.className = 'modal-pick';
			input.type = 'text';
			input.readOnly = true;
			input.value = text;
			box.insertBefore(input, box.querySelector('.modal-actions'));
			try {
				input.focus();
				input.select();
			} catch { /* 焦点拿不到也让用户能手动点选 */ }
		}

		async function checkPluginUpdate() {
			showUpdateModal({ title: '插件更新', lines: [], note: '正在检查更新…', actions: [] });
			const current = summary?.version || '未知';
			let latest = '';
			let sawNotFound = false;
			let lastError = null;
			for (const base of PLUGIN_REGISTRIES) {
				try {
					const res = await fetch(`${base}/${PLUGIN_NAME}/latest`, { signal: AbortSignal.timeout(6000) });
					if (res.status === 404) { sawNotFound = true; continue; }
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const meta = await res.json();
					if (meta?.version) { latest = String(meta.version); break; }
				} catch (e) {
					lastError = e;
				}
			}
			if (!latest) {
				showUpdateModal({
					title: '插件更新',
					lines: [{ label: '当前版本', value: `v${current}` }],
					note: sawNotFound
						? '插件尚未发布到 npm，当前为本地开发版。更新方式：拉取仓库最新代码后重启 DSH 桌面端，插件会随源码热重载。'
						: `更新源暂不可达${lastError ? `（${lastError.message}）` : ''}，无法确认是否有新版本。`,
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				});
				return;
			}
			if (compareVersions(latest, current) > 0) {
				// 更新能力分三档，面板按宿主实际给了什么决定按钮，绝不摆一个按了没反应的按钮：
				//   ① updateBundle —— 宿主插件管理器自己的升级入口（与「插件」页那个
				//      「更新到 vX」完全同一条代码路径：先移除旧包再装新包并热加载）。
				//      已安装的包只能走这条，installBundle 会被宿主判为「该插件已安装」。
				//   ② installBundle —— 老宿主没有 updateBundle 时的等效能力。
				//   ③ 都没有 —— 只给图文指引：去「插件」页点右上角刷新，交给宿主安装。
				const hostUpdate = !!(pluginManager && typeof pluginManager.updateBundle === 'function');
				const hostInstall = !!(pluginManager && typeof pluginManager.installBundle === 'function');
				const canAuto = hostUpdate || hostInstall;
				showUpdateModal({
					title: '新版本更新',
					banner: { text: `⬆️ 发现新版本 v${latest}`, tone: 'info' },
					lines: [
						{ label: '当前版本', value: `v${current}` },
						{ label: '最新版本', value: `v${latest}`, highlight: true },
					],
					note: canAuto
						? '点「立即更新」由 DSH 插件管理器安装并切换到新版本，完成后重启 DSH 生效。也可以到「插件」页点右上角「刷新」手动更新。'
						: '本面板没拿到 DSH 插件管理器接口，请按下面步骤在「插件」页更新，由 DSH 自带的插件更新机制安装。',
					// 没有宿主接口时，把「点哪里」写清楚：只报「可更新」不给路径等于没帮上忙。
					steps: canAuto ? undefined : [
						'在 DSH 左侧点「插件」',
						'点右上角「刷新」',
						`在列表里点 dsh-mobile-ios 的「更新到 v${latest}」`,
						'重启 DSH 桌面端，让新版本生效',
					],
					// 无宿主更新接口时给一个可见、已全选的包名输入框：按钮再出问题也能 ⌘C 拿走
					prompt: canAuto ? undefined : { text: PLUGIN_NAME, compact: true, label: '包名（可直接复制）' },
					actions: canAuto
						? [
							{ label: '稍后再说', onClick: closeUpdateModal },
							{ label: `立即更新到 v${latest}`, primary: true, onClick: () => performUpdate(latest) },
						]
						: [
							{
								label: '复制包名',
								onClick: async (btn) => {
									btn.textContent = '复制中…'; // 点击即反馈，不让 await 把界面卡成「没反应」
									const ok = await copyToClipboard(PLUGIN_NAME);
									if (ok) {
										btn.textContent = '已复制';
										showModalToast(`已复制 ${PLUGIN_NAME}，可在「插件 → 添加插件」粘贴`, 'success');
									} else {
										btn.textContent = '请手动复制';
										showModalToast('本机剪贴板不可用，请在下方框内全选复制', 'error');
										offerManualCopy(PLUGIN_NAME);
									}
								},
							},
							{ label: '知道了', primary: true, onClick: closeUpdateModal },
						],
				});
			} else {
				showUpdateModal({
					title: '已是最新版本',
					lines: [
						{ label: '当前版本', value: `v${current}` },
						{ label: 'npm 最新', value: `v${latest}` },
					],
					note: '当前版本已是最新，无需更新。',
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				});
			}
		}

		/** 一步更新：经宿主 pluginManager.installBundle 安装 npm spec，
		 *  状态机覆盖 更新中 / 成功 / 失败 / 超时对账 / 重复点击。 */
		let UPDATE_TIMEOUT_MS = 180000; // pnpm 安装 + 可能的重启，给足 3 分钟
		function unwrapRemote(result) {
			if (result && typeof result === 'object' && Object.hasOwn(result, 'ok')) {
				if (!result.ok) throw new Error(result.error?.code || result.error?.message || '宿主返回失败');
				return result.value;
			}
			return result;
		}
		function withTimeout(promise, ms, label) {
			return new Promise((resolve, reject) => {
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`));
				}, ms);
				Promise.resolve(promise).then(
					(v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
					(e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } },
				);
			});
		}

		// ── 跨 HMR 重载的更新状态持久化 ─────────────────────────────
		// 更新「自己」会触发宿主卸载本模块并加载新版，当前 JS 上下文连同弹窗一起销毁。
		// 因此发起更新前把状态写入 localStorage，新模块 apply 时读取并给出结果反馈，
		// 避免出现「点一下弹窗消失、什么都没发生」的体验。
		const UPDATE_STATE_KEY = 'dsh-mios-update-state';
		function readUpdateState() {
			try {
				const raw = globalThis.localStorage?.getItem(UPDATE_STATE_KEY);
				return raw ? JSON.parse(raw) : null;
			} catch { return null; }
		}
		function writeUpdateState(state) {
			try { globalThis.localStorage?.setItem(UPDATE_STATE_KEY, JSON.stringify(state)); }
			catch { /* 存储不可用时静默，功能降级但不崩 */ }
		}
		function clearUpdateState() {
			try { globalThis.localStorage?.removeItem(UPDATE_STATE_KEY); }
			catch { /* 同上 */ }
		}
		/** apply 时调用：若上次更新尚未收尾，依据当前版本推断结果并弹窗告知。 */
		function restorePendingUpdate() {
			const st = readUpdateState();
			if (!st || st.status !== 'updating' || !st.target) return;
			const current = String(summary?.version || '').trim();
			const age = Date.now() - (st.at || 0);
			if (current && compareVersions(current, st.target) >= 0) {
				clearUpdateState();
				// 延迟到面板初次渲染后再弹，避免被 apply 后续的初始化覆盖
				setTimeout(() => showUpdateModal({
					title: '更新完成',
					banner: { text: `✅ 已更新到 v${st.target}`, tone: 'success' },
					lines: [{ label: '当前版本', value: `v${current}` }],
					note: '插件已更新并重新加载完成。',
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				}), 600);
			} else if (age > 5 * 60 * 1000) {
				clearUpdateState();
				setTimeout(() => showUpdateModal({
					title: '更新结果未知',
					banner: { text: '⚠️ 上一步更新未能确认', tone: 'warn' },
					lines: [{ label: '目标版本', value: `v${st.target}` }, { label: '当前版本', value: current ? `v${current}` : '未知' }],
					note: '更新过程被中断或耗时过长。请到「插件」页确认当前版本，必要时手动更新。',
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				}), 600);
			}
			// 未超时且版本未变：保持 updating 状态，等下次 apply（轮询重载）再判断
		}
		async function performUpdate(latest) {
			// 重复点击保护：更新中直接忽略再次触发
			if (updateInFlight) return;
			updateInFlight = true;
			const current = summary?.version || '未知';
			const spec = `${PLUGIN_NAME}@${latest}`;
			const canHost = !!(pluginManager
				&& (typeof pluginManager.updateBundle === 'function' || typeof pluginManager.installBundle === 'function'));
			// 先持久化「更新中」，确保 HMR 卸载本模块后新实例能恢复出结果反馈。
			writeUpdateState({ status: 'updating', target: String(latest), at: Date.now() });
			// 状态：更新中。无取消/关闭动作外的操作按钮，防重复点击。
			showUpdateModal({
				title: '正在更新',
				banner: { text: `⏳ 正在更新到 v${latest}，请稍候`, tone: 'info' },
				lines: [
					{ label: '当前版本', value: `v${current}` },
					{ label: '目标版本', value: `v${latest}`, highlight: true },
				],
				note: canHost
					? '正在通过 DSH 插件管理器更新（先卸旧版再装新版），约 1–3 分钟。请勿重复点击或关闭窗口。'
					: '正在经本机网关下载并安装（含完整性校验），请勿重复点击或关闭窗口。',
				actions: [],
			});
			try {
				let restart = false;
				const canHostUpdate = !!(pluginManager && typeof pluginManager.updateBundle === 'function');
				if (canHostUpdate) {
					// ⓪ 宿主插件管理器的升级入口：与「插件」页「更新到 vX」同一条路径
					//    （内部先 removeBundle 再 installBundle，并触发 HMR 热切换）。
					//    已安装的包只能走这条 —— installBundle 会被判「该插件已安装」。
					let requestId = globalThis.crypto?.randomUUID?.();
					if (typeof requestId !== 'string') throw new Error('无法生成更新请求 ID');
					const settled = await withTimeout(
						pluginManager.updateBundle(String(PLUGIN_NAME), String(latest), { requestId }),
						UPDATE_TIMEOUT_MS, '更新',
					);
					const out = unwrapRemote(settled) || {};
					const result = out.result || {};
					// 宿主用 application:'failed' + error 表达拒绝/失败，不能当成功吞掉
					if (result.application === 'failed' || result.error) {
						const why = result.error?.diagnostic || result.error?.code || out.step || '宿主未说明原因';
						throw new Error(`DSH 插件管理器更新失败：${why}`);
					}
					restart = true;
				} else if (typeof pluginManager?.installBundle === 'function') {
					// ① 老宿主安装器：最常见的 Desktop 路径
					let requestId;
					requestId = globalThis.crypto?.randomUUID?.();
					if (typeof requestId !== 'string') throw new Error('无法生成更新请求 ID');
					let result;
					try {
						result = await withTimeout(
							pluginManager.installBundle(spec, { enabled: true, requestId }),
							UPDATE_TIMEOUT_MS, '安装',
						);
					} catch (err) {
						// 超时/结果未知：用 requestId 对账，绝不重复提交安装
						if (typeof pluginManager.waitForInstall === 'function') {
							const recovered = await withTimeout(pluginManager.waitForInstall(requestId), 60000, '结果对账');
							if (!recovered) throw err;
							result = recovered;
						} else throw err;
					}
					const value = unwrapRemote(result);
					restart = !!(value && (value.restartRequired || value.restart));
				} else {
					// ② 网关自更新：宿主没给任何插件管理接口时的等效能力。
					// 网关从 npm 取 tarball、按 dist.shasum 校验、备份旧目录后覆盖安装。
					const res = await fetchJson('/mobile/v1/plugin/self-update', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ target: latest }),
					}, 180000);
					restart = res?.restartRequired !== false;
				}
				clearUpdateState(); // 安装已返回结果，交由本弹窗反馈，无需跨重载恢复
				// 状态：成功
				showUpdateModal({
					title: '更新完成',
					banner: { text: `✅ 已安装 v${latest}`, tone: 'success' },
					lines: [
						{ label: '目标版本', value: `v${latest}` },
					],
					note: restart
						? '插件已更新，重启 DSH 桌面端后生效（面板版本号会在重启后变成新版本）。'
						: '插件已更新。若面板未刷新，重开面板或重启 DSH 即可。',
					actions: [{ label: '知道了', primary: true, onClick: closeUpdateModal }],
				});
			} catch (err) {
				// 状态：失败。不能只报错就完 —— 顺手把「插件页刷新」这条路指出来，
				// 宿主自己的安装器通常能成功（它走的是 pnpm + 本机 registry 镜像）。
				clearUpdateState();
				showUpdateModal({
					title: '更新失败',
					banner: { text: '❌ 面板内更新未成功', tone: 'error' },
					lines: [{ label: '目标版本', value: `v${latest}` }],
					note: `失败原因：${err?.body?.error?.message || err?.message || String(err)}。可重试；更稳的办法是到「插件」页刷新，由 DSH 自己安装。`,
					steps: [
						'在 DSH 左侧点「插件」',
						'点右上角「刷新」',
						`在列表里点 dsh-mobile-ios 的「更新到 v${latest}」`,
						'重启 DSH 桌面端，让新版本生效',
					],
					// 失败兜底：spec 可见可全选，复制按钮不再是唯一出口
					prompt: { text: spec, compact: true, label: '包名（可直接复制）' },
					actions: [
						{ label: '关闭', onClick: closeUpdateModal },
						{ label: '重试更新', onClick: () => performUpdate(latest) },
						{
							label: '复制包名',
							onClick: async (btn) => {
								btn.textContent = '复制中…'; // 点击即反馈，不让 await 把界面卡成「没反应」
								const ok = await copyToClipboard(spec);
								if (ok) {
									btn.textContent = '已复制';
									showModalToast(`已复制 ${spec}，去「插件 → 添加插件」粘贴安装`, 'success');
								} else {
									btn.textContent = '请手动复制';
									showModalToast('本机剪贴板不可用，请在下方框内全选复制', 'error');
									offerManualCopy(spec);
								}
							},
						},
						{ label: '知道了', primary: true, onClick: closeUpdateModal },
					],
				});
			} finally {
				updateInFlight = false;
			}
		}

		function compareVersions(a, b) {
			const parse = (s) => String(s || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
			const [pa, pb] = [parse(a), parse(b)];
			for (let i = 0; i < 3; i += 1) {
				if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
			}
			return 0;
		}

		/** 等 summary 反映出「远程已可用」：服务端 start 会等到注册成功才返回，
		 *  但客户端超时/轮询窗口内可能还没看到，这里统一补轮询兜底。 */
		async function waitForTunnelUp(attempts = 8, delayMs = 1500) {
			for (let i = 0; i < attempts; i += 1) {
				await probe();
				renderSummary();
				const t = summary?.tunnel;
				if (t && t.state === 'running' && t.dnsOk !== false) return true;
				if (i < attempts - 1) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
			}
			return false;
		}

		/** cloudflared 官方发布资产（2026.11.1）。面板不再自己下载，只把地址写进
		 *  交给 Harness Agent 的指令里；安装与隧道联调全部由桌面端 Agent 负责。 */
		const CLOUDFLARED_AGENT_ASSETS = [
			['macOS Apple Silicon', 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-darwin-arm64.tgz'],
			['macOS Intel', 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-darwin-amd64.tgz'],
			['Windows x64', 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-windows-amd64.exe'],
			['Windows x86', 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-windows-386.exe'],
			['Linux x64', 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-linux-amd64'],
			['Linux arm64', 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.1/cloudflared-linux-arm64'],
		];

		/** 生成交给 Harness Agent 的安装指令。整段可直接复制粘贴给桌面端 Agent 执行。 */
		function buildCloudflaredAgentPrompt() {
			return [
				'请在这台电脑上帮我安装并调试好 cloudflared 隧道工具，供 DSH Mobile 插件的远程连接使用。请直接动手执行，完成后把结果告诉我。',
				'',
				'【1. 下载】自动识别当前系统/架构，从 Cloudflare 官方地址下载对应版本（国内 GitHub 慢，可用浏览器或下载器）：',
				...CLOUDFLARED_AGENT_ASSETS.map(([name, url]) => `- ${name}: ${url}`),
				'',
				'【2. 安装到插件指定位置】文件名必须精确，不要装到系统 PATH / Program Files —— 插件只认这个路径：',
				'- macOS/Linux: ~/.dsh/mobile-access/components/cloudflared/2026.11.1/cloudflared',
				'  （.tgz 先解压取里面的 cloudflared，放到上面的路径后执行 chmod +x）',
				'- Windows: %USERPROFILE%\\.dsh\\mobile-access\\components\\cloudflared\\2026.11.1\\cloudflared.exe',
				'',
				'【3. 校验与联调】',
				'- 运行 cloudflared --version，确认输出版本号（不是格式错误、不是压缩包）。',
				'- 确认 DSH Mobile 网关能在上述路径发现 cloudflared；必要时重启 DeepSeek Harness 桌面端让插件重新探测。',
				'- 再点插件面板的「开启远程」，确认能生成配对码；若失败请继续排查，并把错误原文告诉我。',
				'',
				'【验收】插件面板不再提示需要安装 cloudflared，点击开启远程能正常出码。',
			].join('\n');
		}

		let installBanner = null;      // 触发动作的 banner，供装好后继续出码（onClick 只传按钮）
		let autoContinueTimer = null;

		/** 缺依赖弹窗：给一段可复制的 Agent 指令，插件自己不再碰下载/解压/进度轮询。 */
		function installCloudflaredAction(banner) {
			installBanner = banner || null;
			const promptText = buildCloudflaredAgentPrompt();
			showUpdateModal({
				title: '需要安装 cloudflared',
				banner: { text: '⚠️ 本机缺少远程隧道依赖 cloudflared', tone: 'warn' },
				note: '复制下面这段指令，发给 DeepSeek Harness 桌面端 Agent，它会负责下载、安装并调试好隧道工具。安装完成回来点「我装好了，继续」。',
				prompt: { text: promptText, label: '发给 Harness Agent 的安装指令' },
				actions: [
					{
						label: '复制安装指令',
						primary: true,
						onClick: async (btn) => {
							const restore = setModalBusy(btn, '复制中…');
							try {
								const ok = await copyToClipboard(promptText);
								if (ok) {
									showModalToast('已复制，粘贴给 DeepSeek Harness 桌面端 Agent 即可', 'success');
								} else {
									showModalToast('自动复制失败，文本框已选中，请按 Ctrl/⌘+C 手动复制', 'error');
									offerManualCopy(promptText);
								}
							} finally { restore(); }
						},
					},
					{
						label: '我装好了，继续',
						onClick: async (btn) => {
							const restore = setModalBusy(btn, '检测中…');
							try {
								await probe();
								renderSummary();
								if (summary?.tunnel?.executable !== 'found') {
									showModalToast('还没检测到 cloudflared，请让 Agent 装到弹窗里的指定路径后重试', 'error');
									return;
								}
								closeUpdateModal();
								await continueRemoteAfterInstall();
							} catch (err) {
								showModalToast(`检测失败：${err?.message || err}`, 'error');
							} finally { restore(); }
						},
					},
				],
				footLink: { label: '关闭弹窗', onClick: () => { installBanner = null; closeUpdateModal(); } },
			});
		}

		/** Agent 装好后接着走「确保在跑 → 出码」。 */
		async function continueRemoteAfterInstall() {
			const banner = installBanner;
			installBanner = null;
			await remoteMainAction(banner);
		}

		/** 记住最近一次触发远程动作的 banner：弹窗里的「重新检测」要能继续同一条链。 */
		let lastRemoteBanner = null;

		/** 授权轮询句柄（同一时刻只允许一条，重复点不会起两个计时器）。 */
		let loginPoll = null;

		function stopLoginPoll() {
			if (loginPoll) {
				clearInterval(loginPoll);
				loginPoll = null;
			}
		}

		/**
		 * 弹窗按钮的忙碌态。
		 *
		 * 为什么必须有：原来「重新检测 / 重置 / 重新授权」都是 `closeUpdateModal()` 先关窗
		 * 再发请求——请求最长 25 秒，这段时间**界面上什么都不发生**。用户看到的就是
		 * 「点了没反应」，于是反复点、或者以为插件坏了。
		 * 现在：按钮立刻变灰并换文案，同一弹窗内原地出结果，失败也一定看得见。
		 */
		function setModalBusy(activeBtn, label) {
			const box = updateModal?.querySelector?.('.dsh-mios-modal');
			const btns = box?.querySelectorAll ? Array.from(box.querySelectorAll('.modal-actions button')) : [];
			const prev = new Map();
			for (const b of btns) {
				prev.set(b, b.textContent);
				b.disabled = true;
			}
			if (activeBtn && label) activeBtn.textContent = label;
			return () => {
				for (const b of btns) {
					b.disabled = false;
					if (prev.has(b)) b.textContent = prev.get(b);
				}
			};
		}

		/**
		 * 凭据不可用（登录的账号与域名不匹配 / 证书过时 / 授权错了域名）。
		 *
		 * 现场（2026-11-21，Mac mini）：cert.pem 属于另一个 Cloudflare 账号，面板提示
		 * 「账号不对」，用户重装、重启、点重置、点重新检测全都无效——因为这三个动作
		 * 都**不会**换掉 cert.pem。唯一有效的是用持有该域名的账号重新授权。
		 * 所以这里把它做成一步：点「重新授权」→ 浏览器里点允许 → 面板自动继续开通。
		 *
		 * @param {object} credentials 凭据结论（来自 summary.tunnel.credentials）
		 * @param {object} [opts]
		 * @param {boolean} [opts.again]      刚做过一次检测、结论没变
		 * @param {boolean} [opts.afterLogin] 刚到浏览器授权回来的复检
		 */
		function showCredentialHelpModal(credentials = {}, opts = {}) {
			const stateText = credentials.hint || '当前登录的 Cloudflare 账号无法管理这个域名';
			const certAccount = credentials.certAccountName
				|| (credentials.certAccountId ? `账号 ${String(credentials.certAccountId).slice(0, 8)}…` : null);
			const scopedOther = credentials.state === 'zone-scoped-other' && credentials.certZoneName;
			const lines = [
				...(certAccount ? [{ label: '当前证书账号', value: certAccount }] : []),
				...(credentials.zoneName ? [{ label: '固定地址域名', value: credentials.zoneName }] : []),
				...(scopedOther ? [{ label: '证书授权域名', value: credentials.certZoneName }] : []),
				...(credentials.zoneStatus ? [{ label: '域名状态', value: credentials.zoneStatus }] : []),
			];
			const bannerText = opts.afterLogin
				? `⚠️ 授权后仍然不行：${stateText}`
				: opts.again
					? `⚠️ 重新检测结论没变：${stateText}`
					: `⚠️ ${stateText}`;
			showUpdateModal({
				title: opts.afterLogin ? '授权完成，但这个账号不行' : '登录的 Cloudflare 账号不对',
				banner: { text: bannerText, tone: 'warn' },
				lines,
				note: '固定地址写在 Cloudflare 的域名下，只有「持有该域名的账号」才写得进去。'
					+ '重装插件、重启宿主、点重置都不会换掉证书——只有重新授权能修好。'
					+ '授权后本机会自动重建隧道并沿用同一个地址，手机不需要重新配对。',
				steps: [
					'点下面的「重新授权（浏览器）」，面板会调起 Cloudflare 的授权页。',
					scopedOther
						? `浏览器里务必选「${credentials.zoneName || '固定地址域名'}」所在的账号（上次选成了 ${credentials.certZoneName}）。`
						: '浏览器里选择「持有该域名」的账号，点「允许 / Authorize」。',
					'回到面板不用做别的：授权成功后会自动继续开通固定地址。',
				],
				footLink: { label: '重置本机状态（清掉本机的旧地址记录）', onClick: () => confirmResetTunnelState() },
				actions: [
					{ label: '关闭', onClick: closeUpdateModal },
					{ label: '重新检测', onClick: (btn) => recheckDnsAction(lastRemoteBanner, btn) },
					{ label: '重新授权（浏览器）', primary: true, onClick: (btn) => startTunnelLogin(btn) },
				],
			});
		}

		/**
		 * 发起浏览器授权：起 `cloudflared tunnel login`，把链接摆到弹窗里，然后轮询结果。
		 *
		 * 为什么要轮询而不是等 POST 返回：cloudflared 会一直挂着等浏览器回调，
		 * 同步等会把 HTTP 请求挂死 5 分钟。POST 只负责「起进程 + 尽早给链接」。
		 */
		async function startTunnelLogin(btn) {
			const restore = setModalBusy(btn, '启动中…');
			stopLoginPoll();
			let first = null;
			try {
				first = await fetchJson('/mobile/v1/tunnel/login', { method: 'POST' }, 20000);
			} catch (err) {
				restore();
				showUpdateModal({
					title: '无法发起授权',
					banner: { text: '❌ 没能调起 cloudflared', tone: 'error' },
					lines: [],
					note: `${err?.body?.error?.message || err?.message || String(err)}。`
						+ '仍可在终端执行 cloudflared tunnel login 完成授权，然后点「重新检测」。',
					steps: [],
					actions: [
						{ label: '关闭', onClick: closeUpdateModal },
						{ label: '重试', primary: true, onClick: (b) => startTunnelLogin(b) },
					],
				});
				return;
			}
			renderLoginModal(first);
			pollLogin();
		}

		/** 授权进行中的弹窗：链接、进度、取消。链接拿不到就说明还在等 cloudflared 打印。 */
		function renderLoginModal(status = {}) {
			const url = status.url || null;
			showUpdateModal({
				title: '等待浏览器授权',
				banner: {
					text: status.state === 'ok' ? '✅ 授权完成' : '⏳ 正在等待 Cloudflare 授权…',
					tone: status.state === 'ok' ? 'success' : 'info',
				},
				lines: url ? [{ label: '授权链接', value: url }] : [],
				note: url
					? '浏览器没自动打开的话，点「复制授权链接」用任意浏览器打开；授权完成后回到面板即可，不需要保持那个页面。'
					: '正在启动 cloudflared 并获取授权链接，通常 1–2 秒。',
				steps: [
					'在打开页面里选择持有该域名的 Cloudflare 账号。',
					'点「允许 / Authorize」，浏览器会跳回本机完成授权。',
					'面板会自动检测结果并继续开通，不需要再点别的。',
				],
				actions: [
					{ label: '取消授权', onClick: () => cancelTunnelLogin() },
					...(url ? [{ label: '复制授权链接', onClick: (btn) => copyLoginUrl(url, btn) }] : []),
				],
			});
		}

		async function copyLoginUrl(url, btn) {
			const ok = await copyToClipboard(url);
			showModalToast(ok ? '授权链接已复制' : '复制失败：请手动选中上面的链接复制', ok ? 'success' : 'error');
			if (btn) btn.textContent = ok ? '已复制' : '复制失败';
		}

		async function cancelTunnelLogin() {
			stopLoginPoll();
			try { await fetchJson('/mobile/v1/tunnel/login/cancel', { method: 'POST' }, 8000); } catch { /* 已结束 */ }
			closeUpdateModal();
		}

		/** 轮询授权结果；成功后自动复检并继续开通。 */
		function pollLogin() {
			stopLoginPoll();
			const startedAt = Date.now();
			let lastUrl = null;
			loginPoll = setInterval(async () => {
				// 服务端 5 分钟超时，这里多留一分钟余量，避免界面上的计时器先死掉
				if (Date.now() - startedAt > 6 * 60_000) {
					stopLoginPoll();
					closeUpdateModal();
					return;
				}
				let st = null;
				try {
					st = await fetchJson('/mobile/v1/tunnel/login', {}, 8000);
				} catch {
					return; // 网关暂时不可达：继续轮询，不要把一次网络抖动画成失败
				}
				if (!st) return;
				if (st.state === 'waiting') {
					// 链接晚到：只在第一次拿到时重绘，避免每 1.5 秒闪一次
					if (st.url && st.url !== lastUrl) {
						lastUrl = st.url;
						renderLoginModal(st);
					}
					return;
				}
				stopLoginPoll();
				if (st.state === 'ok') {
					await afterLoginOk();
				} else if (st.state === 'canceled') {
					closeUpdateModal();
				} else {
					showUpdateModal({
						title: '授权没有完成',
						banner: { text: '❌ 浏览器授权未完成', tone: 'error' },
						lines: [],
						note: `${st.error || '没有拿到新的证书'}。`
							+ '可以再试一次；如果浏览器打不开，就在这台电脑的终端执行 cloudflared tunnel login。',
						steps: [],
						actions: [
							{ label: '关闭', onClick: closeUpdateModal },
							{ label: '重新授权', primary: true, onClick: (b) => startTunnelLogin(b) },
						],
					});
				}
			}, 1500);
		}

		/**
		 * 授权成功之后：强制重检 → 结论变了就继续开通，没变就说清「换了账号还是不行」。
		 *
		 * 关键点：这里必须**强制**重检（force），否则凭据结论还挂在旧证书的 TTL 缓存上，
		 * 用户刚授权完却仍看到「账号不对」，会以为授权白做了。
		 */
		async function afterLoginOk() {
			showUpdateModal({
				title: '授权完成',
				banner: { text: '✅ 证书已更新，正在验证账号权限', tone: 'success' },
				lines: [],
				note: '正在用新证书检查这台电脑能不能写这个域名的 DNS。',
				steps: [],
				actions: [],
			});
			let res = null;
			try {
				res = await fetchJson('/mobile/v1/tunnel/recheck-dns', { method: 'POST' }, 30000);
			} catch (err) {
				// 重检失败也要给出下一步，不能只关窗
				showUpdateModal({
					title: '授权完成，但检测失败',
					banner: { text: '⚠️ 新证书已就位，检查没跑完', tone: 'warn' },
					lines: [],
					note: `${err?.body?.error?.message || err?.message || String(err)}。可点「重新检测」再试一次。`,
					steps: [],
					actions: [
						{ label: '关闭', onClick: closeUpdateModal },
						{ label: '重新检测', primary: true, onClick: (btn) => recheckDnsAction(lastRemoteBanner, btn) },
					],
				});
				return;
			}
			await probe();
			renderSummary();
			const creds = res?.credentials || summary?.tunnel?.credentials || null;
			if (creds?.blocking) {
				showCredentialHelpModal({ ...creds, hint: creds.hint }, { afterLogin: true });
				return;
			}
			// 注意 `provisioned`：这台机器可能本来就还没分配过地址，此时 ok=false 只表示
			// 「没有地址可查」，不是域名出问题。拿它去弹「域名暂未生效」会把人带偏。
			if (res && res.provisioned && res.ok === false) {
				showDnsHelpModal(res);
				return;
			}
			await remoteMainAction(lastRemoteBanner);
		}

		/** 重置是「清本机状态」，不是删云端隧道：必须讲清后果再执行。 */
		function confirmResetTunnelState() {
			showUpdateModal({
				title: '重置本机固定地址状态',
				banner: { text: '⚠️ 只清本机状态，不动 Cloudflare', tone: 'warn' },
				lines: [],
				note: '将删除本机的固定地址记录与 ingress 配置（不删除 ~/.cloudflared/cert.pem，'
					+ '也不删除 Cloudflare 上的隧道与 DNS 记录）。重置后需要重新「开启远程」才会分配地址；'
					+ '如果旧地址仍指向这台机器，新地址会换一个前缀。',
				steps: [],
				actions: [
					{ label: '取消', onClick: showCredentialHelpModal.bind(null, summary?.tunnel?.credentials || {}, {}) },
					{ label: '确认重置', primary: true, onClick: (btn) => resetTunnelStateAction(btn) },
				],
			});
		}


		async function resetTunnelStateAction(btn) {
			const restore = setModalBusy(btn, '重置中…');
			showUpdateModal({
				title: '正在重置',
				banner: { text: '⏳ 清理本机固定地址状态', tone: 'info' },
				lines: [],
				note: '正在停止隧道并删除本机状态与 ingress 配置，请稍候（通常 1–3 秒）。',
				actions: [],
			});
			try {
				const res = await fetchJson('/mobile/v1/tunnel/reset', { method: 'POST' }, 25000);
				// 重置只清本机状态，**不会**换掉 cert.pem：如果账号问题还在，
				// 这里必须当场说清，否则用户点完「开启远程」又看到同一个弹窗，
				// 只会得出「重置也没用」的结论。所以重置后立刻复检一次。
				await probe();
				renderSummary();
				const creds = summary?.tunnel?.credentials || null;
				const stillBlocked = Boolean(creds?.blocking);
				showUpdateModal({
					title: stillBlocked ? '已重置，但账号问题还在' : '已重置',
					banner: stillBlocked
						? { text: '⚠️ 本机状态已清空，但登录的 Cloudflare 账号仍管不了这个域名', tone: 'warn' }
						: { text: '✅ 本机固定地址状态已清空', tone: 'success' },
					lines: res?.removed?.length ? [{ label: '已删除', value: res.removed.join('、') }] : [],
					note: stillBlocked
						? '重置只清本机记录，不会换掉 ~/.cloudflared/cert.pem。要让固定地址生效，必须用持有该域名的账号重新授权。'
						: res?.hadState
							? 'Cloudflare 上的隧道与 DNS 记录未删除。点「开启远程」会重新分配固定地址。'
							: '本机本来就没有固定地址状态。点「开启远程」开始分配。',
					steps: [],
					actions: stillBlocked
						? [
							{ label: '关闭', onClick: closeUpdateModal },
							{ label: '重新授权（浏览器）', primary: true, onClick: (b) => startTunnelLogin(b) },
						]
						: [
							{ label: '关闭', onClick: closeUpdateModal },
							{
								label: '开启远程', primary: true,
								onClick: () => { closeUpdateModal(); remoteMainAction(lastRemoteBanner); },
							},
						],
				});
			} catch (err) {
				restore();
				showUpdateModal({
					title: '重置失败',
					banner: { text: '❌ 未能重置本机状态', tone: 'error' },
					lines: [],
					note: `${err?.body?.error?.message || err?.message || String(err)}。可稍后重试，或在终端删除 ~/.dsh/mobile-access/tunnel-named.json。`,
					steps: [],
					actions: [
						{ label: '关闭', onClick: closeUpdateModal },
						{ label: '重试', primary: true, onClick: (b) => resetTunnelStateAction(b) },
					],
				});
			}
		}

		/**
		 * 域名未生效时的排障弹窗。
		 *
		 * 关键是把「异常」翻译成用户能做的三件事，并带上公网当前 NS 让他去注册商对照：
		 * 用户不需要理解 zone/pending，只要看名字对不对得上。
		 */
		function showDnsHelpModal(res = {}) {
			const ns = Array.isArray(res.publicNs) ? res.publicNs : [];
			const zone = res.zone && typeof res.zone === 'object' ? res.zone : null;
			const expectedNs = Array.isArray(zone?.expectedNs) ? zone.expectedNs : [];
			const host = stripUrl(summary?.tunnel?.fixedUrl || summary?.tunnel?.hostname || '');
			const tampered = Boolean(res.tampered);
			// 归因码决定「修法」：moved（域名被另一个账号接管）/ pending（NS 没指过来）/
			// ns-mismatch（NS 与账号不匹配）/ unresolved（已生效但还没查到）绝不共用一套话术。
			const code = tampered ? 'tampered' : (zone?.code || 'unknown');
			const nsLine = expectedNs.length ? { label: '本账号 NS', value: expectedNs.join(' / ') } : null;
			const accountLine = zone?.accountName ? { label: '本账号', value: zone.accountName } : null;

			const bodies = {
				tampered: {
					title: '固定域名被改指',
					banner: '⚠️ CNAME 已不指向本机隧道',
					note: '这条 CNAME 现在指向别处，扫码会把指令发给未知服务器，网关已拒绝下发该地址。',
					steps: [
						'到 Cloudflare 该域名的 DNS 页面，检查上面这条 CNAME 指向哪里。',
						'把它改回本机隧道（或直接删除这条记录）。',
						'回到面板点「重新检测」，通过后重新生成配对码。',
					],
				},
				moved: {
					title: '域名已被另一个账号接管',
					banner: '⚠️ 这个域名不再归本机登录的 Cloudflare 账号',
					note: 'Cloudflare 把这个域名判成了「已迁移（zone moved）」：公网解析走的是另一个 Cloudflare 账号的那份 zone。'
						+ '本机写进自己账号的记录一条都不会下发，所以地址永远解析不到——重装插件、重开隧道都没用。',
					steps: [
						'先确认两台电脑登录的是不是同一个 Cloudflare 账号：每台都跑一次 cloudflared tunnel login，选到不同账号就会形成「同一域名两份 zone、互相抢」。',
						expectedNs.length
							? `在域名注册商处把 NS 改回本账号这一对：${expectedNs.join(' / ')}（当前公网是 ${ns.join(' / ') || '未知'}）。隧道与 DNS 记录都在这边，改回即全部恢复。`
							: '在域名注册商处把 NS 改回本机这个账号分配的一对（Cloudflare 后台该域名页可查）。',
						'若决定改用现在接管的那份 zone：在那台设备上用对应账号重新授权并重新「开启远程」，本机会重建隧道与新地址。',
						'两种做法都只能二选一，别在两边同时改；改完等几分钟回到面板点「重新检测」。',
					],
				},
				pending: {
					title: '域名在本账号未生效',
					banner: '⚠️ 公网 NS 还没指向本账号',
					note: '域名已经加进本账号，但注册商处的 NS 还没指向本账号分配的那一对，Cloudflare 因此不下发这里的记录。',
					steps: [
						expectedNs.length
							? `到域名注册商把 NS 改成：${expectedNs.join(' / ')}（当前公网是 ${ns.join(' / ') || '未知'}）。`
							: '到域名注册商把 NS 改成 Cloudflare 给本账号分配的那一对（后台域名页可查）。',
						'若域名其实已在另一个 Cloudflare 账号里生效，先在那个账号删掉它，否则两边会一直互抢。',
						'NS 生效通常几分钟到几小时；生效后回到面板点「重新检测」，无需重装插件。',
					],
				},
				'ns-mismatch': {
					title: 'NS 与本账号不一致',
					banner: '⚠️ 公网 NS 和本账号分配的对不上',
					note: '本账号里这个域名显示已生效，但公网解析到的 NS 是另一对，说明注册商那边只改了一半或改错了。',
					steps: [
						expectedNs.length ? `确认注册商处的两个 NS 都是：${expectedNs.join(' / ')}。` : '确认注册商处的 NS 与 Cloudflare 后台显示的一致。',
						`当前公网解析到的是：${ns.join(' / ') || '未知'}。`,
						'改完后等几分钟，回到面板点「重新检测」。',
					],
				},
				unresolved: {
					title: '记录还没生效',
					banner: '⚠️ 域名正常，但查不到这条记录',
					note: '域名在本账号已生效、NS 也对，只是公网还没查到这台主机的记录：多半是刚写入还在传播，或记录被删了。',
					steps: [
						'等 1–2 分钟后点「重新检测」。',
						'仍不行就点「开启远程」重建记录（会写回本机隧道）。',
						'如果这个地址刚在另一台电脑上开通过，先确认那台是否把记录改指到了它自己的隧道。',
					],
				},
			};
			const body = bodies[code] || {
				title: '域名暂未生效',
				banner: '⚠️ 公网解析不到这个地址',
				note: '记录已经写进 Cloudflare，但公网解析不到它。通常是这个域名在当前登录的账号里还没生效。',
				steps: [
					'到 Cloudflare 后台看该域名状态是否为「活动 / Active」。',
					`把域名注册商处的 NS 改成该账号分配的 nameserver${ns.length ? `（当前公网是 ${ns.join('、')}）` : ''}。`,
					'NS 生效后回到面板点「重新检测」即可，无需重装插件。',
				],
			};

			showUpdateModal({
				title: body.title,
				banner: { text: body.banner, tone: 'warn' },
				lines: [
					{ label: '固定域名', value: host || '—' },
					...(zone?.status ? [{ label: '本账号 zone', value: zone.status }] : []),
					...(nsLine ? [nsLine] : []),
					...(ns.length ? [{ label: '公网 NS', value: ns.join(' / ') }] : []),
					...(accountLine ? [accountLine] : []),
				],
				note: body.note,
				steps: body.steps,
				actions: [
					{ label: '关闭', onClick: closeUpdateModal },
					{
						label: '重新检测', primary: true,
						onClick: (btn) => recheckDnsAction(lastRemoteBanner, btn),
					},
				],
			});
		}

		/**
		 * 域名解析异常时的主按钮出路：强制重探一次。
		 * 通过 → 直接继续「开启 + 出码」，用户不用再点第二次；不通过 → 给排障步骤。
		 */
		async function recheckDnsAction(banner, btn) {
			// 之前这里是 `if (tunnelBusy) return` —— 定时轮询/重复点击时界面完全没反应，
			// 用户只能理解为「按钮坏了」。现在至少给一句「正在检测」。
			if (tunnelBusy) {
				showModalToast('正在检测中，请稍候…', 'error');
				return;
			}
			lastRemoteBanner = banner || lastRemoteBanner;
			tunnelBusy = true;
			const restore = setModalBusy(btn, '检测中…');
			const mainBtn = panelEl?.querySelector('#dsh-mios-remote-main');
			if (mainBtn) {
				mainBtn.disabled = true;
				mainBtn.textContent = '检测中…';
			}
			// 已有结论时的差异感：结论没变要写在弹窗标题上，否则「关掉又弹出一样的窗」
			// 和「点了没反应」在用户眼里是同一件事。
			const before = summary?.tunnel?.credentials?.state || null;
			try {
				const res = await fetchJson('/mobile/v1/tunnel/recheck-dns', { method: 'POST' }, 25000);
				await probe();
				renderSummary();
				if (res?.ok) {
					// 解析恢复：把动作链接回去（此时 tunnelBusy 必须释放，否则 remoteMainAction 会直接返回）
					tunnelBusy = false;
					if (mainBtn) mainBtn.disabled = false;
					await remoteMainAction(lastRemoteBanner);
					return;
				}
				// 账号/证书问题与 NS 问题是两码事：重探一万次也不会让跨账号的证书变得可用。
				// 先把「换账号 login」这条唯一出口摆出来，别让人照着改 NS 白跑。
				if (res?.credentials?.blocking) {
					const again = Boolean(before && before === res.credentials.state);
					showCredentialHelpModal(res.credentials, { again });
					return;
				}
				showDnsHelpModal(res || {});
			} catch (err) {
				showDnsHelpModal({
					ok: false,
					warning: err?.body?.error?.message || err?.message || String(err),
				});
			} finally {
				restore();
				tunnelBusy = false;
				if (mainBtn) mainBtn.disabled = false;
				renderSummary();
			}
		}

		/** 远程主按钮：一条动作链走完「确保在跑 → 出码」。一次点击出码，绝不让人点两下。 */
		async function remoteMainAction(banner) {
			if (tunnelBusy || bannerBusy.remote) {
				// 静默 return 是「点了没反应」的主要来源之一：告诉用户正在做什么。
				showModalToast(tunnelBusy ? '上一步还没结束，请稍候…' : '正在生成配对码，请稍候…', 'error');
				return;
			}
			lastRemoteBanner = banner || lastRemoteBanner;
			const mainBtn = panelEl?.querySelector('#dsh-mios-remote-main');
			// 缺依赖：不再由插件自己下载（那条链路在慢网络/自定义协议下反复表现为「点了没反应」），
			// 改为给一段可复制指令交给 Harness Agent；任何平台都有出口，不再看 canAutoInstall。
			if (summary?.tunnel?.executable === 'missing') {
				installCloudflaredAction(banner);
				return;
			}
			// 凭据确定不可用（跨账号 / 证书过时）：此刻开通必然在写 DNS 处失败。
			// 已经跑起来的隧道不拦——那种情况用户是在生成配对码，地址本身是通的。
			const creds = summary?.tunnel?.credentials;
			if (creds?.blocking && summary?.tunnel?.state !== 'running') {
				showCredentialHelpModal(creds);
				return;
			}
			// 域名解析异常：先重检，别把人堵在「暂不可开启」上（那就是原来的死锁）
			if (summary?.tunnel?.dnsOk === false) {
				// 已经确诊「域名被另一个 Cloudflare 账号接管」：重探改变不了归属，
				// 直接把原因和两条修法摆出来（弹窗里仍有「重新检测」供改完 NS 后收口）。
				const zone = summary?.tunnel?.zone;
				if (zone?.code === 'moved') {
					showDnsHelpModal({ ok: false, zone, publicNs: zone.publicNs || [] });
					return;
				}
				await recheckDnsAction(banner);
				return;
			}
			const running = summary?.tunnel?.state === 'running' && summary?.tunnel?.dnsOk !== false;
			try {
				if (!running) {
					tunnelBusy = true;
					if (mainBtn) mainBtn.textContent = '开启中…';
					let startErr = null;
					try {
						await tunnelAction('start');
					} catch (err) {
						// 客户端超时 ≠ 服务端失败：cloudflared 可能还在注册路上。
						// 不直接报错收场，继续轮询等它真的起来（或确认起不来）。
						startErr = err;
					}
					const up = await waitForTunnelUp();
					if (!up) {
						// 真没起来才报错；错误信息优先用服务端带回来的
						const t = summary?.tunnel;
						const msg = startErr?.body?.error?.message
							|| (t?.dnsOk === false ? '固定域名尚未在公网生效，请稍后再试' : null)
							|| startErr?.message || '远程通道未能开启';
						throw Object.assign(new Error(msg), { body: startErr?.body });
					}
				}
				bannerBusy.remote = true;
				if (mainBtn) mainBtn.textContent = '生成中…';
				mountCode(banner, await issuePairingCode('tunnel'));
			} catch (err) {
				// 服务端已经归因到「凭据」时，别把一句 Command failed 摆在提示行上——
				// 直接把 login 指引弹出来（这是唯一能修好的动作）。
				if (err?.body?.error?.reason === 'credentials') {
					showCredentialHelpModal({
						...(summary?.tunnel?.credentials || {}),
						hint: err?.body?.error?.message || summary?.tunnel?.credentials?.hint,
					}, { again: true });
				} else {
					const hint = panelEl?.querySelector('#dsh-mios-hint');
					if (hint) {
						hint.textContent = `⚠️ ${err?.body?.error?.message || err.message}`;
						hint.style.display = '';
						hint.style.color = '#d94f3d';
					}
				}
			} finally {
				tunnelBusy = false;
				bannerBusy.remote = false;
				renderSummary();
			}
		}

		async function stopRemoteAction() {
			if (tunnelBusy) return;
			tunnelBusy = true;
			const stopBtn = panelEl?.querySelector('#dsh-mios-remote-stop');
			if (stopBtn) stopBtn.textContent = '停止中…';
			try {
				await tunnelAction('stop');
			} catch (err) {
				const hint = panelEl?.querySelector('#dsh-mios-hint');
				if (hint) {
					hint.textContent = `⚠️ ${err?.body?.error?.message || err.message}`;
					hint.style.display = '';
					hint.style.color = '#d94f3d';
				}
			}
			// 停止即收码：远程关了，码还挂在屏幕上只会误导人去扫
			panelEl?.querySelectorAll('#dsh-mios-remote-main')
				.forEach((btn) => btn.closest('.dsh-mios-banner')?.querySelectorAll('.dsh-mios-code-slot, .err')
					.forEach((e) => e.remove()));
			await probe();
			renderSummary();
			tunnelBusy = false;
		}

		function togglePanel() {
			if (panelEl) removePanel();
			else showPanel();
		}

		// ── banner（slot 渲染，React 元素） ──────────────────────────
		// 注意：slot 渲染回调不是 React 组件（宿主按回调取元素），不能用 hooks；
		// 状态点读模块级 summary，新鲜度由 apply 里的轮询保证，
		// 宿主重渲侧栏时自然取到最新值。面板打开时另有主动 probe()。

		const STATUS_OK = { stroke: '#3fb27f', fill: 'rgba(63,178,127,.18)' };
		const STATUS_DOWN = { stroke: '#d94f3d', fill: 'rgba(217,79,61,.18)' };

		function PhoneIcon() {
			return react.createElement('svg', {
				'aria-hidden': true, focusable: false, width: 16, height: 16,
				viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
				strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
			},
			react.createElement('rect', { x: 4, y: 1, width: 8, height: 14, rx: 2 }),
			react.createElement('path', { d: 'M7 12h2' }));
		}

		function apply(ctx) {
			installStyle();

			// 注入宿主插件管理器：一步更新能力来源。可选能力——用安全读取而非硬依赖，
			// 拿不到时 pluginManager 保持 null，更新弹窗自动降级为「复制包名」手动安装。
			try {
				const remote = (typeof ctx.get === 'function' && ctx.get('remote'))
					|| ctx.remote || null;
				pluginManager = remote?.pluginManager || null;
			} catch { pluginManager = null; }

			// 跨 HMR 重载恢复：一步更新触发插件自更新会卸载本模块，弹窗随之消失。
			// 发起前把状态写入 localStorage，重载后据此显示「更新完成/进行中」反馈。
			try { restorePendingUpdate(); } catch { /* 存储不可用时跳过，不影响主流程 */ }

			// 轮询保持 summary 新鲜（banner 状态点 + 面板数据共用）
			probeUntilUp();
			const pollTimer = setInterval(probe, 15000);

			// 状态面板打开期间保持轮询：banner 的 useGatewayStatus 只在宿主渲染时活跃
			const disposeSlot = ctx.slots.inject('sidebar.footer.action', () =>
				ctx.slots.register(
					{ name: 'sidebar.footer.action', id: 'dsh-mobile-ios' },
					({ wide }) => {
						const ok = !!(summary && summary.ok);
						const tone = ok ? STATUS_OK : STATUS_DOWN;
						return react.createElement('button', {
							className: `dsh-mios-trigger${wide ? '' : ' is-rail'}`,
							type: 'button',
							title: PANEL_TITLE,
							'aria-label': PANEL_TITLE,
							onClick: togglePanel,
						},
						react.createElement('span', {
							className: 'dsh-mios-dot ' + (ok ? 'ok' : 'down'),
							style: { background: tone.stroke },
						}),
						// 名称左边不再放 SVG 手机图标：wide 模式有「📱」emoji 就够了；
					// 窄栏（rail）没有名字，图标仍是唯一的视觉标识，保留。
						wide ? undefined : react.createElement(PhoneIcon),
						wide ? react.createElement('span', null, BANNER_LABEL) : undefined);
					}
				)
			);

			return () => {
				clearInterval(pollTimer);
				disposeSlot();
				removePanel();
				document.getElementById(STYLE_ID)?.remove();
			};
		}

		// 注意：宿主 inject 数组是「硬依赖」，缺失会让整个模块挂起（pending）。
		// remote/pluginManager 属可选能力，只声明 slots；安装服务在 apply 内安全获取。
		const inject = ['slots'];
		exports.apply = apply;
		exports.inject = inject;
		exports.__test = {
			PORT_CANDIDATES, STATUS_OK, STATUS_DOWN,
			showUpdateModal, closeUpdateModal, copyToClipboard,
			showModalToast, offerManualCopy, showDnsHelpModal, recheckDnsAction,
			showCredentialHelpModal, confirmResetTunnelState, resetTunnelStateAction,
			startTunnelLogin, renderLoginModal, pollLogin, stopLoginPoll, afterLoginOk, cancelTunnelLogin,
			performUpdate, checkPluginUpdate, compareVersions, unwrapRemote,
			setPluginManager: (m) => { pluginManager = m; },
			probe, remoteMainAction, renderSummary,
			buildCloudflaredAgentPrompt,
			getSummary: () => summary,
			setUpdateTimeout: (ms) => { UPDATE_TIMEOUT_MS = ms; },
			isUpdateInFlight: () => updateInFlight,
			restorePendingUpdate, readUpdateState, writeUpdateState, clearUpdateState,
		};

		return module.exports;
	},
});
