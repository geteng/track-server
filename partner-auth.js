/* ============================================================
   GTT 合作方登录（airU 账号）· 服务端会话
   依据：doc/GTT_PARTNER_AUTH.md

   职责：
   1. 调用 airU /api/partner-auth/login 校验老师账号，并用 /api/partner-auth/me 复核身份
   2. 把 partner_access.role 映射为看板内部角色：ca → ca · admin → developer · boss → boss
   3. 建立本服务自己的 HttpOnly 登录会话（HMAC 签名 Cookie），前端拿不到也改不了角色
   4. 提供 requireAuth / requirePermission 中间件保护业务接口

   模式：
   - upstream：真实对接 airU（需配置 PARTNER_AUTH_UPSTREAM_BASE）
   - mock：本地演示账号，不依赖外网（未配置 upstream 时自动启用）
   ============================================================ */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ---------- .env 简易加载（不引入第三方依赖；系统环境变量优先） ---------- */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    if (!line || /^\s*#/.test(line)) return;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    const key = m[1];
    if (process.env[key] !== undefined && process.env[key] !== '') return;
    let val = String(m[2]).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    const hash = val.indexOf(' #');
    if (hash > 0) val = val.slice(0, hash).trim();
    process.env[key] = val;
  });
}
loadDotEnv(path.join(__dirname, '.env'));

const env = (k, d) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};

const upstreamBase = env('PARTNER_AUTH_UPSTREAM_BASE', '').replace(/\/+$/, '');

const CONFIG = {
  enabled: env('PARTNER_AUTH_ENABLED', '1') === '1',
  clientId: env('PARTNER_AUTH_CLIENT_ID', 'gtt-sales'),
  secret: env('PARTNER_AUTH_SECRET', ''),
  ttlSeconds: parseInt(env('PARTNER_AUTH_TOKEN_TTL_SECONDS', '28800'), 10) || 28800,
  upstream: upstreamBase || 'https://test.ysssss.online:4002',
  // 未显式指定时：配了 upstream 地址就走真实接口，否则本地演示
  mode: (env('PARTNER_AUTH_MODE', '') || (upstreamBase ? 'upstream' : 'mock')).toLowerCase(),
  cookieName: 'gtt_sid',
  cookieSecure: env('PARTNER_AUTH_COOKIE_SECURE', '0') === '1',
};

// 会话签名密钥：生产必须由环境变量提供，这里只是开发兜底
const DEV_SECRET = 'gtt-partner-dev-secret-do-not-use-in-production';
const RUNTIME_SECRET = CONFIG.secret || DEV_SECRET;

/* ---------- 角色映射：partner_access.role → 看板内部角色 ---------- */
const PERM_CA = ['dashboard:read', 'customer:read', 'followup:read', 'followup:write'];
const PERM_BOSS = ['dashboard:read', 'customer:read', 'followup:read', 'followup:write', 'business:read'];
const PERM_ADMIN = ['dashboard:read', 'customer:read', 'followup:read', 'followup:write', 'business:read', 'raw:read', 'debug:read'];

const PARTNER_ROLE_MAP = {
  ca: { role: 'ca', label: 'CA/穿搭师', permissions: PERM_CA },
  boss: { role: 'boss', label: '老板娘', permissions: PERM_BOSS },
  admin: { role: 'developer', label: '开发者', permissions: PERM_ADMIN },
};

/* ---------- 本地演示账号（仅 mock 模式生效） ---------- */
const MOCK_ACCOUNTS = [
  { identifier: 'ca', password: 'ca123456', name: '穿搭师 · 小美', airuRole: 'teacher', partnerRole: 'ca' },
  { identifier: 'boss', password: 'boss123456', name: '老板娘 · 林姐', airuRole: 'teacher', partnerRole: 'boss' },
  { identifier: 'admin', password: 'admin123456', name: '开发者 · GTT', airuRole: 'teacher', partnerRole: 'admin' },
];

/* ---------- 内置保留账号：任何模式（含 upstream）都在本地校验，不走 airU ----------
   用于 airU 服务不可达 / 联调期间的应急登录与自测；身份为开发者（最高权限）。
   不出现在 /api/auth/config 的演示账号列表里，避免对外暴露。 */
const BUILTIN_ACCOUNTS = [
  { identifier: 'admin', password: 'admin123', name: '开发者 · GTT', airuRole: 'teacher', partnerRole: 'admin', builtin: true },
];

/* ---------- 登录失败提示（对应文档错误码） ---------- */
const ERROR_TEXT = {
  PARTNER_CLIENT_ID_REQUIRED: '缺少合作方标识',
  PARTNER_IDENTIFIER_REQUIRED: '请输入账号',
  PARTNER_PASSWORD_REQUIRED: '请输入密码',
  PARTNER_CLIENT_INVALID: '合作方标识不正确',
  PARTNER_CREDENTIALS_INVALID: '账号或密码错误',
  PARTNER_TEACHER_REQUIRED: '该账号不是 airU 老师账号，无法登录',
  PARTNER_ACCOUNT_AMBIGUOUS: '存在重名账号，请使用手机号登录',
  AUTH_RATE_LIMITED: '登录尝试过于频繁，请稍后再试',
  PARTNER_AUTH_DISABLED: '合作方登录未启用',
  PARTNER_AUTH_NOT_CONFIGURED: '服务端登录密钥未正确配置',
  PARTNER_ROLE_UNSUPPORTED: '该账号的合作方角色未被看板支持',
  UNAUTHORIZED: '登录已过期，请重新登录',
  UPSTREAM_UNREACHABLE: '无法连接 airU 登录服务，请稍后再试',
};

const err = (status, errorCode, extra) => ({
  error: { status, errorCode, message: ERROR_TEXT[errorCode] || errorCode, ...(extra || {}) },
});

/* ---------- 会话令牌：payload.HMAC ---------- */
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', RUNTIME_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', RUNTIME_SECRET).update(body).digest('base64url');
  if (mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* ---------- 简易登录限流（按 IP，60 秒 10 次） ---------- */
const loginAttempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 60000; }
  rec.count += 1;
  loginAttempts.set(ip, rec);
  return rec.count > 10;
}
function clearAttempts(ip) { loginAttempts.delete(ip); }

/* ---------- 登录：真实 airU 接口 ---------- */
async function upstreamLogin(identifier, password, clientId) {
  let r;
  try {
    r = await fetch(`${CONFIG.upstream}/api/partner-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, identifier, password }),
    });
  } catch (e) {
    return err(503, 'UPSTREAM_UNREACHABLE', { detail: e.message });
  }
  const json = await r.json().catch(() => ({}));
  // 实测 airU 的错误体为 { success:false, error:"账号或密码错误", errorCode:"..." }
  if (!r.ok || json.success === false || !json.access_token) {
    return err(r.status === 429 ? 429 : (r.status || 401), json.errorCode || 'PARTNER_CREDENTIALS_INVALID', {
      detail: json.error || json.message || json.msg,
    });
  }
  // 文档要求：必须再用 /me 复核，不能只信登录响应里的角色
  return upstreamMe(json.access_token, clientId);
}

async function upstreamMe(token, clientId) {
  let r;
  try {
    r = await fetch(`${CONFIG.upstream}/api/partner-auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return err(503, 'UPSTREAM_UNREACHABLE', { detail: e.message });
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.success === false) {
    return err(r.status === 403 ? 403 : 401, json.errorCode || 'UNAUTHORIZED', {
      detail: json.error || json.message || json.msg,
    });
  }

  const pa = json.partner_access || {};
  if (clientId && pa.client_id && pa.client_id !== clientId) return err(401, 'PARTNER_CLIENT_INVALID');
  const mapped = PARTNER_ROLE_MAP[pa.role];
  if (!mapped) return err(403, 'PARTNER_ROLE_UNSUPPORTED');

  return {
    ok: {
      sub: (json.user && json.user.id) || '',
      name: (json.user && json.user.name) || '未命名用户',
      airuRole: (json.user && json.user.airu_role) || 'teacher',
      partnerRole: pa.role,
      role: mapped.role,
      label: mapped.label,
      permissions: pa.permissions || mapped.permissions,
    },
  };
}

/* ---------- 小程序免登录：一次性票据兑换 ---------- */
// airU 小程序为已登录老师签发 60 秒一次性票据；这里在服务端向 airU 兑换令牌，
// 再与密码登录一样用 /me 复核角色。票据与 airU 令牌都不落日志、不写入 Cookie。
async function upstreamSsoExchange(ticket, clientId) {
  let r;
  try {
    r = await fetch(`${CONFIG.upstream}/api/partner-auth/sso-exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, ticket }),
    });
  } catch (e) {
    return err(503, 'UPSTREAM_UNREACHABLE', { detail: e.message });
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok || json.success === false || !json.access_token) {
    return err(r.status === 403 ? 403 : 401, json.errorCode || 'PARTNER_SSO_TICKET_INVALID', {
      detail: json.error || json.message || json.msg,
    });
  }
  return upstreamMe(json.access_token, clientId);
}

/* ---------- 会话：登录成功后统一生成 ---------- */
function buildSession(ok) {
  const now = Date.now();
  return {
    sub: ok.sub,
    name: ok.name,
    airuRole: ok.airuRole,
    partnerRole: ok.partnerRole,
    role: ok.role,
    label: ok.label,
    permissions: ok.permissions,
    iat: now,
    exp: now + CONFIG.ttlSeconds * 1000,
  };
}

/* ---------- 会话组装：内置 / 演示账号共用 ---------- */
function localLogin(acc, clientId) {
  if (clientId && clientId !== CONFIG.clientId) return err(401, 'PARTNER_CLIENT_INVALID');
  const mapped = PARTNER_ROLE_MAP[acc.partnerRole];
  return {
    ok: {
      sub: `${acc.builtin ? 'builtin' : 'mock'}-${acc.identifier}`,
      name: acc.name,
      airuRole: acc.airuRole,
      partnerRole: acc.partnerRole,
      role: mapped.role,
      label: mapped.label,
      permissions: mapped.permissions,
    },
  };
}

/* ---------- 登录：本地演示账号（仅 mock 模式） ---------- */
function mockLogin(identifier, password, clientId) {
  // 演示：非老师账号（student）返回 403，与文档一致
  if (identifier === 'student') return err(403, 'PARTNER_TEACHER_REQUIRED');
  const acc = MOCK_ACCOUNTS.find((a) => a.identifier === identifier);
  if (!acc || acc.password !== password) return err(401, 'PARTNER_CREDENTIALS_INVALID');
  return localLogin(acc, clientId);
}

/* ---------- 对外：登录 ---------- */
async function login({ identifier, password, clientId }, meta) {
  if (!CONFIG.enabled) return err(503, 'PARTNER_AUTH_DISABLED');
  if (CONFIG.mode === 'upstream' && !CONFIG.secret) return err(503, 'PARTNER_AUTH_NOT_CONFIGURED');
  if (!identifier) return err(400, 'PARTNER_IDENTIFIER_REQUIRED');
  if (!password) return err(400, 'PARTNER_PASSWORD_REQUIRED');
  const cid = clientId || CONFIG.clientId;
  if (!cid) return err(400, 'PARTNER_CLIENT_ID_REQUIRED');
  if (rateLimited(meta && meta.ip)) return err(429, 'AUTH_RATE_LIMITED');

  // 内置保留账号：任何模式都在本地校验，优先于 airU 上游，保证上游不可达时仍可登录
  const builtin = BUILTIN_ACCOUNTS.find((a) => a.identifier === identifier && a.password === password);
  if (builtin) {
    clearAttempts(meta && meta.ip);
    return localLogin(builtin, cid);
  }

  // mock 模式：演示账号走本地校验，其他账号（airU 真实老师）转交 airU 校验。
  const isDemoAccount = MOCK_ACCOUNTS.some((a) => a.identifier === identifier) || identifier === 'student';
  const result = CONFIG.mode === 'upstream' || !isDemoAccount
    ? await upstreamLogin(identifier, password, cid)
    : mockLogin(identifier, password, cid);

  if (!result.ok) return result;
  clearAttempts(meta && meta.ip);
  return result;
}

/* ---------- 中间件 ---------- */
function attachSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  req.session = verifySession(cookies[CONFIG.cookieName]);
  next();
}

function setSessionCookie(res, session) {
  const token = signSession(session);
  const attrs = [
    `${CONFIG.cookieName}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${CONFIG.ttlSeconds}`,
  ];
  if (CONFIG.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [`${CONFIG.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (CONFIG.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function requireAuth(req, res, next) {
  if (!CONFIG.enabled) return next();
  if (!req.session) {
    return res.status(401).json({ code: 401, msg: ERROR_TEXT.UNAUTHORIZED, errorCode: 'UNAUTHORIZED' });
  }
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!CONFIG.enabled) return next();
    if (!req.session) {
      return res.status(401).json({ code: 401, msg: ERROR_TEXT.UNAUTHORIZED, errorCode: 'UNAUTHORIZED' });
    }
    if (permission && !(req.session.permissions || []).includes(permission)) {
      return res.status(403).json({ code: 403, msg: '当前角色无此操作权限', errorCode: 'FORBIDDEN' });
    }
    next();
  };
}

/* 角色守卫：接口用（越权返回 403 JSON）
   角色只来自登录会话，URL / 请求体上的 role 一律不生效 */
function requireRole(roles) {
  const list = (Array.isArray(roles) ? roles : [roles]).filter(Boolean);
  return (req, res, next) => {
    if (!CONFIG.enabled) return next();
    if (!req.session) {
      return res.status(401).json({ code: 401, msg: ERROR_TEXT.UNAUTHORIZED, errorCode: 'UNAUTHORIZED' });
    }
    if (list.length && !list.includes(req.session.role)) {
      return res.status(403).json({ code: 403, msg: '当前角色无此操作权限', errorCode: 'FORBIDDEN' });
    }
    next();
  };
}

/* 页面访问拦截：未登录跳转登录页 */
function requireLoginPage(req, res, next) {
  if (!CONFIG.enabled || req.session) return next();
  const from = encodeURIComponent(req.originalUrl || '/sales');
  res.redirect(`/login?from=${from}`);
}

/* 角色守卫：页面用（未登录跳登录页，越权返回提示页，不给数据） */
function requireRolePage(roles, opts = {}) {
  const list = (Array.isArray(roles) ? roles : [roles]).filter(Boolean);
  return (req, res, next) => {
    if (!CONFIG.enabled) return next();
    if (!req.session) {
      const from = encodeURIComponent(req.originalUrl || '/sales');
      return res.redirect(`/login?from=${from}`);
    }
    if (list.length && !list.includes(req.session.role)) {
      const mapped = PARTNER_ROLE_MAP[req.session.role] || {};
      const label = req.session.label || mapped.label || req.session.role;
      const need = (opts.title || '该页面');
      const allow = (opts.allowText || '开发者');
      res.status(403);
      return res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>无权限访问</title>
<style>body{margin:0;background:#F5F6F8;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#111827}
.box{max-width:520px;margin:80px auto;text-align:center;background:#fff;border:1px solid #E5E7EB;border-radius:16px;padding:40px 28px}
.icon{font-size:44px;line-height:1}h1{font-size:19px;font-weight:700;margin:16px 0 8px}
p{font-size:13px;color:#6B7280;line-height:1.8;margin:0}b{color:#E1306C}
a{display:inline-block;margin-top:22px;padding:10px 22px;border-radius:9px;background:#E1306C;color:#fff;text-decoration:none;font-size:13px;font-weight:600}
.tip{font-size:12px;color:#9CA3AF;margin-top:14px}</style></head><body>
<div class="box"><div class="icon">🔒</div><h1>当前视角无权限访问</h1>
<p>${need}仅<b>${allow}</b>视角可查看。<br>当前视角：${label}</p>
<a href="/sales">返回销售工作台</a>
<div class="tip">视角由 airU 合作方授权决定，登录后固定，页面内不可切换</div>
</div></body></html>`);
    }
    next();
  };
}

/* ---------- 路由 ---------- */
function registerAuthRoutes(app) {
  // 登录页配置（供前端决定要不要展示演示账号）
  app.get('/api/auth/config', (req, res) => {
    res.json({
      code: 0,
      data: {
        enabled: CONFIG.enabled,
        mode: CONFIG.mode,
        clientId: CONFIG.clientId,
        ttlSeconds: CONFIG.ttlSeconds,
        demoAccounts: CONFIG.mode === 'mock'
          ? MOCK_ACCOUNTS.map((a) => ({ identifier: a.identifier, password: a.password, name: a.name, label: PARTNER_ROLE_MAP[a.partnerRole].label }))
          : [],
      },
    });
  });

  // 小程序“高意向”免登录入口：/sso?ticket=…  → 写入 gtt_sid 会话 → 跳转 /sales
  app.get('/sso', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const ticket = String((req.query && req.query.ticket) || '').trim();
    // 免登录始终向 airU 兑换票据；与密码登录的 mock/upstream 模式无关，演示账号不受影响。
    if (!CONFIG.enabled || !ticket) {
      return res.redirect('/login?error=sso');
    }
    const result = await upstreamSsoExchange(ticket, CONFIG.clientId);
    if (!result.ok) {
      console.warn('[sso] exchange failed:', result.error.errorCode);
      return res.redirect('/login?error=sso');
    }
    setSessionCookie(res, buildSession(result.ok));
    return res.redirect('/sales');
  });

  // 小程序原生页面：用票据换会话并以 JSON 返回（小程序请求拿不到 302 上的 Cookie），
  // 之后请求手动携带 Cookie: gtt_sid=<sessionToken>，其余接口与 H5 完全相同。
  app.post('/api/auth/sso-session', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const ticket = String((req.body && req.body.ticket) || '').trim();
    if (!CONFIG.enabled) return res.status(503).json({ code: 503, msg: ERROR_TEXT.PARTNER_AUTH_DISABLED || '登录未启用', errorCode: 'PARTNER_AUTH_DISABLED' });
    if (!ticket) return res.status(400).json({ code: 400, msg: '缺少票据', errorCode: 'PARTNER_SSO_TICKET_REQUIRED' });
    const result = await upstreamSsoExchange(ticket, CONFIG.clientId);
    if (!result.ok) {
      const { status, errorCode, message } = result.error;
      return res.status(status).json({ code: status, msg: message, errorCode });
    }
    const session = buildSession(result.ok);
    setSessionCookie(res, session);
    res.json({
      code: 0,
      data: {
        sessionToken: signSession(session),
        cookieName: CONFIG.cookieName,
        user: { id: session.sub, name: session.name, airu_role: session.airuRole },
        role: session.role,
        expires_in: CONFIG.ttlSeconds,
      },
    });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { identifier, password, client_id: clientId } = req.body || {};
    const result = await login({ identifier, password, clientId }, { ip: req.ip });
    if (!result.ok) {
      const { status, errorCode, message } = result.error;
      return res.status(status).json({ code: status, msg: message, errorCode });
    }

    const session = buildSession(result.ok);
    setSessionCookie(res, session);
    res.json({
      code: 0,
      data: {
        user: { id: session.sub, name: session.name, airu_role: session.airuRole },
        partner_access: {
          client_id: CONFIG.clientId,
          role: session.partnerRole,
          label: session.label,
          permissions: session.permissions,
        },
        // 前端渲染用的内部角色（ca / boss / developer）
        role: session.role,
        expires_in: CONFIG.ttlSeconds,
        expires_at: new Date(session.exp).toISOString(),
      },
    });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.session) {
      return res.status(401).json({ code: 401, msg: ERROR_TEXT.UNAUTHORIZED, errorCode: 'UNAUTHORIZED' });
    }
    const s = req.session;
    res.json({
      code: 0,
      data: {
        user: { id: s.sub, name: s.name, airu_role: s.airuRole },
        partner_access: { client_id: CONFIG.clientId, role: s.partnerRole, label: s.label, permissions: s.permissions },
        role: s.role,
        expires_in: Math.max(0, Math.floor((s.exp - Date.now()) / 1000)),
        expires_at: new Date(s.exp).toISOString(),
      },
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ code: 0, msg: 'ok' });
  });
}

module.exports = {
  CONFIG,
  PARTNER_ROLE_MAP,
  ERROR_TEXT,
  attachSession,
  requireAuth,
  requireRole,
  requirePermission,
  requireLoginPage,
  requireRolePage,
  registerAuthRoutes,
  verifySession,
  signSession,
};
