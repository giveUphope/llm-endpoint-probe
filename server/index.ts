import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { EndpointProfile, KeyValue } from '../src/domain/types';
import { buildPreview } from '../src/lib/preview';
import { resolveProviderProfile } from '../src/lib/providers';
import { buildAuthHeaders, mergeHeaders } from '../src/lib/security';

const PORT = Number(process.env.PORT || 4174);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_HISTORY_ENTRIES = 20;
const HEALTH_SERVICE = 'llm-endpoint-probe-proxy';
const GUARD_VERSION = 1;

interface AuthorizedEndpoint {
  baseURL: string;
  allowLocalNetwork: boolean;
  historyId: string;
  protocol: EndpointProfile['protocol'];
  managedHeaders: Record<string, string>;
  queryParams: Record<string, string>;
  expiresAt: number;
}

interface EndpointHistoryRecord {
  id: string;
  profile: EndpointProfile;
  providerId?: string;
  providerLabel?: string;
  createdAt: string;
  lastUsedAt: string;
}

const endpoints = new Map<string, AuthorizedEndpoint>();
const endpointHistory = new Map<string, EndpointHistoryRecord>();
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

function textValue(value: unknown, fallback = '', maxLength = 16_384): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : fallback;
}

function keyValues(value: unknown): KeyValue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((item) => {
    const pair = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      id: textValue(pair.id, crypto.randomUUID(), 128),
      key: textValue(pair.key, '', 256),
      value: textValue(pair.value),
    };
  });
}

function endpointProfile(value: unknown): EndpointProfile {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const inputURL = new URL(textValue(source.baseURL));
  const base = normalizedBaseURL(source.baseURL);
  const now = new Date().toISOString();
  const inputQueryParams = [...inputURL.searchParams.entries()]
    .filter(([key]) => /^api-version$/i.test(key))
    .map(([key, item]) => ({ id: crypto.randomUUID(), key, value: item }));
  const configuredQueryParams = keyValues(source.queryParams).filter((item) => /^api-version$/i.test(item.key));
  const queryParams = [
    ...configuredQueryParams,
    ...inputQueryParams.filter((item) => !configuredQueryParams.some((configured) => configured.key.toLowerCase() === item.key.toLowerCase())),
  ];
  return {
    id: textValue(source.id, crypto.randomUUID(), 128),
    name: textValue(source.name, base.hostname, 120) || base.hostname,
    baseURL: base.toString().replace(/\/$/, ''),
    apiKey: textValue(source.apiKey),
    authMode: 'auto',
    customHeaderName: 'X-API-Key',
    customHeaderTemplate: '{{key}}',
    protocol: 'auto',
    headers: [],
    queryParams,
    timeoutMs: Math.min(Math.max(Number(source.timeoutMs) || 15_000, 1_000), 120_000),
    allowLocalNetwork: source.allowLocalNetwork === true,
    createdAt: textValue(source.createdAt, now, 64),
    updatedAt: now,
  };
}

function upsertHistory(profile: EndpointProfile, provider?: { id: string; label: string }): EndpointHistoryRecord {
  const now = new Date().toISOString();
  const existing = [...endpointHistory.values()].find((item) => item.profile.baseURL === profile.baseURL);
  const record: EndpointHistoryRecord = existing ? {
    ...existing,
    profile: structuredClone(profile),
    providerId: provider?.id,
    providerLabel: provider?.label,
    lastUsedAt: now,
  } : {
    id: crypto.randomBytes(12).toString('base64url'),
    profile: structuredClone(profile),
    providerId: provider?.id,
    providerLabel: provider?.label,
    createdAt: now,
    lastUsedAt: now,
  };
  endpointHistory.set(record.id, record);
  if (endpointHistory.size > MAX_HISTORY_ENTRIES) {
    const oldest = [...endpointHistory.values()].sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))[0];
    if (oldest) endpointHistory.delete(oldest.id);
  }
  return record;
}

function historyMetadata(record: EndpointHistoryRecord) {
  return {
    id: record.id,
    name: record.profile.name,
    baseURL: record.profile.baseURL,
    providerId: record.providerId,
    providerLabel: record.providerLabel,
    protocol: record.profile.protocol,
    authMode: record.profile.authMode,
    hasApiKey: Boolean(record.profile.apiKey),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
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
    const requestedProfile = endpointProfile(req.body.profile ?? req.body);
    const base = new URL(requestedProfile.baseURL);
    await assertNetworkAllowed(base, requestedProfile.allowLocalNetwork);
    const { profile, provider } = resolveProviderProfile(requestedProfile);
    const history = upsertHistory(profile, provider);
    const token = crypto.randomBytes(24).toString('base64url');
    endpoints.set(token, {
      baseURL: profile.baseURL,
      allowLocalNetwork: profile.allowLocalNetwork,
      historyId: history.id,
      protocol: profile.protocol,
      managedHeaders: buildAuthHeaders(profile.authMode, profile.apiKey, profile.customHeaderName, profile.customHeaderTemplate),
      queryParams: Object.fromEntries(profile.queryParams.filter((item) => item.key.trim()).map((item) => [item.key.trim(), item.value])),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    res.set('Cache-Control', 'no-store, max-age=0');
    res.json({
      endpointToken: token,
      expiresInMs: SESSION_TTL_MS,
      history: historyMetadata(history),
      configuration: {
        name: profile.name,
        baseURL: profile.baseURL,
        protocol: profile.protocol,
        authMode: profile.authMode,
        customHeaderName: profile.customHeaderName,
        customHeaderTemplate: profile.customHeaderTemplate,
        queryParams: profile.queryParams,
        providerId: provider?.id,
        providerLabel: provider?.label,
      },
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : '端点授权失败', errorType: 'blocked' });
  }
});

app.get('/api/session/history', (_req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json({
    history: [...endpointHistory.values()]
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .map(historyMetadata),
  });
});

app.post('/api/session/history/:id/restore', (req, res) => {
  const record = endpointHistory.get(req.params.id);
  res.set('Cache-Control', 'no-store, max-age=0');
  if (!record) {
    res.status(404).json({ error: '历史记录不存在；后端可能已重启或记录已被清理', errorType: 'not_found' });
    return;
  }
  res.json({ profile: structuredClone(record.profile), history: historyMetadata(record) });
});

app.delete('/api/session/history', (_req, res) => {
  endpointHistory.clear();
  endpoints.clear();
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json({ ok: true });
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
    for (const [key, value] of Object.entries(endpoint.queryParams)) target.searchParams.set(key, value);
    const method = req.body.method === 'POST' ? 'POST' : 'GET';
    const requestHeaders: Record<string, string> = {};
    if (req.body.headers && typeof req.body.headers === 'object') {
      for (const [key, value] of Object.entries(req.body.headers)) {
        if (!/^(?:host|content-length|connection|authorization|proxy-authorization|api-key|x-api-key|x-goog-api-key)$/i.test(key)) {
          requestHeaders[key] = String(value);
        }
      }
    }
    const protocolHeaders = endpoint.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : undefined;
    const headers = mergeHeaders({ Accept: 'application/json' }, requestHeaders, protocolHeaders, endpoint.managedHeaders);
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
      preview: buildPreview(data),
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

// 只读参照目录代理：固定白名单上游、免会话令牌、TTL 缓存。
// 新增参照来源只能在这里显式登记——路由永不接受来自客户端的 URL，避免变成通用转发器。
// shape 决定响应如何装箱：'data-array' 只透传目录条目数组（客户端契约稳定），
// 'raw' 原样透传整个 JSON 对象，由客户端按该来源自己的形状解析（目录语义只留在客户端一处）
const REFERENCE_SOURCES = {
  openrouter: { url: 'https://openrouter.ai/api/v1/models', timeoutMs: 10_000, shape: 'data-array' as const },
  modelsdev: { url: 'https://models.dev/api.json', timeoutMs: 30_000, shape: 'raw' as const },
};
type ReferenceSourceId = keyof typeof REFERENCE_SOURCES;
const DEFAULT_REFERENCE_SOURCE: ReferenceSourceId = 'openrouter';
const REFERENCE_TTL_MS = 10 * 60 * 1000;
const REFERENCE_MAX_BYTES = 8 * 1024 * 1024;
// 参照接口对客户端的固定响应形状。stale/staleReason 只在抓取失败降级时由路由层
// 浅拷贝后附加，缓存里的 payload 始终是该类型的干净实例，因此显式命名而非 unknown。
type ReferenceResponseBody = { url: string; fetchedAt: string; data: unknown };
interface ReferencePayload { fetchedAt: string; payload: ReferenceResponseBody }
const referenceCache = new Map<ReferenceSourceId, ReferencePayload>();
// single-flight：并发请求共享同一次上游抓取，避免 TTL 过期瞬间多个详情面板同时打上游
const referenceInFlight = new Map<ReferenceSourceId, Promise<ReferencePayload>>();

// 流式读取并强制体积上限：与 /api/proxy 一致，上游不声明 content-length 时也不能无界缓冲
async function readReferenceBody(response: Response): Promise<string> {
  if (!response.body) throw new Error('参照目录上游响应为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > REFERENCE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`参照目录超过 ${Math.floor(REFERENCE_MAX_BYTES / (1024 * 1024))} MiB 安全上限`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function loadReferencePayload(source: ReferenceSourceId): Promise<ReferencePayload> {
  const config = REFERENCE_SOURCES[source];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const upstream = await fetch(config.url, { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
    if (!upstream.ok) {
      // 上游错误页与目录无关，丢弃响应体而不是先全量读进内存
      await upstream.body?.cancel().catch(() => undefined);
      throw new Error(`参照目录上游返回 HTTP ${upstream.status}`);
    }
    const declaredSize = Number(upstream.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredSize) && declaredSize > REFERENCE_MAX_BYTES) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new Error(`参照目录超过 ${Math.floor(REFERENCE_MAX_BYTES / (1024 * 1024))} MiB 安全上限`);
    }
    const text = await readReferenceBody(upstream);
    const body: unknown = JSON.parse(text);
    const fetchedAt = new Date().toISOString();
    if (config.shape === 'data-array') {
      const entries = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(entries)) throw new Error('参照目录响应结构不受支持');
      // 对外只暴露扁平的条目数组：客户端与测试契约都是 { url, fetchedAt, data: [...] }
      return { fetchedAt, payload: { url: config.url, fetchedAt, data: entries } };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('参照目录响应结构不受支持');
    return { fetchedAt, payload: { url: config.url, fetchedAt, data: body } };
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/api/reference/models', async (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  const requested = typeof req.query.source === 'string' ? req.query.source : DEFAULT_REFERENCE_SOURCE;
  if (!(requested in REFERENCE_SOURCES)) {
    res.status(400).json({ error: `未知的参照目录来源：${requested}`, errorType: 'invalid_url' });
    return;
  }
  const source = requested as ReferenceSourceId;
  const cached = referenceCache.get(source);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < REFERENCE_TTL_MS) {
    res.json(cached.payload);
    return;
  }
  try {
    const pending = referenceInFlight.get(source) ?? loadReferencePayload(source)
      .then((result) => {
        referenceCache.set(source, result);
        return result;
      })
      .finally(() => { referenceInFlight.delete(source); });
    referenceInFlight.set(source, pending);
    const { payload } = await pending;
    // 成功路径返回的 payload 永远不带 stale：过期快照只在抓取失败时作为参照不可用的
    // 降级展示，不参与这里的正常命中；上游恢复后抓取会按 TTL 继续刷新缓存。
    res.json(payload);
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    const errorText = isAbort ? '参照目录获取超时' : error instanceof Error ? `参照目录获取失败：${error.message}` : '参照目录获取失败';
    // 参照目录只是客户端做能力比对的外部基准，短暂取不到时展示旧快照比空白更有用；
    // 但降级不能伪装成新鲜数据，所以标记在浅拷贝副本上附加，缓存本身始终保持干净，
    // 否则下一次正常命中也会带上 stale，客户端无法判断上游是否已经恢复。
    if (cached) {
      const staleBody: ReferenceResponseBody & { stale: true; staleReason: string } = {
        ...cached.payload,
        stale: true,
        staleReason: errorText,
      };
      res.json(staleBody);
      return;
    }
    res.status(502).json({
      error: errorText,
      errorType: isAbort ? 'timeout' : 'network',
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json({
    ok: true,
    service: HEALTH_SERVICE,
    guardVersion: GUARD_VERSION,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    guards: {
      localNetworkDefaultDenied: true,
      sameOriginRedirects: true,
      responseLimitEnforced: true,
    },
  });
});

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(serverDir, '../dist');
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

app.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`LLM endpoint probe proxy: http://127.0.0.1:${PORT}\n`);
});
