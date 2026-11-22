# dsh-tunnel-enroll — matrixboard.cn 固定地址开通服务（Cloudflare Workers）

分发形态的固定地址开通服务：插件主机拿 enroll 凭证向本服务换隧道三件套
（`dsh-xxxx.matrixboard.cn` 子域 + tunnelId + tunnel token），**小白用户全程
不需要任何 Cloudflare 账号**。zone 级 API Token 只存在于 Worker secret。

方案与安全边界：`docs/product/DSH-mobile_固定地址开通方案.md`（v1.0）。
主机侧实现：`gateway/src/cloudflare.mjs` 的 `HostedProvisioner`（合约一一对应）。

## 一次性部署（运营方）

```bash
cd services/tunnel-enroll
npx wrangler login          # 或 CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
npx wrangler secret put CF_API_TOKEN     # 最小权限：Account→Tunnel:Edit、Zone(matrixboard.cn)→DNS:Edit + Zone:Read
npx wrangler secret put ENROLL_TOKENS    # 分发凭证，逗号分隔，例如：dsh-enroll-<64位随机hex>
npx wrangler deploy
```

部署完成后记下地址（形如 `https://dsh-tunnel-enroll.<account>.workers.dev`）。

## 已部署实例（2026-11-22）

- 生产地址：**`https://enroll.matrixboard.cn`**（Worker 自定义域绑定，
  `workers.dev` 在国内被 DNS 污染不可用，必须走自有域名）。
- `wrangler.toml` 已写入 ACCOUNT_ID / ZONE_ID / routes；secrets：`CF_API_TOKEN`、`ENROLL_TOKENS`。
- endpoint + enrollToken 已回填 `gateway/src/distribution-config.mjs`（可随插件公开分发）。

## 插件侧接入（部署完成后）

1. `gateway/src/distribution-config.mjs` 填入 `ENDPOINT` 与 `ENROLL_TOKEN`
   （这两个值**可以随插件分发**：泄露后果仅是别人能在你的域名下开自己的隧道，
   用限速 + 撤销兜底；zone 权限永远不出 Worker）。
2. 撤销/轮换：更新 `ENROLL_TOKENS` secret 并重新 deploy，旧 token 立即失效。

## 硬限速（已配置 2026-11-22）

Worker 内置 isolate 级 best-effort 限速（20 次/小时/token）。硬限制已通过
zone WAF rate limiting 规则下发（免费套餐参数）：`enroll.matrixboard.cn/v1/tunnel`
同 IP 每 10 秒 1 次，超限封 10 秒（规则 ID `440c536e…`，实测第 2 连发请求 429）。
注意：免费套餐只允许 period=10 / requests_per_period=1 / mitigation_timeout=10；
升级付费后可放宽到 5 次/分钟 + 600 秒封禁。

## 本地测试

```bash
cd gateway && npm test    # 含 services/tunnel-enroll/test/enroll-worker.mjs（模拟 CF API，零网络）
```
