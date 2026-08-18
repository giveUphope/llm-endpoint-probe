import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createProfile } from './lib/profile';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function proxyHealthResponse(): Response {
  return jsonResponse({
    ok: true,
    service: 'llm-endpoint-probe-proxy',
    guardVersion: 1,
    maxResponseBytes: 4 * 1024 * 1024,
    guards: { localNetworkDefaultDenied: true, sameOriginRedirects: true, responseLimitEnforced: true },
  });
}

describe('discovery workflow', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('discovers and displays an OpenAI-compatible model', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return proxyHealthResponse();
      if (url.endsWith('/api/session/history')) return jsonResponse({ history: [] });
      if (url.endsWith('/api/session/endpoints')) return jsonResponse({ endpointToken: 'session-token' });
      if (url.endsWith('/api/proxy')) {
        const body = JSON.parse(String(init?.body));
        expect(body.headers.Authorization).toBeUndefined();
        return jsonResponse({ ok: true, status: 200, durationMs: 12, responseBytes: 96, data: { data: [{ id: 'model-from-probe', context_window: 16000 }] }, headers: {} });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /本地代理已连接/ })).toBeInTheDocument());
    expect(screen.queryByLabelText('API 协议')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('认证方式')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('已保存端点')).not.toBeInTheDocument();
    expect(screen.queryByText('附加 Headers')).not.toBeInTheDocument();
    expect(screen.queryByText('查询参数')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL'), { target: { value: 'https://example.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '开始分层探测' }));

    await waitFor(() => expect(screen.getAllByText('model-from-probe').length).toBeGreaterThan(0));
    expect(screen.getByText('GET /models')).toBeInTheDocument();
    expect(screen.getByText('探测完成')).toBeInTheDocument();
  });

  it('keeps OpenRouter discovery usable while surfacing an authentication failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return proxyHealthResponse();
      if (url.endsWith('/api/session/history')) return jsonResponse({ history: [] });
      if (url.endsWith('/api/session/endpoints')) return jsonResponse({ endpointToken: 'openrouter-session' });
      if (url.endsWith('/api/proxy')) {
        const body = JSON.parse(String(init?.body));
        expect(body.headers.Authorization).toBeUndefined();
        if (body.path === '/key') {
          return jsonResponse({ ok: false, status: 401, durationMs: 9, responseBytes: 50, data: { error: { message: 'Invalid API key' } }, headers: {}, errorType: 'auth' }, 401);
        }
        return jsonResponse({ ok: true, status: 200, durationMs: 12, responseBytes: 96, data: { data: [{ id: 'openrouter/test-model' }] }, headers: {} });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /本地代理已连接/ })).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL'), { target: { value: 'https://openrouter.ai/api/v1/' } });
    expect(screen.queryByText(/已识别 OpenRouter/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '应用推荐' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'Bearer sk-or-v1-invalid' } });
    fireEvent.click(screen.getByRole('button', { name: '开始分层探测' }));

    await waitFor(() => expect(screen.getAllByText('openrouter/test-model').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /探测与请求/ }));
    expect(screen.getByText(/OpenRouter拒绝了自动认证/)).toBeInTheDocument();
    expect(screen.getByText('认证诊断')).toBeInTheDocument();
  });

  it('shows an offline guard and blocks endpoint authorization when the proxy is unreachable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection refused'));

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /本地代理离线/ })).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('页面可以继续编辑配置，但不会发送端点请求');

    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL'), { target: { value: 'https://example.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '重试代理并开始探测' }));

    await waitFor(() => expect(screen.getByText('本地受控代理不可用，请启动代理后重试')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/session/endpoints'))).toBe(false);
  });

  it('uses a closed configuration drawer on compact screens', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(proxyHealthResponse());

    render(<App />);
    expect(screen.queryByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开配置' }));
    expect(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭连接配置' }));
    expect(screen.queryByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).not.toBeInTheDocument();
  });

  it('restores an endpoint and API key from backend process history without saving it locally', async () => {
    const restored = { ...createProfile(), name: '历史端点', baseURL: 'https://api.anthropic.com/v1', apiKey: 'history-secret', protocol: 'anthropic', authMode: 'custom', customHeaderName: 'x-api-key' };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return proxyHealthResponse();
      if (url.endsWith('/api/session/history') && (!init?.method || init.method === 'GET')) return jsonResponse({ history: [{ id: 'history-1', name: restored.name, baseURL: restored.baseURL, providerLabel: 'Anthropic', protocol: restored.protocol, authMode: restored.authMode, hasApiKey: true, createdAt: restored.createdAt, lastUsedAt: restored.updatedAt }] });
      if (url.endsWith('/api/session/history/history-1/restore')) return jsonResponse({ profile: restored });
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('option', { name: /历史端点/ })).toBeInTheDocument());
    const restoreButton = screen.getByRole('button', { name: '还原端点和 API Key' });
    await waitFor(() => expect(restoreButton).toBeEnabled());
    fireEvent.click(restoreButton);

    await waitFor(() => expect(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).toHaveValue(restored.baseURL));
    expect(screen.getByLabelText('API Key')).toHaveValue('history-secret');
    expect(localStorage.getItem('llm-endpoint-probe:profiles:v1')).toBeNull();
  });
});
