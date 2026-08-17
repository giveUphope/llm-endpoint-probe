import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('discovery workflow', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('discovers and displays an OpenAI-compatible model', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/endpoints')) return jsonResponse({ endpointToken: 'session-token' });
      if (url.endsWith('/api/proxy')) {
        const body = JSON.parse(String(init?.body));
        expect(body.headers.Authorization).toBeUndefined();
        return jsonResponse({ ok: true, status: 200, durationMs: 12, responseBytes: 96, data: { data: [{ id: 'model-from-probe', context_window: 16000 }] }, headers: {} });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), { target: { value: 'https://example.com/v1' } });
    fireEvent.click(screen.getByRole('button', { name: '开始分层探测' }));

    await waitFor(() => expect(screen.getAllByText('model-from-probe').length).toBeGreaterThan(0));
    expect(screen.getByText('GET /models')).toBeInTheDocument();
    expect(screen.getByText('探测完成')).toBeInTheDocument();
  });

  it('keeps OpenRouter discovery usable while surfacing an authentication failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/session/endpoints')) return jsonResponse({ endpointToken: 'openrouter-session' });
      if (url.endsWith('/api/proxy')) {
        const body = JSON.parse(String(init?.body));
        expect(body.headers.Authorization).toBe('Bearer sk-or-v1-invalid');
        if (body.path === '/key') {
          return jsonResponse({ ok: false, status: 401, durationMs: 9, responseBytes: 50, data: { error: { message: 'Invalid API key' } }, headers: {}, errorType: 'auth' }, 401);
        }
        return jsonResponse({ ok: true, status: 200, durationMs: 12, responseBytes: 96, data: { data: [{ id: 'openrouter/test-model' }] }, headers: {} });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText('https://api.example.com/v1'), { target: { value: 'https://openrouter.ai/api/v1/' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'Bearer sk-or-v1-invalid' } });
    fireEvent.click(screen.getByRole('button', { name: '开始分层探测' }));

    await waitFor(() => expect(screen.getAllByText('openrouter/test-model').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /探测与请求/ }));
    expect(screen.getByText(/OpenRouter拒绝了认证/)).toBeInTheDocument();
    expect(screen.getByText('认证诊断')).toBeInTheDocument();
  });
});
