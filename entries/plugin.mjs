// entries/plugin.mjs — DSH 插件入口（决策 D1 / ADR-08）
// 三条纪律：
//   1. apply() 永不向外抛异常（R12：插件跑在宿主进程内，抛出去可能带崩宿主）；
//   2. 端口冲突自动顺延，已由 server.mjs 兜底；
//   3. 宿主卸载插件时必须彻底释放 socket / 定时器，不留孤儿监听。

import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/server.mjs';
import { createFileLog } from '../src/file-log.mjs';
import { findCloudflared, sweepOrphanTunnels } from '../src/tunnel.mjs';
import { createMockHost } from '../src/adapter/mock-host.mjs';
import { createMuxHost } from '../src/adapter/mux-host.mjs';
import { createCordisHost } from '../src/adapter/cordis-host.mjs';
import { resolveProvisioner, defaultTunnelStateFile } from '../src/provision-select.mjs';
import { DISTRIBUTION_TUNNEL } from '../src/distribution-config.mjs';
import { PLUGIN_VERSION } from '../src/version.mjs';

export const name = 'dsh-mobile-ios';
export const version = PLUGIN_VERSION;

/**
 * 本机 cloudflared 发现链统一在 src/tunnel.mjs 的 findCloudflared：
 * config.tunnelBin → env CLOUDFLARED_BIN → 组件目录（~/.dsh/mobile-access/components/cloudflared/<版本>/）
 * → PATH。这里不再自己扫一遍目录 —— 两份实现曾经对 .exe 后缀的判断不一致，
 * 直接导致「装好了但开通器找不到」。
 */
function resolveCloudflared(config = {}) {
  return config.tunnelBin || findCloudflared('auto') || 'auto';
}

/** 兼容 Cordis 的两种清理注册方式；都不可用时退化为 no-op 并明确记录 */
function onCleanup(ctx, fn) {
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => fn, 'dsh-mobile-ios:dispose');
    return 'ctx.effect';
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', fn);
    return "ctx.on('dispose')";
  }
  return 'none';
}

export function apply(ctx = {}, config = {}) {
  const steps = [];
  const record = (step, ok, detail = '') => {
    steps.push({ step, ok, detail });
    return ok;
  };

  const logger = ctx?.logger;
  const toHost = (msg) => {
    if (logger?.info) logger.info(`[dsh-mobile] ${msg}`);
    else if (typeof logger === 'function') logger(msg);
    else console.log(`[dsh-mobile] ${msg}`);
  };
  // 双写：宿主 logger（开发态看控制台）+ 自己的落盘文件。
  // 之所以必须落盘：宿主 logger 的输出在用户机器上取不到，出问题只能靠猜。
  const log = createFileLog({ mirror: toHost, file: config.logFile || undefined });

  const handle = {
    ok: false,
    steps,
    gateway: null,
    address: null,
    error: null,
  };

  try {
    record('cordis.ctx', Boolean(ctx && typeof ctx === 'object' && (ctx.effect || ctx.on || ctx.logger)), 'ctx 可用');

    // host 形态：
    //   · mux/cordis —— **进程内直取宿主 cordis 服务**（默认：真宿主内的产品路径；
    //                  X2 闭环：sessionController 等 service 向上解析，owner 信任级）；
    //   · mock    —— 契约夹具回放（联调/截图基线），需显式 config.host='mock' 或 env；
    //   · 'http'  —— 探测式 HTTP 宿主（考古确认 /api/remote.mux 不存在，仅保留 probe 诊断）。
    const hostKind = config.host || process.env.DSH_MOBILE_HOST || 'mux';
    log(`boot  version=${version} hostKind=${hostKind} port=${config.port || process.env.DSH_MOBILE_PORT || 3081}`);
    const host =
      hostKind === 'mux' || hostKind === 'cordis'
        ? createCordisHost({
            ctx, log,
            hostname: config.hostName,
            // 桌面端登录账号（0.3.9）：config.user / config.hostUser 二选一；
            // 都没有时适配器内部还会尝试宿主上下文，最终取不到就不发字段。
            user: config.user || config.hostUser,
          })
        : hostKind === 'http'
          ? createMuxHost({ baseUrl: config.muxUrl || process.env.DSH_MUX_URL, token: config.muxToken, log })
          : createMockHost({ log, autoPlay: Boolean(config.autoPlay) });
    record('adapter', true, `kind=${host.kind}`);

    // 启动是异步的，但 apply 必须同步返回；用 then/catch 兜住，
    // 宿主立刻卸载时 stop() 也能在 server 起来之后生效。
    // 启动前清扫孤儿隧道（见 tunnel.mjs sweepOrphanTunnels）：dsh web 每次重启
    // 会泄漏指向死端口的 cloudflared，同一组件目录二进制，顺手治好。
    const componentDir = path.join(os.homedir(), '.dsh', 'mobile-access', 'components', 'cloudflared');
    sweepOrphanTunnels({ componentDir, log })
      .then((r) => { if (r.killed > 0) log(`tunnel sweep: 清理 ${r.killed} 个孤儿隧道`); })
      .catch(() => { /* 清扫失败不挡启动 */ });

    /**
     * Pro 固定地址开通器。判定统一在 resolveProvisioner（与 sidecar 同一套顺序）：
     *   1. config.tunnel.provisioner（显式指定，尊重运营决定）
     *   2. 开通服务（endpoint + enrollToken，产品形态；zone 权限留在服务端）
     *   3. Cloudflare API（config 或 env 里有 accountId + apiToken）
     *   4. 本地管理型（~/.cloudflared/cert.pem 存在，说明跑过 tunnel login）
     *   5. 只读状态（以前开通过，日常启动不该再要 zone 凭据；token 或本地 ingress 两种形态）
     * 都没有就保持 Quick Tunnel——免费层行为一字不改。
     *
     * 两个入口共用同一个判定，是为了避免「同一台机器换个启动方式就换一种结论」：
     * 那会让固定地址时有时无，用户只会觉得插件坏了。
     */
    const tunnelCfg = config.tunnel || {};
    const tunnelStateFile = tunnelCfg.stateFile || defaultTunnelStateFile();
    const cloudflareBin = resolveCloudflared(config);

    // 开通器判定参数收敛成一份：启动判定与运行时重建（登录授权拿到 cert.pem 后）
    // 必须用同一套输入，否则重建后的结论会和启动时不一致。
    const provisionerInput = {
      tunnelCfg: {
        ...tunnelCfg,
        // 环境变量兜底：与 sidecar 一致，避免只在某个入口生效
        apiToken: tunnelCfg.apiToken || process.env.DSH_CF_API_TOKEN,
        accountId: tunnelCfg.accountId || process.env.DSH_CF_ACCOUNT_ID,
        zoneId: tunnelCfg.zoneId || process.env.DSH_CF_ZONE_ID,
        endpoint: tunnelCfg.endpoint || process.env.DSH_TUNNEL_ENDPOINT || DISTRIBUTION_TUNNEL.endpoint,
        enrollToken: tunnelCfg.enrollToken || process.env.DSH_TUNNEL_ENROLL_TOKEN || DISTRIBUTION_TUNNEL.enrollToken,
        baseDomain: tunnelCfg.baseDomain || process.env.DSH_TUNNEL_BASE_DOMAIN || DISTRIBUTION_TUNNEL.baseDomain,
        executable: cloudflareBin,
      },
      stateFile: tunnelStateFile,
      hostId: 'host_cordis',
      log,
    };
    const provisioner = resolveProvisioner(provisionerInput);

    const booting = createGateway({
      host,
      port: Number(config.port || process.env.DSH_MOBILE_PORT || 3081),
      dev: Boolean(config.dev),
      // 局域网监听默认开：手机连电脑是产品核心路径。
      // 安全边界不靠监听面，靠管理面回环-only（summary/pairing-code/revoke，见 rest.mjs）
      // + 配对码一次性 + 设备 Bearer。显式 config.allowLan=false 可关。
      allowLan: config.allowLan !== undefined ? Boolean(config.allowLan) : true,
      hostSuffixes: config.hostSuffixes || ['trycloudflare.com'],
      // 借鉴 dsh-plugin-mobile-gateway 的 gatewayStateFile：设备注册表落盘后
      // 配对跨宿主重启保留，手机不用反复重配。分发形态给默认落盘路径
      // （显式 config.pairingFile / 环境变量仍优先；测试与临时实例传 null 走内存）。
      pairingFile: config.pairingFile
        || process.env.DSH_MOBILE_PAIRING_FILE
        || path.join(os.homedir(), '.dsh', 'mobile-access', 'dsh-mobile-ios-devices.json'),
      // 插件形态默认开隧道自动重拉（sidecar/dev 形态不开，避免测试时空转）
      tunnelAutoRestart: config.autoRestart !== undefined ? Boolean(config.autoRestart) : true,
      // 隧道可执行文件发现链（见 resolveCloudflared）；显式 config.tunnelBin 优先
      tunnelExecutable: cloudflareBin,
      tunnelProvisioner: provisioner,
      // 登录授权拿到 cert.pem 后运行时重判（全新机器 → 授权 → 固定地址 的关键链路）
      rebuildProvisioner: () => resolveProvisioner(provisionerInput),
      log,
    })
      .then(async (gw) => {
        handle.gateway = gw;
        const addr = await gw.start();
        handle.address = addr;
        handle.ok = true;
        log(`ready ${addr.address}:${addr.port} ${JSON.stringify(addr)}`);
        if (host.kind === 'mock' && config.printPairingCode !== false) {
          const issued = gw.pairing.issueCode({ deviceName: 'plugin-mock' });
          log(`配对码 ${issued.code}（仅 mock 适配器；真实宿主下由桌面端界面展示）`);
        }
        return gw;
      })
      .catch((err) => {
        handle.error = err.message;
        record('listen', false, err.message);
        log(`启动失败：${err.message}`);
        return null;
      });

    record('listen', true, '异步绑定中（见 handle.address）');

    const cleanupVia = onCleanup(ctx, () =>
      booting
        .then((gw) => gw?.stop())
        .catch((err) => log(`清理异常：${err.message}`))
    );
    record('lifecycle', cleanupVia !== 'none', cleanupVia);

    // 注意：cordis 的 ctx 是受控代理，**不允许**直接挂新属性（会抛
    // `cannot set property ... without provide`）。之前这行在 apply 末尾抛出，
    // 被 catch 吞掉后只能靠日志发现——顺手去掉，handle 由 apply 的返回值给出。
    handle.ready = booting;
    return handle;
  } catch (err) {
    // 绝不外抛：记录后让宿主继续跑
    handle.error = err.message;
    record('apply', false, err.message);
    try {
      log(`apply 异常已吞掉（防带崩宿主）：${err.stack || err.message}`);
    } catch {
      /* logger 本身坏掉时也不能抛 */
    }
    return handle;
  }
}

export default { name, version, apply };
