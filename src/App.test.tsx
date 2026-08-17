import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('discovery workflow', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); });

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
});
