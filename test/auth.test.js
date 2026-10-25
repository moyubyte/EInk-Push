// 访问鉴权：登录页（只输密码）、会话 Cookie、API 令牌、改密与落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadSettings } from '../src/settings.js';
import { hashPassword, SESSION_COOKIE } from '../src/auth.js';

async function boot(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zectrix-auth-'));
  const app = createServer({
    device: null,
    dataDir: dir,
    recordingsDir: path.join(dir, 'recordings'),
    settingsFile: path.join(dir, 'config.json'),
    apps: false,
    ...options,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, server, base, dir };
}

async function teardown(ctx) {
  await ctx.app.locals.shutdown?.().catch(() => {});
  await new Promise((resolve) => ctx.server.close(resolve));
  await fs.rm(ctx.dir, { recursive: true, force: true });
}

function sessionCookie(res) {
  const values = res.headers.getSetCookie?.() || [res.headers.get('set-cookie') || ''];
  const first = values[0].split(';')[0];
  assert.match(first, new RegExp(`^${SESSION_COOKIE}=`));
  return first;
}

async function login(ctx, password) {
  const res = await fetch(ctx.base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return { res, cookie: res.ok ? sessionCookie(res) : '' };
}

test('未登录时页面跳登录页，API 返回 401', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    const page = await fetch(ctx.base + '/', { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location') || '', /^\/login\?next=/);

    const loginPage = await fetch(ctx.base + '/login');
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /输入密码/);

    const api = await fetch(ctx.base + '/api/config');
    assert.equal(api.status, 401);
    assert.equal((await api.json()).ok, false);
  } finally {
    await teardown(ctx);
  }
});

test('初始密码 helloworld：登录后发会话 Cookie，API 令牌即密码哈希', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    const wrong = await login(ctx, 'wrong-password');
    assert.equal(wrong.res.status, 401);

    const ok = await login(ctx, 'helloworld');
    assert.equal(ok.res.status, 200);
    const setCookie = ok.res.headers.getSetCookie?.()[0] || ok.res.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);

    const page = await fetch(ctx.base + '/', { headers: { Cookie: ok.cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<!doctype html>/i);

    const api = await fetch(ctx.base + '/api/config', { headers: { Cookie: ok.cookie } });
    assert.equal(api.status, 200);
    const config = await api.json();
    assert.equal(config.authToken, hashPassword('helloworld'));

    const byToken = await fetch(`${ctx.base}/api/config?token=${config.authToken}`);
    assert.equal(byToken.status, 200);
    const badToken = await fetch(`${ctx.base}/api/config?token=${'0'.repeat(64)}`);
    assert.equal(badToken.status, 401);
  } finally {
    await teardown(ctx);
  }
});

test('应用接口同样受保护，会话与令牌都可访问', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    const token = hashPassword('helloworld');
    const anon = await fetch(ctx.base + '/apps/what-to-eat/api/state');
    assert.equal(anon.status, 401);

    const cookie = (await login(ctx, 'helloworld')).cookie;
    const bySession = await fetch(ctx.base + '/apps/what-to-eat/api/state', {
      headers: { Cookie: cookie },
    });
    assert.equal(bySession.status, 404); // 鉴权已通过，只是测试里没挂应用路由

    const byToken = await fetch(`${ctx.base}/apps/what-to-eat/api/state?token=${token}`);
    assert.equal(byToken.status, 404);
  } finally {
    await teardown(ctx);
  }
});

test('改密需要登录会话；旧会话失效，新会话与哈希落盘', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    const oldHash = hashPassword('helloworld');
    const viaToken = await fetch(`${ctx.base}/api/password?token=${oldHash}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'new-secret' }),
    });
    assert.equal(viaToken.status, 403, '令牌不能直接改密');

    const before = await login(ctx, 'helloworld');
    const res = await fetch(ctx.base + '/api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: before.cookie },
      body: JSON.stringify({ password: 'new-secret' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.token, hashPassword('new-secret'));
    const afterCookie = sessionCookie(res);

    const stale = await fetch(ctx.base + '/api/config', { headers: { Cookie: before.cookie } });
    assert.equal(stale.status, 401, '改密前的 Cookie 应失效');

    const fresh = await fetch(ctx.base + '/api/config', { headers: { Cookie: afterCookie } });
    assert.equal(fresh.status, 200);

    assert.equal((await login(ctx, 'helloworld')).res.status, 401);
    assert.equal((await login(ctx, 'new-secret')).res.status, 200);

    const saved = await loadSettings(path.join(ctx.dir, 'config.json'));
    assert.equal(saved.passwordHash, body.token);
  } finally {
    await teardown(ctx);
  }
});

test('密码长度不合法时拒绝修改', { timeout: 20000 }, async () => {
  const ctx = await boot();
  try {
    const cookie = (await login(ctx, 'helloworld')).cookie;
    const res = await fetch(ctx.base + '/api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ password: '123' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await teardown(ctx);
  }
});
