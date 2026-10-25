// 访问鉴权：登录页只输密码，成功后发签名 Cookie；API 额外支持 ?token=<密码哈希>。
// 密码只保存 SHA-256 哈希；哈希本身也是 API 令牌，所以只在已登录页面里展示。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_PASSWORD = 'helloworld';
export const PASSWORD_HASH_RE = /^[0-9a-f]{64}$/;
export const SESSION_COOKIE = 'inkpush_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

export function hashPassword(password) {
  return createHash('sha256').update(String(password), 'utf8').digest('hex');
}

export const DEFAULT_PASSWORD_HASH = hashPassword(DEFAULT_PASSWORD);

function matchesHash(candidate, expected) {
  if (typeof candidate !== 'string' || !PASSWORD_HASH_RE.test(candidate)) return false;
  if (typeof expected !== 'string' || !PASSWORD_HASH_RE.test(expected)) return false;
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'));
}

/** 校验明文密码是否匹配当前哈希（用于登录页） */
export function verifyPassword(password, hash) {
  return matchesHash(hashPassword(password), hash);
}

/**
 * 生成会话令牌：`过期时间.HMAC(密码哈希, 过期时间)`。
 * 改密后哈希变化，旧 Cookie 会自动失效。
 */
export function createSessionToken(hash, now = Date.now()) {
  if (!PASSWORD_HASH_RE.test(hash)) return '';
  const expires = now + SESSION_MAX_AGE_S * 1000;
  const mac = createHmac('sha256', Buffer.from(hash, 'hex'))
    .update(String(expires))
    .digest('hex');
  return `${expires}.${mac}`;
}

export function verifySessionToken(token, hash, now = Date.now()) {
  if (typeof token !== 'string' || !PASSWORD_HASH_RE.test(hash)) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expires = Number(token.slice(0, dot));
  const mac = token.slice(dot + 1);
  if (!Number.isSafeInteger(expires) || expires < now) return false;
  const expected = createHmac('sha256', Buffer.from(hash, 'hex'))
    .update(String(expires))
    .digest('hex');
  return matchesHash(mac, expected);
}

function readCookie(header, name) {
  if (typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

/**
 * 全站鉴权中间件。
 * 页面未登录时 302 到 /login；API 返回 401 JSON，避免页面脚本被重定向成 HTML。
 * @param {{getHash: () => string, loginPath?: string}} options
 */
export function createAuth({ getHash, loginPath = '/login' }) {
  return (req, res, next) => {
    if (req.path === loginPath || req.path === '/api/login') return next();

    const expected = getHash();
    const session = readCookie(req.get('cookie'), SESSION_COOKIE);
    if (session && verifySessionToken(session, expected)) {
      req.authMethod = 'session';
      return next();
    }

    const isApi = req.path === '/api' || req.path.startsWith('/api/') || req.path.includes('/api/');
    if (isApi) {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (token && matchesHash(token, expected)) {
        req.authMethod = 'token';
        return next();
      }
      return res.status(401).json({ ok: false, error: '需要先登录，或使用 ?token=<密码哈希>' });
    }

    const target = req.originalUrl || '/';
    return res.redirect(302, `${loginPath}?next=${encodeURIComponent(target)}`);
  };
}
