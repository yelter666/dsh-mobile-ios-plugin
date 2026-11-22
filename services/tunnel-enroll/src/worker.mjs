// worker.mjs — matrixboard.cn 固定地址开通服务（Cloudflare Workers，产品形态）
//
// 合约（与 gateway/src/cloudflare.mjs 的 HostedProvisioner 一一对应）：
//   POST /v1/tunnel
//   Authorization: Bearer <enrollToken>
//   { "hostId": "host_cordis", "port": 3081, "subdomain": "dsh-xxxx"|null }
//   → 200 { "hostname": "dsh-xxxx.matrixboard.cn", "tunnelId": "...", "token": "eyJ..." }
//   → 401/400/409/429 { "message": "..." }（HostedProvisioner 会把 message 原样展示）
//
// 安全边界（与 docs/product/DSH-mobile_固定地址开通方案.md §1 一致）：
//   · zone 级 API Token 只存在于本 Worker 的 secret（CF_API_TOKEN），主机侧永远拿不到；
//   · 主机只落一份 0600 状态文件（tunnel token + 固定域名），泄露只影响单台机器；
//   · 主机侧对返回 hostname 做越界校验（必须 .matrixboard.cn 结尾），Worker 侧不可能越权，
//     但仍以 BASE_DOMAIN 拼接，绝不透传任何客户端提供的域名；
//   · enroll token 是分发凭证（可随插件内置）：泄露后果只是「别人能在你的域名下开自己的隧道」，
//     用限速 + 撤销（更新 ENROLL_TOKENS secret）兜底，不给写权限、不给读权限。
//
// 幂等（与 CloudflareProvisioner 同语义）：
//   · tunnel 按 name 查找复用，绝不重建；
//   · ingress 每次重写（端口顺延必须跟随）；
//   · DNS 记录存在且指向正确就跳过；
//   · subdomain 由客户端缓存回传（首次为 null → 服务端随机生成并落进响应）。

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])?$/;
const LOCAL_MANAGED_DELETED_AT = '0001-01-01';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function fail(status, message) {
  return json({ message }, status);
}

/** 简单限速：isolate 内 best-effort，硬限制建议在 Cloudflare WAF 配 rate limit 规则。
 *  状态收在 handler 闭包里（每实例独立），不与模块级状态串扰。 */
function makeRateLimiter(limit = 20, windowMs = 3600_000) {
  const state = new Map(); // tokenFingerprint -> { count, windowStart }
  return (fingerprint) => {
    const now = Date.now();
    const cur = state.get(fingerprint);
    if (!cur || now - cur.windowStart > windowMs) {
      state.set(fingerprint, { count: 1, windowStart: now });
      return true;
    }
    cur.count += 1;
    return cur.count <= limit;
  };
}

async function cfApi(fetchImpl, apiToken, method, pathname, body) {
  let res;
  try {
    res = await fetchImpl(`${CF_API_BASE}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw { status: 502, message: `无法连接 Cloudflare API：${err?.message || err}` };
  }
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw { status: 502, message: `Cloudflare API 返回了非 JSON 响应（HTTP ${res.status}）` };
  }
  if (!payload || payload.success !== true) {
    const first = payload?.errors?.[0];
    throw { status: 502, message: `Cloudflare 拒绝了请求：${first?.message || `HTTP ${res.status}`}` };
  }
  return payload.result;
}

/**
 * 创建可测试的请求处理器。生产入口 default.fetch 直接传 env；
 * 测试注入 fetchImpl 与自定义 env（不发真实网络请求）。
 */
export function createEnrollHandler(env, { fetchImpl = globalThis.fetch } = {}) {
  const rateLimit = makeRateLimiter();
  const baseDomain = String(env.BASE_DOMAIN || 'matrixboard.cn').replace(/^\./, '').toLowerCase();
  const prefix = String(env.PREFIX || 'dsh').toLowerCase();
  const enrollTokens = String(env.ENROLL_TOKENS || '')
    .split(',').map((t) => t.trim()).filter(Boolean);

  const auth = (request) => {
    const header = request.headers.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || !enrollTokens.includes(token)) return null;
    return token;
  };

  async function ensureTunnel(name) {
    const accountId = env.ACCOUNT_ID
      || (await (async () => {
        const list = await cfApi(fetchImpl, env.CF_API_TOKEN, 'GET', '/accounts');
        const accounts = (Array.isArray(list) ? list : []).filter((a) => a && a.id);
        if (accounts.length !== 1) {
          throw { status: 500, message: 'Worker 未配置 ACCOUNT_ID 且 API Token 可见多个账号' };
        }
        return accounts[0].id;
      })());
    const list = await cfApi(fetchImpl, env.CF_API_TOKEN, 'GET',
      `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
    const hit = (Array.isArray(list) ? list : []).find((t) => t && t.name === name
      && (!t.deleted_at || String(t.deleted_at).startsWith(LOCAL_MANAGED_DELETED_AT)));
    if (hit && hit.remote_config !== false) {
      return { accountId, id: hit.id, created: false };
    }
    if (hit) {
      // 0.3.3 之前 local 形态开通的同名隧道（本地管理、credentialsFile 形态）。
      // 主机升级到 hosted 后拿不到 token，自动迁移：删旧建新（同名，DNS 随后重指）。
      // 有活跃连接时删除会被 Cloudflare 拒绝 → 409 让用户先停掉本机 cloudflared。
      try {
        await cfApi(fetchImpl, env.CF_API_TOKEN, 'DELETE',
          `/accounts/${accountId}/cfd_tunnel/${hit.id}`);
      } catch (err) {
        throw { status: 409, message: `已存在同名本地管理隧道 ${name}，自动迁移失败（隧道可能有活跃连接）：请停止本机 cloudflared 后重试（${err?.message || ''}）` };
      }
    }
    const created = await cfApi(fetchImpl, env.CF_API_TOKEN, 'POST', `/accounts/${accountId}/cfd_tunnel`, {
      name,
      config_src: 'cloudflare',
    });
    return { accountId, id: created.id, created: true };
  }

  async function ensureZoneId() {
    if (env.ZONE_ID) return env.ZONE_ID;
    const zones = await cfApi(fetchImpl, env.CF_API_TOKEN, 'GET', `/zones?name=${encodeURIComponent(baseDomain)}`);
    const zone = (Array.isArray(zones) ? zones : []).find((z) => z.name === baseDomain);
    if (!zone) throw { status: 500, message: `Cloudflare 账号里找不到域名 ${baseDomain}（检查 ZONE_ID 配置）` };
    return zone.id;
  }

  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'dsh-tunnel-enroll' });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/tunnel') {
      return fail(404, '未知的开通服务端点');
    }

    const token = auth(request);
    if (!token) return fail(401, 'enroll 凭证无效（检查 ENROLL_TOKENS 配置）');
    if (!rateLimit(token.slice(0, 8))) return fail(429, '开通请求过于频繁，请一小时后再试');
    if (!env.CF_API_TOKEN) return fail(500, 'Worker 未配置 CF_API_TOKEN secret');

    let body = null;
    try {
      body = await request.json();
    } catch {
      return fail(400, '请求体不是合法 JSON');
    }
    const port = Number(body?.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return fail(400, '开通需要有效端口（1-65535）');
    }
    const hostId = String(body?.hostId || '').slice(0, 120) || 'unknown-host';
    // subdomain 可空：首次开通由服务端随机生成，客户端缓存后在状态文件里回传（幂等复用）
    let label = String(body?.subdomain || '').toLowerCase();
    if (label) {
      if (!label.startsWith(`${prefix}-`) || !LABEL_RE.test(label)) {
        return fail(400, `子域不合法：必须匹配 ${prefix}-<小写字母/数字/连字符>`);
      }
    } else {
      const rnd = crypto.randomUUID().replace(/-/g, '');
      label = `${prefix}-${rnd.slice(0, 10)}`;
    }
    const hostname = `${label}.${baseDomain}`;

    try {
      const tunnel = await ensureTunnel(label);
      const zoneId = await ensureZoneId();

      let tunnelToken;
      try {
        tunnelToken = await cfApi(fetchImpl, env.CF_API_TOKEN, 'GET',
          `/accounts/${tunnel.accountId}/cfd_tunnel/${tunnel.id}/token`);
      } catch (err) {
        throw { status: 502, message: `取隧道 token 失败：${err?.message || err}` };
      }
      if (!tunnelToken || typeof tunnelToken !== 'string') {
        throw { status: 502, message: 'Cloudflare 返回的隧道 token 为空' };
      }

      await cfApi(fetchImpl, env.CF_API_TOKEN, 'PUT',
        `/accounts/${tunnel.accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
          config: {
            ingress: [
              { hostname, service: `http://127.0.0.1:${port}` },
              // Cloudflare 硬要求：末条必须是无 hostname 的兜底规则
              { service: 'http_status:404' },
            ],
          },
        });

      const target = `${tunnel.id}.cfdargotunnel.com`;
      const records = await cfApi(fetchImpl, env.CF_API_TOKEN, 'GET',
        `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`);
      const existing = (Array.isArray(records) ? records : [])[0];
      const record = { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 };
      if (existing && String(existing.content || '').toLowerCase() === target) {
        // 已存在且指向正确：跳过（幂等）
      } else if (existing) {
        await cfApi(fetchImpl, env.CF_API_TOKEN, 'PUT',
          `/zones/${zoneId}/dns_records/${existing.id}`, record);
      } else {
        await cfApi(fetchImpl, env.CF_API_TOKEN, 'POST', `/zones/${zoneId}/dns_records`,
          { ...record, comment: 'dsh-mobile pro tunnel' });
      }

      return json({ hostname, tunnelId: tunnel.id, token: tunnelToken });
    } catch (err) {
      return fail(err?.status || 500, err?.message || '开通服务内部错误');
    }
  };
}

/** Cloudflare Workers 入口（wrangler 部署用）。 */
export default {
  async fetch(request, env) {
    return createEnrollHandler(env)(request);
  },
};
