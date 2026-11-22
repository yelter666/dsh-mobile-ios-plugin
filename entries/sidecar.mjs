// entries/sidecar.mjs — 独立进程入口（X1 不通过时的降级路径）
// 与插件入口共用同一个 core：形态不同，契约一致。

import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/server.mjs';
import { resolveProvisioner } from '../src/provision-select.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { createMuxHost } from '../src/adapter/mux-host.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

const port = Number(args.port || 3081);
const dev = args.dev === 'true';
const allowLan = args.lan === 'true';
const hostKind = args.host || 'mock';

const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

const host =
  hostKind === 'mux'
    ? createMuxHost({ baseUrl: args['mux-url'], token: args['mux-token'], log })
    : createMockHost({ autoPlay: args.autoplay === 'true', log });

if (hostKind === 'mux') {
  const probe = await host.probe();
  log(`mux   probe ${probe.ok ? 'OK' : 'FAIL'} status=${probe.status} ${probe.url}`);
}

// 固定地址开通器（可选）：判定与插件入口共用 resolveProvisioner——
// 同一台机器换个启动方式不该得到不同结论（那会让固定地址时有时无）。
const tunnelStateFile = args['tunnel-state'] || process.env.DSH_TUNNEL_STATE_FILE
  || path.join(os.homedir(), '.dsh', 'mobile-access', 'tunnel-named.json');
const provisioner = resolveProvisioner({
  tunnelCfg: {
    provisioner: args['tunnel-provisioner'] || undefined,
    apiToken: args['cf-token'] || process.env.DSH_CF_API_TOKEN,
    accountId: args['cf-account'] || process.env.DSH_CF_ACCOUNT_ID,
    zoneId: args['cf-zone'] || process.env.DSH_CF_ZONE_ID,
    baseDomain: args['tunnel-domain'] || process.env.DSH_TUNNEL_BASE_DOMAIN || 'matrixboard.cn',
    prefix: args['tunnel-prefix'] || 'dsh',
    endpoint: args['tunnel-endpoint'] || process.env.DSH_TUNNEL_ENDPOINT,
    enrollToken: args['tunnel-enroll'] || process.env.DSH_TUNNEL_ENROLL_TOKEN,
    executable: args['tunnel-bin'] || 'cloudflared',
  },
  stateFile: tunnelStateFile,
  log,
});

const gw = await createGateway({
  host,
  port,
  dev,
  log,
  allowLan,
  hostSuffixes: args['host-suffix'] ? String(args['host-suffix']).split(',') : [],
  // auto：在 PATH 里找 cloudflared；也可指定绝对路径，或设 CLOUDFLARED_BIN。
  // 找不到时隧道接口返回 4021，不影响网关其余功能。
  tunnelExecutable: args['tunnel-bin'] || 'auto',
  tunnelProvisioner: provisioner,
  // 登录授权拿到 cert.pem 后运行时重判（与 plugin 入口同一约定）
  rebuildProvisioner: () => resolveProvisioner({
    tunnelCfg: {
      provisioner: args['tunnel-provisioner'] || undefined,
      apiToken: args['cf-token'] || process.env.DSH_CF_API_TOKEN,
      accountId: args['cf-account'] || process.env.DSH_CF_ACCOUNT_ID,
      zoneId: args['cf-zone'] || process.env.DSH_CF_ZONE_ID,
      baseDomain: args['tunnel-domain'] || process.env.DSH_TUNNEL_BASE_DOMAIN || 'matrixboard.cn',
      prefix: args['tunnel-prefix'] || 'dsh',
      endpoint: args['tunnel-endpoint'] || process.env.DSH_TUNNEL_ENDPOINT,
      enrollToken: args['tunnel-enroll'] || process.env.DSH_TUNNEL_ENROLL_TOKEN,
      executable: args['tunnel-bin'] || 'cloudflared',
    },
    stateFile: tunnelStateFile,
    log,
  }),
});
const addr = await gw.start();

if (host.kind === 'mock') {
  const issued = gw.pairing.issueCode({ deviceName: 'sidecar' });
  log(`pair  配对码 ${issued.code}（${issued.expiresInSec}s 内有效，单次）`);
  log('pair  提示：这仅用于本机联调；真实产品里配对码只出现在桌面端界面');
}
log(`srv   REST  http://127.0.0.1:${addr.port}/mobile/v1/health`);
log(`srv   WS    ws://127.0.0.1:${addr.port}/ws/mobile`);
if (dev) {
  log('srv   dev 端点：POST /__mock/emit , GET /__mock/state');
  log('srv   dev 故障注入：POST /__mock/drop | /__mock/gap | /__mock/restart-host');
}
log(`srv   隧道   GET /mobile/v1/tunnel（模式=${gw.tunnel.mode} 可执行文件=${gw.tunnel.status().executable}）`);
if (provisioner) log(`srv   固定地址 POST /mobile/v1/tunnel/provision（${provisioner.kind} · ${provisioner.baseDomain}）`);

const shutdown = async (sig) => {
  log(`srv   ${sig} 收到，正在退出`);
  try {
    await gw.stop();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
