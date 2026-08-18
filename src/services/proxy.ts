import type { EndpointProfile, ProbeErrorType, ProxyRequest, ProxyResponse } from '../domain/types';

export class ProbeError extends Error {
  constructor(
    message: string,
    public type: ProbeErrorType,
    public status?: number,
    public details?: unknown,
  ) { super(message); }
}

export interface ProxyHealth {
  ok: true;
  service: 'llm-endpoint-probe-proxy';
  guardVersion: number;
  maxResponseBytes: number;
  guards: {
    localNetworkDefaultDenied: true;
    sameOriginRedirects: true;
    responseLimitEnforced: true;
  };
}

export interface EndpointHistoryItem {
  id: string;
  name: string;
  baseURL: string;
  providerId?: string;
  providerLabel?: string;
  protocol: EndpointProfile['protocol'];
  authMode: EndpointProfile['authMode'];
  hasApiKey: boolean;
  createdAt: string;
  lastUsedAt: string;
}

interface ResolvedEndpointConfiguration {
  name: string;
  baseURL: string;
  protocol: EndpointProfile['protocol'];
  authMode: EndpointProfile['authMode'];
  customHeaderName: string;
  customHeaderTemplate: string;
  queryParams: EndpointProfile['queryParams'];
  providerId?: string;
  providerLabel?: string;
}

export interface EndpointAuthorization {
  endpointToken: string;
  profile: EndpointProfile;
  history?: EndpointHistoryItem;
}

function isProxyHealth(value: unknown): value is ProxyHealth {
  if (!value || typeof value !== 'object') return false;
  const health = value as Partial<ProxyHealth>;
  return health.ok === true &&
    health.service === 'llm-endpoint-probe-proxy' &&
    typeof health.guardVersion === 'number' && health.guardVersion >= 1 &&
    typeof health.maxResponseBytes === 'number' && health.maxResponseBytes > 0 &&
    health.guards?.localNetworkDefaultDenied === true &&
    health.guards.sameOriginRedirects === true &&
    health.guards.responseLimitEnforced === true;
}

export async function checkProxyHealth(signal?: AbortSignal, timeoutMs = 3000): Promise<ProxyHealth> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch('/api/health', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const data = await response.json().catch(() => undefined);
    if (!response.ok) throw new ProbeError(`本地受控代理健康检查返回 HTTP ${response.status}`, 'network', response.status);
    if (!isProxyHealth(data)) throw new ProbeError('健康检查响应不是受支持的本地受控代理', 'format');
    return data;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (signal?.aborted) throw new ProbeError('代理健康检查已取消', 'cancelled');
    if (timedOut) throw new ProbeError(`本地受控代理健康检查在 ${timeoutMs}ms 后超时`, 'timeout');
    throw new ProbeError('无法连接本地受控代理；请确认代理进程已启动', 'network', undefined, error);
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function authorizeEndpoint(profile: EndpointProfile, signal?: AbortSignal): Promise<EndpointAuthorization> {
  let response: Response;
  try {
    response = await fetch('/api/session/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ profile }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new ProbeError('请求被用户取消', 'cancelled');
    throw new ProbeError('无法连接本地受控代理', 'network', undefined, error);
  }
  const data = await response.json().catch(() => ({})) as { endpointToken?: string; configuration?: ResolvedEndpointConfiguration; history?: EndpointHistoryItem; error?: string; errorType?: ProbeErrorType };
  if (!response.ok || !data.endpointToken) throw new ProbeError(data.error || '端点授权失败', data.errorType || 'blocked', response.status);
  return {
    endpointToken: data.endpointToken,
    profile: data.configuration ? { ...profile, ...data.configuration } : profile,
    history: data.history,
  };
}

export async function listEndpointHistory(signal?: AbortSignal): Promise<EndpointHistoryItem[]> {
  try {
    const response = await fetch('/api/session/history', { cache: 'no-store', credentials: 'same-origin', signal });
    const data = await response.json().catch(() => ({})) as { history?: EndpointHistoryItem[]; error?: string };
    if (!response.ok) throw new ProbeError(data.error || '读取探测历史失败', 'network', response.status);
    return Array.isArray(data.history) ? data.history : [];
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (signal?.aborted) throw new ProbeError('读取探测历史已取消', 'cancelled');
    throw new ProbeError('无法读取后端探测历史', 'network', undefined, error);
  }
}

export async function restoreEndpointHistory(id: string, signal?: AbortSignal): Promise<EndpointProfile> {
  try {
    const response = await fetch(`/api/session/history/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
    });
    const data = await response.json().catch(() => ({})) as { profile?: EndpointProfile; error?: string; errorType?: ProbeErrorType };
    if (!response.ok || !data.profile) throw new ProbeError(data.error || '还原探测历史失败', data.errorType || 'not_found', response.status);
    return data.profile;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (signal?.aborted) throw new ProbeError('还原探测历史已取消', 'cancelled');
    throw new ProbeError('无法连接后端以还原探测历史', 'network', undefined, error);
  }
}

export async function clearEndpointHistory(signal?: AbortSignal): Promise<void> {
  try {
    const response = await fetch('/api/session/history', {
      method: 'DELETE',
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new ProbeError(data.error || '清空探测历史失败', 'network', response.status);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if (signal?.aborted) throw new ProbeError('清空探测历史已取消', 'cancelled');
    throw new ProbeError('无法连接后端以清空探测历史', 'network', undefined, error);
  }
}

export async function proxyRequest(request: ProxyRequest, signal?: AbortSignal): Promise<ProxyResponse> {
  let response: Response;
  try {
    response = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new ProbeError('请求被用户取消', 'cancelled');
    throw new ProbeError('本地代理不可达', 'network', undefined, error);
  }
  const payload = await response.json().catch(() => ({})) as Partial<ProxyResponse> & { error?: string; errorType?: ProbeErrorType };
  if (!response.ok && !('status' in payload)) {
    throw new ProbeError(payload.error || `代理返回 ${response.status}`, payload.errorType || 'network', response.status, payload);
  }
  return payload as ProxyResponse;
}
