import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const PORT = Number(process.env.PORT || 4174);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

interface AuthorizedEndpoint {
  baseURL: string;
  allowLocalNetwork: boolean;
  expiresAt: number;
}

const endpoints = new Map<string, AuthorizedEndpoint>();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

class BlockedTargetError extends Error {}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const normalized = ip.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || normalized.startsWith('fe80:') || normalized.startsWith('::ffff:127.');
}

async function assertNetworkAllowed(url: URL, allowLocalNetwork: boolean): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP 或 HTTPS');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    if (!allowLocalNetwork) throw new BlockedTargetError('本地网络目标未获授权');
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('DNS 解析失败');
  }
  if (!allowLocalNetwork && addresses.some(({ address }) => isPrivateIp(address))) {
    throw new BlockedTargetError('解析到内网地址，需显式允许本地网络目标');
  }
}

function normalizedBaseURL(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('baseURL 缺失');
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

function classifyStatus(status: number): string | undefined {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return undefined;
}

app.post('/api/session/endpoints', async (req, res) => {
  try {
    for (const [token, endpoint] of endpoints) if (endpoint.expiresAt < Date.now()) endpoints.delete(token);
    const base = normalizedBaseURL(req.body.baseURL);
    const allowLocalNetwork = req.body.allowLocalNetwork === true;
    await assertNetworkAllowed(base, allowLocalNetwork);
    const token = crypto.randomBytes(24).toString('base64url');
    endpoints.set(token, { baseURL: base.toString(), allowLocalNetwork, expiresAt: Date.now() + SESSION_TTL_MS });
    res.json({ endpointToken: token, expiresInMs: SESSION_TTL_MS });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : '端点授权失败', errorType: 'blocked' });
  }
});

app.post('/api/proxy', async (req, res) => {
  const started = performance.now();
  const endpoint = endpoints.get(String(req.body.endpointToken || ''));
  if (!endpoint || endpoint.expiresAt < Date.now()) {
    res.status(403).json({ error: '端点会话未授权或已过期', errorType: 'blocked' });
    return;
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const timeoutMs = Math.min(Math.max(Number(req.body.timeoutMs) || 15000, 1000), 120000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const base = new URL(endpoint.baseURL);
    const requestPath = typeof req.body.path === 'string' ? req.body.path : '';
    const target = new URL(`${base.pathname.replace(/\/$/, '')}/${requestPath.replace(/^\//, '')}`, base.origin);
    const basePath = base.pathname.replace(/\/$/, '');
    if (target.origin !== base.origin || (basePath && !target.pathname.startsWith(`${basePath}/`) && target.pathname !== basePath)) {
      throw new Error('请求目标超出已授权端点范围');
    }
    const queryParams = req.body.queryParams && typeof req.body.queryParams === 'object' ? req.body.queryParams : {};
    for (const [key, value] of Object.entries(queryParams)) target.searchParams.set(key, String(value));
    const method = req.body.method === 'POST' ? 'POST' : 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (req.body.headers && typeof req.body.headers === 'object') {
      for (const [key, value] of Object.entries(req.body.headers)) {
        if (!/^host$|^content-length$|^connection$/i.test(key)) headers[key] = String(value);
      }
    }
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    let currentTarget = target;
    let upstream: Response | undefined;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertNetworkAllowed(currentTarget, endpoint.allowLocalNetwork);
      upstream = await fetch(currentTarget, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(req.body.body ?? {}) : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get('location');
      if (!location) break;
      const redirected = new URL(location, currentTarget);
      if (redirected.origin !== base.origin || (basePath && !redirected.pathname.startsWith(`${basePath}/`) && redirected.pathname !== basePath)) {
        throw new BlockedTargetError('上游重定向超出已授权端点范围');
      }
      currentTarget = redirected;
      if (redirects === 3) throw new Error('上游重定向次数超过限制');
    }
    if (!upstream) throw new Error('上游未返回响应');

    if (!upstream.body) throw new Error('上游响应为空');
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        res.status(413).json({ error: '响应超过 4 MiB 安全上限', errorType: 'too_large' });
        return;
      }
      chunks.push(value);
    }

    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const text = bytes.toString('utf8');
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text for diagnostics */ }
    res.status(upstream.ok ? 200 : upstream.status).json({
      ok: upstream.ok,
      status: upstream.status,
      durationMs: Math.round(performance.now() - started),
      responseBytes: size,
      data,
      headers: {
        'content-type': upstream.headers.get('content-type') || '',
        'x-request-id': upstream.headers.get('x-request-id') || '',
      },
      finalURL: currentTarget.toString(),
      errorType: classifyStatus(upstream.status),
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    const message = error instanceof Error ? error.message : '代理请求失败';
    const isTls = /certificate|tls|ssl/i.test(message);
    const isBlocked = error instanceof BlockedTargetError;
    res.status(isAbort ? 408 : isBlocked ? 403 : 502).json({
      error: isAbort ? `请求在 ${timeoutMs}ms 后超时` : message,
      errorType: isAbort ? 'timeout' : isBlocked ? 'blocked' : isTls ? 'tls' : 'network',
      durationMs: Math.round(performance.now() - started),
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, maxResponseBytes: MAX_RESPONSE_BYTES }));

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(serverDir, '../dist');
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

app.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`LLM endpoint probe proxy: http://127.0.0.1:${PORT}\n`);
});
