// distribution-config.mjs — 分发形态的固定地址开通服务配置（唯一来源）
//
// 部署 services/tunnel-enroll（Cloudflare Workers）后，把返回的 workers.dev
// 地址与分发 enroll 凭证填在这里。这两个值**可以随插件公开分发**：
//   · 泄露后果仅是「别人能在 matrixboard.cn 下开自己的隧道」，限速 + 撤销兜底；
//   · zone 级 API Token 在 Worker secret 里，永远不出服务端。
// 运营侧改这里 + npm publish 即完成轮换。

export const DISTRIBUTION_TUNNEL = {
  /** 开通服务地址（已部署并绑定自有域名，workers.dev 在国内被 DNS 污染不可用） */
  endpoint: 'https://enroll.matrixboard.cn',
  /** 分发 enroll 凭证；null = 未配置（面板退回自托管引导） */
  enrollToken: 'dsh-enroll-216d924894ccb350b0908fd9d1c7e14dc5058134e7643ecc61fa9c5ca961c1a6',
  baseDomain: 'matrixboard.cn',
};
