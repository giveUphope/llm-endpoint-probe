import { describe, expect, it } from 'vitest';
import { buildAuthHeaders, mergeHeaders, normalizeApiKey, redactHeaders, redactText, sanitizeData } from './security';

describe('security redaction', () => {
  it('redacts authorization and API key headers', () => {
    expect(redactHeaders({ Authorization: 'Bearer secret-123', 'api-key': 'abcdef', Accept: 'application/json' })).toEqual({
      Authorization: '[REDACTED]', 'api-key': '[REDACTED]', Accept: 'application/json',
    });
  });

  it('treats Gemini API key headers as sensitive', () => {
    expect(redactHeaders({ 'x-goog-api-key': 'gemini-secret' })).toEqual({ 'x-goog-api-key': '[REDACTED]' });
  });

  it('redacts a configured key value even under a nonstandard custom header', () => {
    expect(redactHeaders({ 'X-Custom-Auth': 'Token private-key-value' }, ['private-key-value'])).toEqual({
      'X-Custom-Auth': 'Token [REDACTED]',
    });
  });

  it('redacts bearer tokens, configured secrets, and nested sensitive fields', () => {
    expect(redactText('Bearer abc.def and custom-secret', ['custom-secret'])).toBe('Bearer [REDACTED] and [REDACTED]');
    expect(sanitizeData({ message: 'custom-secret', token: 'abc', nested: { apiKey: 'def' } }, ['custom-secret'])).toEqual({
      message: '[REDACTED]', token: '[REDACTED]', nested: { apiKey: '[REDACTED]' },
    });
  });

  it('builds custom auth templates without logging them', () => {
    expect(buildAuthHeaders('custom', 'key-value', 'X-Auth', 'Token {{key}}')).toEqual({ 'X-Auth': 'Token key-value' });
  });

  it('normalizes pasted Bearer values and quoted keys', () => {
    expect(normalizeApiKey(' Authorization: Bearer Bearer sk-or-v1-test ', 'bearer')).toBe('sk-or-v1-test');
    expect(buildAuthHeaders('bearer', '"sk-or-v1-test"', '', '')).toEqual({ Authorization: 'Bearer sk-or-v1-test' });
  });

  it('merges header names case-insensitively with the latest value winning', () => {
    expect(mergeHeaders({ authorization: 'stale', Accept: 'text/plain' }, { Authorization: 'Bearer current' })).toEqual({
      Authorization: 'Bearer current', Accept: 'text/plain',
    });
  });
});
