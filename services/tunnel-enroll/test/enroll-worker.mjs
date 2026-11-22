// enroll-worker.mjs — 开通服务（Cloudflare Workers）状态机与合约测试，零网络：
// 用注入的 fetchImpl 模拟 Cloudflare API，逐条断言 4 次调用形状与幂等语义。
import { createEnrollHandler } from '../src/worker.mjs';

const PASS = [];
const failures = [];
const check = (name, ok, extra = '') => {
  (ok ? PASS : failures).push(name);
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const ENV = {
  BASE_DOMAIN: 'matrixboard.cn',
  PREFIX: 'dsh',
  ENROLL_TOKENS: 'tok-good, tok-other',
  CF_API_TOKEN: 'cf-token',
  ACCOUNT_ID: 'acct1',
  ZONE_ID: 'zone1',
};

/** 模拟 Cloudflare API：记录调用，按路径返回最小 result（DNS 记录持久化以测幂等）。 */
function makeCf() {
  const calls = [];
  const tunnels = new Map(); // name -> { id, remote_config }
  const dns = new Map();     // fqdn -> record content
  let nextId = 1;
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/client/v4', '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });
    const ok = (result) => ({ status: 200, text: async () => JSON.stringify({ success: true, result }) });
    if (method === 'GET' && path === '/accounts') return ok([{ id: 'acct1', name: 'A' }, { id: 'acct2', name: 'B' }]);
    if (method === 'GET' && path.startsWith('/accounts/') && path.endsWith('/cfd_tunnel')) {
      const name = u.searchParams.get('name');
      const t = tunnels.get(name);
      return ok(t ? [t] : []);
    }
    if (method === 'POST' && path.endsWith('/cfd_tunnel')) {
      const t = { id: `tid-${nextId++}`, name: body.name, remote_config: true, deleted_at: null };
      tunnels.set(body.name, t);
      return ok(t);
    }
    if (method === 'GET' && path.includes('/token')) return ok('eyJ-tunnel-token');
    if (method === 'PUT' && path.includes('/configurations')) return ok(body.config);
    if (method === 'GET' && path.includes('/dns_records')) {
      const name = u.searchParams.get('name');
      return ok(dns.has(name) ? [{ id: 'rec-existing', name, content: dns.get(name) }] : []);
    }
    if (method === 'POST' && path.includes('/dns_records')) {
      dns.set(body.name, body.content);
      return ok({ id: 'rec1' });
    }
    if (method === 'PUT' && path.includes('/dns_records/')) {
      dns.set(body.name, body.content);
      return ok({ id: 'rec1' });
    }
    return { status: 404, text: async () => JSON.stringify({ success: false, errors: [{ message: 'no route' }] }) };
  };
  return { impl, calls, tunnels, dns };
}

async function post(handler, body, token = 'tok-good') {
  return handler(new Request('https://enroll.example/v1/tunnel', {
    method: 'POST',
    headers: { Authorization: token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

// 1. health 与 404
{
  const handler = createEnrollHandler(ENV, { fetchImpl: makeCf().impl });
  const health = await handler(new Request('https://enroll.example/health'));
  check('GET /health 返回 ok', health.status === 200 && (await health.json()).ok === true);
  const nf = await handler(new Request('https://enroll.example/other', { method: 'POST' }));
  check('未知端点返回 404', nf.status === 404);
}

// 2. 认证与参数校验
{
  const handler = createEnrollHandler(ENV, { fetchImpl: makeCf().impl });
  const bad = await post(handler, { hostId: 'h', port: 3081 }, 'tok-bad');
  check('无效 enroll token 返回 401', bad.status === 401);
  const noTok = await post(handler, { hostId: 'h', port: 3081 }, '');
  check('缺 Authorization 返回 401', noTok.status === 401);
  const badPort = await post(handler, { hostId: 'h', port: 0 });
  check('无效端口返回 400', badPort.status === 400);
  const badLabel = await post(handler, { hostId: 'h', port: 3081, subdomain: 'evil' });
  check('不带前缀的子域被拒', badLabel.status === 400);
  const spaces = await post(handler, { hostId: 'h', port: 3081, subdomain: 'dsh-  a' });
  check('含空格子域被拒', spaces.status === 400);
}

// 3. 开通全链路：4 个 CF 调用形状与响应三件套
{
  const cf = makeCf();
  const handler = createEnrollHandler(ENV, { fetchImpl: cf.impl });
  const res = await post(handler, { hostId: 'host_cordis', port: 3081, subdomain: 'dsh-abc1234567' });
  const body = await res.json();
  check('开通成功返回 200', res.status === 200, JSON.stringify(body).slice(0, 80));
  check('返回的 hostname 在 BASE_DOMAIN 下且与请求子域一致', body.hostname === 'dsh-abc1234567.matrixboard.cn');
  check('返回 tunnelId 与 token', body.tunnelId === 'tid-1' && body.token === 'eyJ-tunnel-token');
  const creates = cf.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cfd_tunnel'));
  check('tunnel 以 remotely-managed 创建（config_src=cloudflare）',
    creates.length === 1 && creates[0].body.config_src === 'cloudflare' && creates[0].body.name === 'dsh-abc1234567');
  const ingress = cf.calls.find((c) => c.method === 'PUT' && c.path.includes('/configurations'));
  check('ingress 指向 127.0.0.1:port 且末条兜底',
    ingress?.body?.config?.ingress?.[0]?.service === 'http://127.0.0.1:3081'
    && ingress?.body?.config?.ingress?.at(-1)?.service === 'http_status:404'
    && ingress?.body?.config?.ingress?.[0]?.hostname === 'dsh-abc1234567.matrixboard.cn');
  const dns = cf.calls.find((c) => c.method === 'POST' && c.path.includes('/dns_records'));
  check('DNS CNAME 指向本隧道且 proxied',
    dns?.body?.type === 'CNAME' && dns?.body?.name === 'dsh-abc1234567.matrixboard.cn'
    && dns?.body?.content === 'tid-1.cfdargotunnel.com' && dns?.body?.proxied === true);
}

// 4. 幂等：同名 tunnel 复用、DNS 已正确则跳过
{
  const cf = makeCf();
  const handler = createEnrollHandler(ENV, { fetchImpl: cf.impl });
  await post(handler, { hostId: 'h', port: 3081, subdomain: 'dsh-idem0001' });
  const creates1 = cf.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cfd_tunnel')).length;
  await post(handler, { hostId: 'h', port: 3081, subdomain: 'dsh-idem0001' });
  const creates2 = cf.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cfd_tunnel')).length;
  check('重复开通不重建 tunnel', creates1 === 1 && creates2 === 1);
  const dnsPosts = cf.calls.filter((c) => c.method === 'POST' && c.path.includes('/dns_records')).length;
  check('DNS 已存在时第二次不重复写（第二次返回缓存主机名）', dnsPosts === 1);
}

// 5. 端口顺延：只重写 ingress，不换隧道/域名
{
  const cf = makeCf();
  const handler = createEnrollHandler(ENV, { fetchImpl: cf.impl });
  await post(handler, { hostId: 'h', port: 3081, subdomain: 'dsh-port00001' });
  await post(handler, { hostId: 'h', port: 3082, subdomain: 'dsh-port00001' });
  const ingress = cf.calls.filter((c) => c.method === 'PUT' && c.path.includes('/configurations'));
  check('端口顺延后 ingress 重写为新端口',
    ingress.length === 2 && ingress[1].body.config.ingress[0].service === 'http://127.0.0.1:3082');
  const res = await post(handler, { hostId: 'h', port: 3082, subdomain: 'dsh-port00001' });
  const body = await res.json();
  check('顺延后 hostname 不变', body.hostname === 'dsh-port00001.matrixboard.cn');
}

// 6. 本地管理型同名隧道拒绝；CF 报错原样透出
{
  const cf = makeCf();
  cf.tunnels.set('dsh-localll11', { id: 'tid-local', name: 'dsh-localll11', remote_config: false, deleted_at: null });
  const handler = createEnrollHandler(ENV, { fetchImpl: cf.impl });
  const res = await post(handler, { hostId: 'h', port: 3081, subdomain: 'dsh-localll11' });
  check('本地管理型隧道返回 409 且带说明', res.status === 409 && (await res.json()).message.includes('本地管理'));
}

// 7. 首次开通（subdomain 为 null）：服务端随机生成、前缀正确
{
  const cf = makeCf();
  const handler = createEnrollHandler(ENV, { fetchImpl: cf.impl });
  const res = await post(handler, { hostId: 'host_cordis', port: 3081, subdomain: null });
  const body = await res.json();
  check('首次开通返回随机子域且带 dsh- 前缀', res.status === 200
    && /^dsh-[0-9a-f]{10}\.matrixboard\.cn$/.test(body.hostname), body.hostname);
}

// 8. 限速：同 token 超过窗口内上限返回 429
{
  const cf = makeCf();
  const handler = createEnrollHandler({ ...ENV }, { fetchImpl: cf.impl });
  let last = null;
  for (let i = 0; i < 25; i++) {
    last = await post(handler, { hostId: 'h', port: 3081, subdomain: `dsh-rate${String(i).padStart(6, '0')}` });
  }
  check('窗口内超过 20 次后限速 429', last.status === 429);
}

// 9. 未配置 CF_API_TOKEN / 多账号且无 ACCOUNT_ID
{
  const cf = makeCf();
  const handler = createEnrollHandler({ ...ENV, CF_API_TOKEN: undefined }, { fetchImpl: cf.impl });
  const res = await post(handler, { hostId: 'h', port: 3081, subdomain: 'dsh-notok0001' });
  check('缺 CF_API_TOKEN 返回 500 明确报错', res.status === 500);
  const cf2 = makeCf();
  const handler2 = createEnrollHandler({ ...ENV, ACCOUNT_ID: undefined }, { fetchImpl: cf2.impl });
  const res2 = await post(handler2, { hostId: 'h', port: 3081, subdomain: 'dsh-noacct001' });
  check('多账号且未配置 ACCOUNT_ID 返回 500 明确报错', res2.status === 500);
}

console.log(`\n结果：${PASS.length} 通过 / ${failures.length} 失败`);
process.exit(failures.length ? 1 : 0);
