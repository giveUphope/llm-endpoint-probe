import type { EndpointProfile, ProbeErrorType, ProxyRequest, ProxyResponse } from '../domain/types';

export class ProbeError extends Error {
  constructor(
    message: string,
    public type: ProbeErrorType,
    public status?: number,
    public details?: unknown,
  ) { super(message); }
}

export async function authorizeEndpoint(profile: EndpointProfile, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/session/endpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL: profile.baseURL, allowLocalNetwork: profile.allowLocalNetwork }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new ProbeError('请求被用户取消', 'cancelled');
    throw new ProbeError('无法连接本地受控代理', 'network', undefined, error);
  }
  const data = await response.json().catch(() => ({})) as { endpointToken?: string; error?: string; errorType?: ProbeErrorType };
  if (!response.ok || !data.endpointToken) throw new ProbeError(data.error || '端点授权失败', data.errorType || 'blocked', response.status);
  return data.endpointToken;
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
