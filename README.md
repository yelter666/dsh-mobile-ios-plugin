# DSH Mobile iOS（dsh-mobile-ios）

**在 iPhone 上安全地掌控你电脑里的 DeepSeek Harness。**

DSH Mobile iOS 是 DSH Moblie 项目的桌面端插件与 iOS移动伴侣 App 的组合：插件在电脑端提供移动网关（REST + WebSocket），iPhone App 通过局域网或隧道配对连接，实时查看任务进度、追加指令、审批待办、查看产物。桌面端侧栏左下角有「**iOS移动伴侣**」入口，点开即见连接状态与配对码。

面向 iPhone / iPad 采用 **SwiftUI 原生界面**：钥匙串凭证、系统通知、双栏自适应，而非移动网页布局适配。

## 安装

在 DSH 桌面端：**插件 → 添加插件**，输入框填包名 `dsh-mobile-ios`，点安装即可。
输入框接受的就是 **npm 包名**（也可带版本，如 `dsh-mobile-ios@0.2.2`）、Git 仓库
地址或本地插件目录路径。安装源展开后可选：

- **npm 官方源** `registry.npmjs.org`
- **中国大陆镜像源** `registry.npmmirror.com`
- **自定义地址**（内网/私有源，凭据放本机 `~/.npmrc`）

首次未显式选源时，DSH 会并发探测官方源与镜像源的 `/–/ping`，自动选最先响应的那个。
安装前 DSH 会先 `pluginManager.inspect` 校验包名与 bundle patch（本包带
`cordis.patch.yml`，校验可过），再按所选源安装。装好后桌面侧栏左下角出现
「📱 iOS移动伴侣」入口，点开即可生成配对码，iPhone App 扫码连接。

> 本包已发布至 npm：`https://www.npmjs.com/package/dsh-mobile-ios`。
> 也可粘贴仓库地址 `https://github.com/yelter666/dsh-mobile-ios-plugin` 或本地目录路径安装。

### 更新

插件面板右上角的「插件更新」会读 npm registry 的 `latest` 与当前版本比对：

- npm 已发布且有新版：提示到插件页**卸载后重新安装**（或输 `dsh-mobile-ios@版本号`
  更新）——DSH 对非官方按需插件的升级方式是"删除已装包再按相同选择重装"；
- 本地 link 安装的开发态（读不到 registry 版本）：提示 `git pull` 后重启 DSH
  桌面端，插件随源码热重载；
- 网络不可达：如实报不可达，不假装已是最新。

### Windows 注意

远程通道依赖外部可执行文件 `cloudflared`（**不含在本包内**，插件本体纯 JS 双平台通用）。
Windows 上请下载 `cloudflared.exe` 加入 PATH，或设 `CLOUDFLARED_BIN` 指向它；
macOS 用 `brew install cloudflared`。未安装时插件如实隐藏远程入口并给出对应平台指引，
不会伪装可用；局域网通道不依赖 cloudflared，任何平台开箱即用。

---

## 能做什么

- **任务实时同步**：桌面会话在手机上以卡片流呈现——需要你 / 进行中 / 更早三段分组，状态徽标与进度条实时刷新；
- **追加指令与排队**：断线也能写，恢复后自动发送（排队语义如实标注，不假装已送达）；
- **待办审批**：任务需要你决策时提醒，手机上直接答复；
- **产物列表**：任务生成的文件卡片（名称 / 类型 / 体积），事件流实时推送；
- **桌面端侧栏入口**：左下角「iOS移动伴侣」banner——连接状态点、网关摘要（适配器 / 已配对设备 / 隧道）、一键生成配对码；
- **多种通道**：局域网直连（secure-by-default，默认只听回环）+ cloudflared Quick Tunnel（自动重拉 + 地址漂移广播）；
- **凭证安全**：设备凭证存 iOS 钥匙串；配对码 2 分钟有效、限速防爆破、可全量撤销；
- **崩溃隔离（R12）**：网关端口冲突自动顺延（3081–3085），隧道崩溃自动重启，插件 apply 永不向宿主抛异常。

## 快速开始

### 1. 安装插件（DSH Desktop）

普通用户直接用上文「安装」里的包名方式即可。开发态想从源码加载：

```bash
# 在桌面端 profile 注册本地 bundle（改源码后重启 DSH 生效）
dsh plugin --profile desktop add /path/to/dsh-mobile-ios
```

安装后侧栏左下角出现「**iOS移动伴侣**」入口（窄栏时为手机图标 + 状态点）。状态点含义：**绿色** = 网关健康，**红色** = 网关不可达（插件端口被占时会自动顺延并自恢复）。

### 2. 连接 iPhone（局域网）

1. 电脑与手机连上**同一 Wi-Fi**；
2. 点侧栏「iOS移动伴侣」→ 面板内 **生成配对码**（6 位数字，约 2 分钟有效）；
3. iPhone 打开 DSH App → 连接 → 输入电脑地址（`局域网IP:端口`，端口见面板「网关地址」行）与配对码；
4. 首次连接 iOS 会请求「本地网络」权限，请点**允许**。

> 开发联调可用 sidecar 独立进程模式：`node entries/sidecar.mjs --host=mock --dev --lan=true`（mock 宿主回放契约数据，端口 3199）。

### 3. 远程访问（外网）

支持 cloudflared Quick Tunnel（插件自动拉起并广播地址漂移）。命名隧道 / 自建反代接入方式与局域网相同——手机端把地址换成隧道域名即可，凭证与配对机制不变。未安装 cloudflared 时客户端如实隐藏入口（不伪装可用）。

## 安全

- **secure-by-default**：网关默认只监听 `127.0.0.1`；开放局域网是显式动作（`allowLan: true`）；
- **管理面回环-only**：配对码生成、设备撤销、桌面端摘要只允许主机本机操作（同网段设备刷不了码、炸不了同伴设备）；
- **配对凭证**：设备 Token 存 iOS 钥匙串；WS 走一次性票据（TTL 30s）；配对码 5 次/窗限速；
- **脱敏**：隧道日志与诊断包自动抹除 JWT / `dt_` token / Bearer 头；诊断包不含绝对路径、prompt 正文、产物内容；
- **最小摘要**：`/mobile/v1/desktop/summary` 只含版本 / 适配器 / 设备数 / 隧道态等展示字段。

## 故障排查

| 现象 | 处理 |
|---|---|
| 手机提示「无法连接到电脑」 | 确认电脑端 DSH 在运行、手机与电脑同一 Wi-Fi、地址含端口（如 `192.168.x.x:3081`） |
| 配对码过期 | 点侧栏「iOS移动伴侣」重新生成（同窗口限 5 次，旧码立即失效） |
| banner 状态点红色 | 网关未起或端口被占——插件自动顺延 3082–3085，重启 DSH 再试 |
| 手机「需要重新配对」 | 设备被电脑端撤销或凭证过期；手机端「重新配对」不清本地历史 |
| 隧道地址变了 | Quick Tunnel 重启后域名会变（网关会广播 `addr_changed`），手机端用新地址重配对 |
| 提示「登录的 Cloudflare 账号不对」 | 本机 `~/.cloudflared/cert.pem` 不是持有该域名那个账号签发的：在终端执行 `cloudflared tunnel login`，浏览器里选**持有该域名**的账号授权，再回面板点「重新检测」。重装插件 / 重启宿主 / 改 NS 都无效 |
| 固定地址忽然变成另一个前缀 | 本机状态被重置或来自另一台电脑（`tunnel-credentials.mjs` 的 machine 归属校验会拒绝冒充）。点「开启远程」重新分配，或先「重置本机状态」 |

## 兼容性

| 组件 | 要求 |
|---|---|
| 桌面端 | DeepSeek Harness（desktop profile，Node ≥ 20） |
| 手机端 | iOS 18+（iPhone / iPad 通用，双栏自适应；Duo 展开态横屏双栏） |
| 通道 | 局域网 / cloudflared Quick Tunnel / 任意 HTTPS 反代 |

## 工作原理

```
iPhone App ──REST/WS──> dsh-mobile-ios 网关（宿主进程内，回环或 LAN）
                              │
                              ├─ mock 宿主   契约夹具回放（联调基线）
                              └─ mux 宿主    进程内直取宿主 cordis 服务
                                             （sessionController 等，真数据进手机）
桌面端侧栏 banner ← slots 注入 ← lib/client.js（本包 ./client 导出）
```

- 插件与宿主之间走**进程内适配器**（cordis 子上下文向上解析 `sessionController` 等服务），宿主 RPC 的 9 个控制器动作全集与方法映射见 `spike0/RUNBOOK.md` §10；
- 未映射的方法一律返回协议码 `4021`（契约保留位），绝不假装成功；
- 桌面端 banner 通过 `dsh.client` 声明注入宿主 web app（`slots.inject("sidebar.footer.action")`），面板数据来自回环-only 摘要端点。

## 许可

MIT

---

# 开发与架构（附录）

## 1. 目录

```
gateway/                     # 包名 dsh-mobile-ios（插件标识）
├── src/
│   ├── protocol.mjs        契约常量 + 错误码表（含 HTTP 状态与"是否该重试"）
│   ├── ring.mjs            每任务 seq + 环缓冲（容量 2000，缺口如实标记）
│   ├── pairing.mjs         配对码 / 设备凭证 / 限速 / 撤销（损坏自愈 R12）
│   ├── gateway.mjs         传输无关核心：会话、扇出、握手、幂等   ← ADR-12
│   ├── rest.mjs            /mobile/v1/* 一元接口 + 桌面端 CORS 白名单
│   ├── ws.mjs              RFC6455 子集 + 票据鉴权 + 握手泵
│   ├── server.mjs          组装 + 只监听回环 + 端口顺延
│   ├── tunnel.mjs          cloudflared Quick Tunnel 生命周期（GW-8，自动重拉+脱敏）
│   └── adapter/
│       ├── mock-host.mjs   夹具驱动的宿主（D3）
│       ├── mux-host.mjs    HTTP 探测适配器（X2 考古用）
│       └── cordis-host.mjs 进程内真宿主适配器（X2 落地，session/* 映射）
├── lib/client.js           桌面端 UI 注入模块（X3：banner + 面板）
├── entries/
│   ├── plugin.mjs          Cordis 插件入口（apply 永不外抛）
│   └── sidecar.mjs         独立进程入口
├── spike0/
│   ├── probe.mjs           六项验收探测 → last-report.json
│   ├── RUNBOOK.md          验证手册（X1/X2 证据链、借鉴机制、方法表）
│   └── demo-swift/main.swift  Apple 原生协议栈演示客户端
└── test/
    ├── selftest.mjs        端到端自检（鉴权/幂等/握手/续传/隔离/桌面端 CORS）
    ├── resilience.mjs      韧性验收（断链续传/缺口/宿主重启）
    ├── ops.mjs             运维验收（隧道启停/地址漂移/诊断包）
    ├── borrowed.mjs        借鉴机制验收（配对自愈/隧道重拉/脱敏/回环管理面）
    └── mux-table.mjs       X2 方法表验收（32 断言）
```

## 2. 开发命令

```bash
# ① 起服务（mock 宿主，附带开箱可用的配对码）
node entries/sidecar.mjs --host=mock --dev
#    REST  http://127.0.0.1:3081/mobile/v1/health
#    WS    ws://127.0.0.1:3081/ws/mobile

# ② 全量契约测试（11 套件 532 断言）
npm test

# ③ Spike-0 六项验收（本机）
node spike0/probe.mjs
#    真机：node spike0/probe.mjs --host=mux --mux-url=http://127.0.0.1:3000

# ④ Apple 原生客户端演示（先编译一次）
swiftc -O spike0/demo-swift/main.swift -o /tmp/dsh-demo
bash spike0/run-demo.sh            # 自动起服务 → 造 3 帧 → 跑客户端 → 收工
```

## 3. 契约增补（v0.1 → v0.2，全部是加法）

| 增补 | 内容 | 为什么必须加 |
|---|---|---|
| `POST /mobile/v1/ws-ticket` | 返回一次性票据（TTL 30s），能力名 `ws.ticket` | 长期凭证不应出现在 WS 升级路径里；ADR-13 |
| `Authorization: Ticket <t>` | 票据的第二条承载方式 | `URLSession` 不允许自定义 `Sec-WebSocket-Protocol` 时仍能鉴权（已实测） |
| `hello.cursors` | `{taskId: seq}` 逐任务游标 | 契约 v0.1 的 `hello.lastSeq` 是单值，而 `seq` 是每任务独立的——两者不自洽 |
| `ready.degraded` | 宿主未就绪时为 `true` + `reason` | 否则网关会连启动都失败，用户只看到「连不上」 |
| `4021` 的用法 | 能力缺失一律 4021，不返回 5xx | 客户端据此隐藏控件，而不是弹错 |
| `hello.gen` / `ready.genChanged` | 客户端回带上次的 `gen`；不一致则 `gap=true`、`resumed=0` | 只靠客户端比 `gen` 会晚一步——它会先收到「补不到帧」的 ready，误读成「没有新事件」，静默丢数据 |
| `gateway` 事件 `host.restarted` | 重启时推 `{gen, prevGen}`，随后 1012 关闭 | 让在线客户端不必等重连才发现代际变了 |
| `GET /mobile/v1/desktop/summary` | 桌面端 banner 状态摘要（回环-only + CORS 白名单） | X3 侧栏注入需要跨源读健康态与设备数 |

**未改动的部分**：帧形状、错误码含义、`seq` 语义、幂等窗口。v0.1 的 31 份夹具仍可直接回放。

## 4. 边界纪律（ADR-12）

改宿主对接只碰 `src/adapter/`，其余目录**不允许出现任何宿主 API 字面量**。
判定方法：`grep -rn "remote.mux" src/ entries/` 的结果必须只出现在 `adapter/` 内。

`core` 只依赖适配器的 9 个方法：
`info / listTasks / getTask / listArtifacts / createTask / appendMessage / cancelTask / answerTodo / subscribe`。
换插件换 sidecar、换 mock 换真机，都不触碰 `core`。

## 5. 插件接入

`entries/plugin.mjs` 导出 `apply(ctx, config)`，对 Cordis 的假设只有两条：

1. `ctx.effect(cb)` 或 `ctx.on('dispose', fn)` 提供卸载钩子（两者都支持，取先存在的）；
2. `ctx.logger.info` 或可调用 logger 用于日志（都没有则退回 `console`）。

配置项（见 `cordis.patch.yml`）：`port` / `host`（`mock|mux`）/ `muxUrl` / `dev` / `allowLan` / `hostSuffixes` / `printPairingCode` / `autoRestart` / `pairingFile`。
`apply` 返回 `{ok, steps, address, error, ready}`，`probe.mjs` 就是靠 `steps` 判定「挂载」是否成立。

> 若宿主的插件签名不是 `apply(ctx, config)`（例如要求 `export const inject`、或插件目录有 manifest 约束），**只改 `entries/plugin.mjs`，不要动 `src/`**。这是 ADR-12 的收益点。

## 6. 验证证据（本机实测）

| 项 | 结果 |
|---|---|
| `npm test`（11 套件） | **532 通过 / 0 失败**（自检 67 + 运维 44 + 韧性 29 + 借鉴 54 + mux 方法表 53 + 隧道 148 + 帧/产物/附件/增强/会话动作等） |
| `node spike0/probe.mjs`（mock） | **PASS**，6 项阻塞全过；真宿主与 mux 两项目标为 WARN/SKIP（不假装通过） |
| `node spike0/probe.mjs --host=mux`（不可达） | **FAIL**，如实报「宿主降级」与 `status=0`，不是假绿 |
| X1 宿主挂载 | **已验证**（2026-11-16）：desktop profile bundle 加载，127.0.0.1:3081 服务，/health + 配对码 + 4001 鉴权 |
| X2 方法表 | **已落地**：`cordis-host.mjs` 进程内适配器 + 32 断言；真宿主对照 diag 待验 |
| iOS 端到端（`ios/DSHMobileKit`） | **634 / 634** 全绿（Kit spike）+ 模拟器真跑截图链路 |

韧性验收覆盖的关键行为：异常断链后按游标续传（1..7 零丢失零重复）、缺口时 `gap=true` 且 `resumeFrom` 指向真实下界、宿主重启后旧 gen 握手被要求全量重建（`gap=true/resumed=0`）而新 gen 不误报、重启后 seq 从 1 重开、幂等窗口不随重启失效（`duplicate=true`）。

自检覆盖的关键行为：凭证 4001/4009 分流、配对码单次有效与 5 次限速（4029）、`submissionId` 幂等重放、`/rollback` 返 4021、票据一次性（重放 401）、协议版本 4004 + close 1008、installId 不一致 4009、同任务 seq 连续、`lastSeq` 续传、环缓冲缺口标记、停服端口释放、插件卸载端口释放、插件异常不外抛、桌面端 CORS 白名单与预检。

## 7. 明确的未验证项（不要在汇报里说成已完成）

| 项 | 现状 | 谁能解开 |
|---|---|---|
| X2 真宿主实跑对照 | cordis-host 适配器落地但未在真宿主里对照 diag 服务可见性 | 桌面端打开 `host: mux` 重启 |
| R12 插件在宿主进程内的崩溃隔离压测 | 已做 try/catch 与端口顺延，未在真实宿主里压测 | 真机 |
| R9 本地网络权限弹窗取证 | 真机已通基础链路，弹窗文案与「不允许」分支取证待记录 | iPhone 真机 |
| Live Activity | 未实现 | S-2/S-3 |

## 8. S-1 故障注入（本机可跑，不需要真机）

三类失败必须能「可编程复现」，否则 iOS 的「断线不误判」根本测不实。仅 `--dev` 模式开放：

| 端点 | 作用 | 对应验收 |
|---|---|---|
| `POST /__mock/drop` | 不发 close 帧，直接掐 socket | 异常断链 → 重连按游标补帧，零丢失零重复 |
| `POST /__mock/gap {taskId, keep}` | 裁掉旧帧，抬高环缓冲下界 | 游标早于下界 → `gap=true` 且 `resumeFrom` 指向真实下界 |
| `POST /__mock/restart-host {reason}` | 换 gen + 清环 + 推 `host.restarted` + 1012 断开 | 旧 gen 握手 → `gap=true / resumed=0`，强制全量重建 |

两条与宿主有关的约定，都是端到端跑出来才补的：

| 约定 | 原因 |
|---|---|
| `restart-host` 会调用 `host.onHostRestart()`，宿主应把在跑的任务标成 `interrupted` | 真实宿主重启后任务不会复活。宿主若仍报 `running`，客户端刚降级的「已中断 · 可续」会被下一份列表快照覆盖回去，永远转圈（FR-TASK-06） |
| 列表与详情里的 `lastSeq` **由网关补齐**（取环缓冲的 `maxSeq`） | `seq` 属于网关的事件空间，宿主不掌握。宿主返回 0 会让客户端把每份快照判成「比事件旧」而拒用，任务永远停在占位行 |

## 9. 隧道（GW-8）与诊断包（GW-9）

| 接口 | 说明 |
|---|---|
| `GET /mobile/v1/tunnel` | 状态。`executable: missing` 表示主机未装 cloudflared，客户端应**隐藏**入口 |
| `POST /mobile/v1/tunnel/start` | 启动，幂等。地址漂移时向在线会话广播 `gateway{event:"addr_changed"}` |
| `POST /mobile/v1/tunnel/stop` | 关闭并回收子进程（网关退出时也会收，不留孤儿） |
| `POST /mobile/v1/tunnel/provision` | 开通固定地址（幂等）。写 DNS 前先做凭据预检，见 9.1 |
| `POST /mobile/v1/tunnel/recheck-dns` | 强制重探解析 + 强制刷新凭据预检（解开「解析异常」自锁死） |
| `POST /mobile/v1/tunnel/reset` | 清本机固定地址状态与 ingress（不碰 cert.pem、不删云端隧道），幂等 |
| `POST /mobile/v1/tunnel/login` | 发起 Cloudflare 浏览器授权（起 `cloudflared tunnel login`，返回授权链接），幂等 |
| `GET /mobile/v1/tunnel/login` | 授权进度：`idle/waiting/ok/error/canceled` + 链接 + 失败原因 |
| `POST /mobile/v1/tunnel/login/cancel` | 取消等待中的授权并回收子进程 |
| `POST /mobile/v1/tunnel/install-cloudflared` | 用户同意后**启动**自举安装任务（立刻返回 `jobId/downloadUrl`），已装则直接 `reused` |
| `GET /mobile/v1/tunnel/install-cloudflared` | 安装进度：`idle/running/done/failed/canceled` + 真实已下载字节 + 百分比 |
| `POST /mobile/v1/tunnel/install-cloudflared/cancel` | 取消下载任务，面板转「已取消安装」并给手动安装指引 |
| `GET /mobile/v1/diag/bundle` | 脱敏诊断包，含可直接粘贴的 `text` 字段 |

三条硬约束：

1. **不伪装**：未安装 cloudflared → `4021` + 可执行指导，不返回 500，也不给假地址。
2. **地址漂移必须广播**：Quick Tunnel 重启后域名会变，不推 `addr_changed` 客户端会一直连旧域名。
   `lastUrl` 跨 stop/start 保留，正是为了检测这种真实漂移。
3. **诊断包不外发隐私**：不含设备 token、绝对路径、prompt 正文、产物内容（`test/ops.mjs` 有对应断言）。

### 9.1 固定地址开通：换台电脑也必须能自证

分发到另一台电脑后「分配不出固定地址」的根因不是网络，而是**本机凭据与状态的归属**。
这条链路上有五条不可放松的规则（对应 `test/tunnel-credentials.mjs`）：

| 规则 | 实现 | 为什么 |
|---|---|---|
| 开通前预检 cert 的可用性 | `zone-health.verifyCertAccess` | 跨账号的 cert 能列/建隧道、只有写 DNS 会失败；等 CLI 报错时用户已拿到「隧道正常」的假象 |
| 预检只在**确定**不可用时拦人 | `blocking` 状态集 | 断网/证书格式不认识 → `unknown`，不能因此判死一台本来能用的机器 |
| 失败信息保留 `code/reason` | `tunnel-error.explainTunnelFailure` | 旧实现 `split('\n')[0]` 把 `code: 10000, Authentication error` 丢掉，只剩命令回显 |
| 状态带机器归属 | `tunnel-state.machineIdentity` + `isForeignState` | 整份 `~/.dsh` 被拷到新机器时，旧地址指向旧机器；新机器绝不能冒充 |
| 没有 cert.pem 也能起隧道 | `LocalStateProvisioner` | 本地 ingress 与 tunnel 凭据都在本机，日常启动不需要 zone 凭据；端口顺延只重写本地配置 |

诊断矩阵（`TunnelStatus.credentials.state`）：`ok` / `missing`（没有 cert） / `unreadable`（解析不了，降级）
/ `no-token`（旧版证书，降级） / `forbidden`（403） / `zone-missing`（这账号看不到域名） /
`zone-scoped-other`（证书授权的是**另一个域名**） / `account-mismatch`（证书账号 ≠ zone 账号） /
`stale-zone`（证书指向已被重建/删除的 zone） / `zone-moved`（域名被另一账号接管） / `unknown`（网络不可达）。

`zone-missing` 与 `zone-scoped-other` 的区别很关键：前者是账号里真没有这个域名，后者是
**登录时在浏览器里点错了域名**（zone 范围的 token 只覆盖被授权的那一把 zone）。两种情况都要
重新授权，但后者必须在提示里点名「上次授权的是 xxx」。预检因此额外回传
`certAccountName` / `certZoneName`——否则用户在自己的账号里明明看得到目标域名，无从判断
「我刚跑的 login 到底生效了没有」。

### 9.2 一键重新授权（0.2.19）

唯一正确的修法只有一个：**用持有该域名的账号重新授权**。但它需要人在浏览器里点「允许」，
所以插件把这一步做成了一条路，而不是一句终端命令（现场教训：用户重装、重启、点重置、
点重新检测全都无效——这些动作**都不会换掉 cert.pem**）：

| 步骤 | 谁做 | 实现 |
|---|---|---|
| 点「重新授权（浏览器）」 | 用户 | 面板 `startTunnelLogin` → `POST /tunnel/login` |
| 起 `cloudflared tunnel login`、捞授权链接 | 网关 | `cloudflared-login.mjs`（进程级单例，幂等） |
| 浏览器里选账号并授权 | 用户 | 链接来自 cloudflared 输出；面板提供「复制授权链接」 |
| 轮询结果 → 强制重检 → 继续开通 | 面板 | `pollLogin` 每 1.5 秒一次，成功后 `afterLoginOk` |

四条不变量：幂等（等待中重复点不起第二个授权）、不静默（超时/退出码非 0/退出但没生成证书
都有可读原因，且保留 cloudflared 最后几行而不是第一行）、不留孤儿（取消或超时 kill 子进程）、
只覆盖 `HOME`（证书一定落在本机真正使用的 `~/.cloudflared`）。

换账号后 `ensure()` 会自动识别账号变更、重建隧道并**沿用同一个子域**（地址不变、无需重新配对）。

## 10. 新任务会话：会话归属与「拒绝」语义（0.2.21）

这一节记录 2026-11-22 真机上「新建无反应 / 历史会话一条也发不出去」的两个根因，
改动前必读——两处都不是 UI 问题，是**错误分类**和**归属**的问题。

### 10.1 附件被拒不能是可重试错误

真机日志里 `session/attachment-invalid` 出现了 247 次：宿主明确拒绝附件
（`MODEL_DOES_NOT_SUPPORT_IMAGES` / `IMAGES_TOO_LARGE` / `TOO_MANY_IMAGES`），
但网关的宿主错误映射表里没有这一条 → 兜底成 `4500`（可重试）→ 客户端用同一个
`submissionId` 无限重放 → 写队列保序、队首永不前进 → **后面所有消息都发不出去**。

现在的分类（`src/adapter/host-errors.mjs`，映射从 cordis-host 抽出来单独可断言）：

| 宿主错误 | 网关码 | 语义 |
|---|---|---|
| `session/attachment-invalid` | `4400` | 不可重试；`message` 是能行动的那一句，`reason` 保留宿主 original code |
| `session/model-unavailable` | `4400` | 同上：模型不存在/不可用，重发也没用 |
| 其余未知宿主码 | `4500` | 仍按可重试兜底 |

客户端还有第二道刹车：**服务端侧退回**计数到上限（默认 6 次）就把该条判失败、
让出队首（`WriteQueue.maxServerDeferrals`）。网络层错误不计数，所以真离线排队
不会被误杀。

### 10.2 会话归属：`workspaceId` 而不是让客户端算路径

工作区在宿主里就是**一个已存在目录的注册**。手机端不该猜目录，只传分组 id：

- `POST /mobile/v1/workspaces { path, title? }` → 201 `{ workspaceId, path, title, created }`；
  路径必须绝对且已存在（相对路径前置拦成 `4400`，不打宿主）；同一目录重复登记幂等（`created: false`）。
- `POST /mobile/v1/tasks { workspaceId? }` → 网关 `resolveWorkspaceTarget` 把 `cwd` 设成
  工作区 `path`，建完会话调 `Workspace.attachSession(sessionId)` 归组；
  **省略 = 未分组**，`cwd` 交给电脑端默认工作目录。

宿主 `attachSession` 会比对会话 header 的 `cwd` 与 `workspace.path`（`realpath` 规范化后
必须严格相等），所以网关必须先用工作区路径建会话、再 attach——顺序反了会抛错。

## 11. 时间线附件与 mock 形状（0.2.22）

### 11.1 图片消息不该在时间线里消失

真机会话 `session-b77cabee` 的 seq=318 取证：用户发的纯图片消息**只有两张 image 块、
没有 text 块**。旧的 `session-history.mjs` 先算 text、`if (!text) break`，把整条丢掉——
手机表现为「发了图，聊天记录里什么都没有」，刷新后也看不到。

现在的规则（`translateRecords` 与 `translateLiveEvent` 同口径）：

- 先按 `source.kind === 'user'` 过滤（系统注入 / ptc-mode 的截图仍丢弃）；
- 有正文：文本保持正文原样，附件放 `attachments[]`——手机本地回声靠「文本相等」
  去重，正文后面拼占位行会让同一条消息出现两个气泡；
- 纯附件：`text` 用占位行（如 `［图片 2 张 · 共 735 KB］`、`［文件 · 报价.pdf］`），
  这样即时帧和冷启动历史都能看到消息存在；
- 时间线只带摘要，不带图片字节。缩略图走 `GET /mobile/v1/attachments/sha256:<64hex>`
  （文件头识别 MIME、inline 直接预览；只接受 sha256，路径收边杜绝穿越）。

模型目录（`appSettings` / `sessionSettings`）现在透传 `inputModalities`：手机能在选图前
提示「这个模型不接受图片」，而不是等宿主在 prompt 准入处拒了才发现。

### 11.2 mock 是契约样本，不能自创形状

mock 的 `pendingTodos` 曾经是 `{ question, options:[{id,label}], createdAt }`——契约
`Todo` 里根本没有这些字段（required 是 `todoId/type/state/prompt`，options 是字符串
枚举）。客户端严格解码时一条坏待办把整份 TaskDetail 解崩，表现是「没有输出、产物
胶囊整片消失」；排查时照着 mock 反推宿主，绕了两轮才定位是假数据。

现在 `mock-data.mjs` 与 `spec/fixtures/tasks/task.detail.json` 都按 `Todo` 形状给样本，
`test/timeline-attachments.mjs` 逐字段锁住 required / enum。原则：**mock 只能给契约里
有的字段，且形状必须与 schema 一致**——否则「看起来像没数据」的假故障会反复出现。

## 12. cloudflared 安装：交给 Harness Agent（0.3.1）

新机器装插件后点「确认下载并安装」反复有「毫无反应」的现场反馈。0.3.0 曾把下载改成
真实字节进度 + 单例任务 + 取消/失败出口（见 `docs/setup/cloudflared_安装无反应_问题评估与方案.md`），
但真机仍不可用：**慢网络 + Electron `dsh-app://` 自定义协议下的剪贴板/下载能力，靠插件自己
在面板里全部兜住不现实**。0.3.1 改为把「装」这件事整体交出去：

- **插件不再自己下载**：缺 cloudflared 时弹窗给一段**可直接复制的指令**，
  用户粘贴给 DeepSeek Harness 桌面端 Agent，由 Agent 下载、解压、放到私有目录并调试隧道。
- **复制不能只押在按钮上**：指令框是可见、只读、打开即自动全选的 textarea；
  `⌘/Ctrl+C` 永远能拿到。复制按钮点击即显示「复制中…」。
- **剪贴板 API 必须带超时**：`navigator.clipboard.writeText()` 在自定义协议下可能永远
  pending，直接 `await` 会把点击处理挂死（这正是「复制包名点了没反应」的根因）。
  `copyToClipboard()` 用 800ms 竞速后降级到**弹窗内可见文本框** → 屏幕外 textarea →
  contenteditable；全失败才补一个可手选输入框。更新弹窗同样带可见包名框。
- **服务端能力保留不删**：`POST/GET /tunnel/install-cloudflared` 与其状态机、校验仍可用于
  其他调用方（如脚本），但面板入口不再依赖它，`summary.canAutoInstall` 也不再是弹窗门槛
  ——任何平台缺依赖都有「复制指令找 Agent」的出口。
- **装完能收口**：点「我装好了，继续」→ `probe()` 确认 `executable === 'found'` →
  继续「确保隧道起来 → 出码」；没装好则原地提示，不关窗、不假成功。

回归：`test/install-continue.mjs`（25 断言：指令完整性、六平台地址、自动全选、
复制成功/失败兜底、**不再触发网关下载**、装好继续/没装不冒进）、
`test/update-dialog.mjs`（含 `clipboard.writeText` 永久挂起的 800ms 降级断言）、
`test/install-progress.mjs`（服务端状态机保留）。

## 13. 下一步

1. **X2 真宿主实跑**：desktop profile 的 `cordis.patch.yml` 打开 `host: mux` 重启，对照 diag 服务可见性。
2. 真机安装 cloudflared 后（macOS `brew install cloudflared`；Windows 下载 `cloudflared.exe`
   加入 PATH），把 `--tunnel-bin` 指向真实可执行文件复跑 `test/ops.mjs`，确认解析逻辑与真实
   输出格式一致（当前用假脚本验证的是格式契约，不是真实二进制）。
3. iOS 界面层持续完善（连接指引页 / 附件契约升级 / 模型选择宿主映射）。
