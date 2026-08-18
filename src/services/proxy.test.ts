import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProfile } from '../lib/profile';
import { authorizeEndpoint, checkProxyHealth, clearEndpointHistory, listEndpointHistory, ProbeError, restoreEndpointHistory } from './proxy';

function healthResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    ok: true,
    service: 'llm-endpoint-probe-proxy',
    guardVersion: 1,
    maxResponseBytes: 4 * 1024 * 1024,
    guards: {
      localNetworkDefaultDenied: true,
      sameOriginRedirects: true,
      responseLimitEnforced: true,
    },
    ...overrides,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('proxy health guard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts only a signed health response with all guards enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(healthResponse());
    await expect(checkProxyHealth()).resolves.toMatchObject({
      service: 'llm-endpoint-probe-proxy',
      maxResponseBytes: 4 * 1024 * 1024,
      guards: { localNetworkDefaultDenied: true, sameOriginRedirects: true, responseLimitEnforced: true },
    });
    expect(fetch).toHaveBeenCalledWith('/api/health', expect.objectContaining({ cache: 'no-store' }));
  });

  it('rejects a generic or weakened health response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(healthResponse({ guards: { localNetworkDefaultDenied: false } }));
    await expect(checkProxyHealth()).rejects.toMatchObject({ type: 'format' } satisfies Partial<ProbeError>);
  });

  it('returns an actionable network error when the proxy is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(checkProxyHealth()).rejects.toMatchObject({
      type: 'network',
      message: '无法连接本地受控代理；请确认代理进程已启动',
    } satisfies Partial<ProbeError>);
  });
});

describe('endpoint session history', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the complete profile once and applies backend-resolved configuration', async () => {
    const profile = { ...createProfile(), baseURL: 'https://api.anthropic.com/v1', apiKey: 'secret' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      endpointToken: 'token',
      configuration: { protocol: 'anthropic', authMode: 'custom', customHeaderName: 'x-api-key', customHeaderTemplate: '{{key}}' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(authorizeEndpoint(profile)).resolves.toMatchObject({
      endpointToken: 'token',
      profile: { baseURL: profile.baseURL, apiKey: 'secret', protocol: 'anthropic', authMode: 'custom', customHeaderName: 'x-api-key' },
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.profile).toMatchObject({ baseURL: profile.baseURL, apiKey: 'secret' });
  });

  it('lists, restores, and clears process-memory history with no-store requests', async () => {
    const profile = { ...createProfile(), baseURL: 'https://example.com/v1', apiKey: 'restored-secret' };
    const item = { id: 'history-1', name: 'Example', baseURL: profile.baseURL, protocol: 'auto', authMode: 'bearer', hasApiKey: true, createdAt: '2026-08-18T00:00:00.000Z', lastUsedAt: '2026-08-18T00:01:00.000Z' };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ history: [item] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ profile }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(listEndpointHistory()).resolves.toEqual([item]);
    await expect(restoreEndpointHistory(item.id)).resolves.toMatchObject({ apiKey: 'restored-secret' });
    await expect(clearEndpointHistory()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET', init?.cache])).toEqual([
      ['/api/session/history', 'GET', 'no-store'],
      ['/api/session/history/history-1/restore', 'POST', 'no-store'],
      ['/api/session/history', 'DELETE', 'no-store'],
    ]);
  });
});
