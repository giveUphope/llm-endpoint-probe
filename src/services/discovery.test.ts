import { describe, expect, it } from 'vitest';
import type { ProxyResponse } from '../domain/types';
import { evaluateValidation, mergeValidationEvidence } from './discovery';

function response(data: unknown, contentType = 'application/json'): ProxyResponse {
  return { ok: true, status: 200, durationMs: 8, responseBytes: 10, data, headers: { 'content-type': contentType } };
}

describe('active validation evidence', () => {
  it('requires an observed tool call before marking tools supported', () => {
    expect(evaluateValidation('supportsTools', response({ choices: [{ message: { content: 'OK' } }] })).value).toBe('unknown');
    expect(evaluateValidation('supportsTools', response({ choices: [{ message: { tool_calls: [{ id: '1' }] } }] })).value).toBe('supported');
  });

  it('requires parseable JSON for JSON mode', () => {
    expect(evaluateValidation('supportsJsonMode', response({ choices: [{ message: { content: '{"ok":true}' } }] })).value).toBe('supported');
    expect(evaluateValidation('supportsJsonMode', response({ choices: [{ message: { content: 'OK' } }] })).value).toBe('unknown');
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
});
