import { describe, expect, it } from 'vitest';
import type { ProxyResponse } from '../domain/types';
import { describeHttpFailure, evaluateValidation, mergeValidationEvidence, summarizeResponse } from './discovery';
import { createProfile } from '../lib/profile';

function response(data: unknown, contentType = 'application/json'): ProxyResponse {
  return { ok: true, status: 200, durationMs: 8, responseBytes: 10, data, headers: { 'content-type': contentType } };
}

describe('active validation evidence', () => {
  it('requires an observed tool call before marking tools supported', () => {
    expect(evaluateValidation('supportsTools', response({ choices: [{ message: { content: 'OK' } }] })).value).toBe('unknown');
    expect(evaluateValidation('supportsTools', response({ choices: [{ message: { tool_calls: [{ id: '1' }] } }] })).value).toBe('supported');
    expect(evaluateValidation('supportsTools', response({ candidates: [{ content: { parts: [{ functionCall: { name: 'probe_noop' } }] } }] })).value).toBe('supported');
  });

  it('requires parseable JSON for JSON mode', () => {
    expect(evaluateValidation('supportsJsonMode', response({ choices: [{ message: { content: '{"ok":true}' } }] })).value).toBe('supported');
    expect(evaluateValidation('supportsJsonMode', response({ choices: [{ message: { content: 'OK' } }] })).value).toBe('unknown');
    expect(evaluateValidation('supportsJsonMode', response({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })).value).toBe('supported');
  });

  it('recognizes event streams and keeps behavior-only parameters unknown', () => {
    expect(evaluateValidation('supportsStreaming', response('data: {"ok":true}', 'text/event-stream')).value).toBe('supported');
    expect(evaluateValidation('supportsTemperature', response({ choices: [] }))).toMatchObject({ value: 'unknown', confidence: 'medium' });
  });

  it('does not erase endpoint declarations when validation is inconclusive', () => {
    const previous = { value: 'supported' as const, evidence: [{ source: 'endpoint' as const, confidence: 'medium' as const, detail: 'declared', timestamp: new Date().toISOString() }] };
    const merged = mergeValidationEvidence(previous, { value: 'unknown', confidence: 'unknown', detail: 'HTTP 404' });
    expect(merged.value).toBe('supported');
    expect(merged.evidence).toHaveLength(2);
  });

  it('turns authentication failures into actionable provider guidance', () => {
    const profile = { ...createProfile(), baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-v1-invalid' };
    expect(describeHttpFailure(401, { error: { message: 'Invalid API key' } }, profile)).toBe(
      'HTTP 401：OpenRouter拒绝了自动认证，请确认 API Key 有效、未过期且具有接口权限；服务端：Invalid API key',
    );
  });

  it('limits model-list request previews without losing the total count', () => {
    const result = summarizeResponse({ data: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }] });
    expect(result).toMatchObject({ totalItems: 4, truncated: true });
    expect((result as { data: unknown[] }).data).toHaveLength(3);
  });

});
