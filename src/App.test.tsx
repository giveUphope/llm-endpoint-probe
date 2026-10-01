import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { PROBE_FAKE_MODEL_ID } from './adapters/shared';
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return proxyHealthResponse();
      if (url.endsWith('/api/reference/models')) return jsonResponse({ url: 'https://openrouter.ai/api/v1/models', fetchedAt: '2026-09-30T00:00:00.000Z', data: [] });
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
    // 参照目录是独立只读通道：探测完成后即可比对，且不经过 /api/proxy
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/reference/models'))).toBe(true);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/proxy')).every(([, init]) => String(JSON.parse(String(init?.body)).endpointToken ?? '') === 'session-token')).toBe(true);
    // 探测即验证：发现模型后必须自动发出能力验证请求，不再依赖任何用户勾选
    const proxyCalls = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/proxy'))
      .map(([, init]) => JSON.parse(String(init?.body)) as { method?: string; path?: string });
    expect(proxyCalls.some((call) => call.method === 'POST' && String(call.path).includes('chat/completions'))).toBe(true);
    expect(proxyCalls.filter((call) => call.method === 'POST').length).toBeGreaterThan(1);
  });

  it('keeps OpenRouter discovery usable while surfacing an authentication failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return proxyHealthResponse();
      if (url.endsWith('/api/reference/models')) return jsonResponse({ url: 'https://openrouter.ai/api/v1/models', fetchedAt: '2026-09-30T00:00:00.000Z', data: [] });
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
    // 认证失败后端点不可用：不得再为验证狂发请求，能力结论只保留目录声明
    const calls = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/proxy'))
      .map(([, init]) => JSON.parse(String(init?.body)) as { method?: string; path?: string });
    expect(calls.some((call) => call.method === 'POST' && String(call.path).includes('chat/completions'))).toBe(false);
    expect(screen.getByText(/跳过 1 个模型的主动验证/)).toBeInTheDocument();
  });

  it('does not spray validation requests at a key-free OpenRouter catalog', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return proxyHealthResponse();
      if (url.endsWith('/api/reference/models')) return jsonResponse({ url: 'https://openrouter.ai/api/v1/models', fetchedAt: '2026-09-30T00:00:00.000Z', data: [] });
      if (url.endsWith('/api/session/history')) return jsonResponse({ history: [] });
      if (url.endsWith('/api/session/endpoints')) return jsonResponse({ endpointToken: 'keyless-session' });
      if (url.endsWith('/api/proxy')) {
        return jsonResponse({ ok: true, status: 200, durationMs: 10, responseBytes: 80, data: { data: [{ id: 'deepseek/deepseek-chat' }] }, headers: {} });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /本地代理已连接/ })).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL'), { target: { value: 'https://openrouter.ai/api/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '开始分层探测' }));
    await waitFor(() => expect(screen.getAllByText('deepseek/deepseek-chat').length).toBeGreaterThan(0));

    const chatPosts = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/proxy'))
      .map(([, init]) => JSON.parse(String(init?.body)) as { method?: string; path?: string })
      .filter((call) => call.method === 'POST' && String(call.path).includes('chat/completions'));
    expect(chatPosts).toHaveLength(0);
    // 免密端点上“继续验证”必须禁用：显式动作也不该打出成片 401（工具栏在模型结果视图里）
    const blocked = screen.getByRole('button', { name: /继续验证 1 个未验证模型/ });
    expect(blocked).toBeDisabled();
    expect(blocked.getAttribute('title')).toContain('401');
    fireEvent.click(screen.getByRole('button', { name: /探测与请求/ }));
    expect(screen.getByText(/免密目录可读但生成接口需要凭据/)).toBeInTheDocument();
  });

  it('automatically validates every discovered model without a cap', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return proxyHealthResponse();
      if (url.endsWith('/api/reference/models')) return jsonResponse({ url: 'https://openrouter.ai/api/v1/models', fetchedAt: '2026-09-30T00:00:00.000Z', data: [] });
      if (url.endsWith('/api/session/history')) return jsonResponse({ history: [] });
      if (url.endsWith('/api/session/endpoints')) return jsonResponse({ endpointToken: 'budget-session' });
      if (url.endsWith('/api/proxy')) {
        return jsonResponse({ ok: true, status: 200, durationMs: 10, responseBytes: 80, data: { data: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }] }, headers: {} });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /本地代理已连接/ })).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL'), { target: { value: 'https://api.openai.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: '开始分层探测' }));

    await waitFor(() => expect(screen.getAllByText('m-3').length).toBeGreaterThan(0));
    // 不设上限：三个模型都应被自动验证，工具栏不应出现“继续验证”
    expect(screen.queryByText(/继续验证/)).not.toBeInTheDocument();
    const probedModels = new Set(fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/api/proxy'))
      .map(([, init]) => JSON.parse(String(init?.body)) as { method?: string; path?: string; body?: { model?: string } })
      .filter((call) => call.method === 'POST' && String(call.path).includes('chat/completions'))
      .map((call) => call.body?.model));
    expect([...probedModels].sort()).toEqual([...['m-1', 'm-2', 'm-3', PROBE_FAKE_MODEL_ID]].sort());
  });

  it('never renders probe request bodies in the probe log', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/health')) return proxyHealthResponse();
      if (url.endsWith('/api/reference/models')) return jsonResponse({ url: 'https://openrouter.ai/api/v1/models', fetchedAt: '2026-09-30T00:00:00.000Z', data: [] });
      if (url.endsWith('/api/session/history')) return jsonResponse({ history: [] });
      if (url.endsWith('/api/session/endpoints')) return jsonResponse({ endpointToken: 'body-session' });
      if (url.endsWith('/api/proxy')) {
        return jsonResponse({ ok: true, status: 200, durationMs: 10, responseBytes: 80, data: { data: [{ id: 'secret-ish-model' }] }, headers: {} });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /本地代理已连接/ })).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL'), { target: { value: 'https://api.openai.com/v1' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: '开始分层探测' }));
    await waitFor(() => expect(screen.getAllByText('secret-ish-model').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /探测与请求/ }));
    fireEvent.click(screen.getByRole('button', { name: /\/models/ }));
    expect(screen.queryByText('请求体摘要')).not.toBeInTheDocument();
    expect(screen.queryByText(/Reply with|messages/)).not.toBeInTheDocument();
    expect(screen.getByText('脱敏 Headers')).toBeInTheDocument();
    expect(screen.getByText('响应预览')).toBeInTheDocument();
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
    // 参照目录获取失败必须静默降级：不阻塞页面，也不产生探测类请求
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/proxy'))).toBe(false);
  });

  it('uses a closed configuration drawer on compact screens', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(proxyHealthResponse());

    render(<App />);
    expect(screen.queryByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开配置' }));
    expect(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '收起配置' }));
    expect(screen.queryByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).not.toBeInTheDocument();
  });

  it('exposes a single configuration control per drawer state on compact screens', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(proxyHealthResponse());

    render(<App />);
    // 抽屉关闭：只有标题栏的“展开配置”，面板内无关闭按钮
    expect(screen.getByRole('button', { name: '展开配置' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '关闭配置' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开配置' }));
    // 抽屉展开：标题栏的“收起配置”是唯一控制按钮，面板内没有关闭按钮
    expect(screen.getByRole('button', { name: '收起配置' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '关闭配置' })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    // Esc 关闭抽屉后恢复“展开配置”，且焦点回到该按钮
    expect(screen.queryByRole('button', { name: '收起配置' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '展开配置' }));
  });

  it('keeps the heading toggle as the sole control on wide screens', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(proxyHealthResponse());

    render(<App />);
    const toggle = screen.getByRole('button', { name: '收起配置' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: '展开配置' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '展开配置' }));
    expect(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).toBeInTheDocument();
  });

  it('restores an endpoint and API key from backend process history without saving it locally', async () => {
    const restored = { ...createProfile(), name: '历史端点', baseURL: 'https://api.anthropic.com/v1', apiKey: 'history-secret', protocol: 'anthropic', authMode: 'custom', customHeaderName: 'x-api-key' };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/reference/models')) return jsonResponse({ url: 'https://openrouter.ai/api/v1/models', fetchedAt: '2026-09-30T00:00:00.000Z', data: [] });
      if (url.endsWith('/api/session/history') && (!init?.method || init.method === 'GET')) return jsonResponse({ history: [{ id: 'history-1', name: restored.name, baseURL: restored.baseURL, providerLabel: 'Anthropic', protocol: restored.protocol, authMode: restored.authMode, hasApiKey: true, createdAt: restored.createdAt, lastUsedAt: restored.updatedAt }] });
      if (url.endsWith('/api/session/history/history-1/restore')) return jsonResponse({ profile: restored });
      return proxyHealthResponse();
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('option', { name: /历史端点/ })).toBeInTheDocument());
    const restoreButton = screen.getByRole('button', { name: '还原端点和 API Key' });
    await waitFor(() => expect(restoreButton).toBeEnabled());
    fireEvent.click(restoreButton);

    await waitFor(() => expect(screen.getByPlaceholderText('https://api.example.com/v1 或完整请求 URL')).toHaveValue(restored.baseURL));
    expect(screen.getByLabelText('API Key')).toHaveValue('history-secret');
    expect(localStorage.getItem('llm-endpoint-probe:profiles:v1')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/reference/models'))).toBe(true);
  });
});
