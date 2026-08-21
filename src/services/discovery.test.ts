import { describe, expect, it } from 'vitest';
import type { DiscoveredModel, ProxyResponse } from '../domain/types';
import { PROBE_FAKE_MODEL_ID } from '../adapters/shared';
import { emptyCapabilities } from '../domain/capabilities';
import { aggregateProbe, buildNameCheck, classifyUpstreamError, describeHttpFailure, evaluateValidation, interpretExplicitRejection, mergeValidationEvidence, modelGenerationInterfaces, modelInterfaces, summarizeResponse } from './discovery';
import { createProfile } from '../lib/profile';

function discoveredModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-4o', displayName: 'GPT-4o', protocol: 'openai-chat', inputModalities: ['text'],
    capabilities: emptyCapabilities(), reasoningLevels: [], supportedEndpoints: ['/chat/completions'],
    discoverySource: 'test', confidence: 'unknown', status: 'discovered',
    lastProbedAt: new Date().toISOString(), rawMetadata: {}, ...overrides,
  };
}

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
    expect(evaluateValidation('supportsStreaming', response('data: {"ok":true}')).value).toBe('supported');
    expect(evaluateValidation('supportsStreaming', response([
      { event: 'response.text.delta', data: '{"delta":"hi"}' },
    ])).value).toBe('supported');
    expect(evaluateValidation('supportsStreaming', response('event: message\ndata: {"text_delta":"hi"}')).value).toBe('supported');
    expect(evaluateValidation('supportsStreaming', response({ choices: [] })).value).toBe('unknown');
    expect(evaluateValidation('supportsTemperature', response({ choices: [] }))).toMatchObject({ value: 'unknown', confidence: 'medium' });
  });

  it('detects reasoning content in the response before marking reasoning supported', () => {
    expect(evaluateValidation('supportsReasoning', response({ choices: [{ message: { content: 'OK', reasoning_content: 'thinking step...' } }] })).value).toBe('supported');
    expect(evaluateValidation('supportsReasoning', response({ candidates: [{ content: [{ type: 'thinking', text: 'thinking' }, { text: 'OK' }] }] })).value).toBe('supported');
    expect(evaluateValidation('supportsReasoning', response({ choices: [{ message: { content: 'OK' } }] })).value).toBe('unknown');
    expect(evaluateValidation('supportsReasoning', response({ thinking: 'reasoning text' })).value).toBe('supported');
  });

  it('reports stop-sequence observation without claiming definite support', () => {
    expect(evaluateValidation('supportsStop', response({ choices: [{ message: { content: 'OK' } }] })).value).toBe('unknown');
    expect(evaluateValidation('supportsStop', response({ choices: [{ message: { content: 'OK' } }] })).detail).toContain('无法确认');
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

describe('model name verification', () => {
  it('marks the name as verified when the endpoint echoes the requested id', () => {
    const check = buildNameCheck('gpt-4o', ['gpt-4o'], undefined);
    expect(check).toMatchObject({ echoedModelId: 'gpt-4o', aliased: false });
  });

  it('surfaces the real model when a fake name is answered by a different echo', () => {
    const check = buildNameCheck('my-fake-model', ['gpt-4o'], undefined);
    expect(check).toMatchObject({ echoedModelId: 'gpt-4o', aliased: true });
  });

  it('prefers the mismatched echo and tolerates versioned echoes', () => {
    const check = buildNameCheck('my-fake-model', ['gpt-4o', 'my-fake-model'], { accepted: false, modelId: PROBE_FAKE_MODEL_ID });
    expect(check).toMatchObject({ echoedModelId: 'gpt-4o', aliased: true, acceptsUnknownNames: false, probeModelId: PROBE_FAKE_MODEL_ID });
    expect(buildNameCheck('gemini-2.5-flash', ['gemini-2.5-flash-001'], undefined)).toMatchObject({ echoedModelId: 'gemini-2.5-flash-001', aliased: false });
  });

  it('records whether the endpoint silently accepts unknown names', () => {
    expect(buildNameCheck('gpt-4o', [], { accepted: true, modelId: PROBE_FAKE_MODEL_ID }).acceptsUnknownNames).toBe(true);
    expect(buildNameCheck('gpt-4o', [], { accepted: undefined, modelId: PROBE_FAKE_MODEL_ID })).not.toHaveProperty('acceptsUnknownNames');
  });

  it('returns an empty check when neither echo nor probe outcome exists', () => {
    const check = buildNameCheck('gpt-4o', [], undefined);
    expect(check).toEqual({ checkedAt: expect.any(String) });
  });
});

describe('gateway error classification', () => {
  it('recognizes New API model-not-found errors as model_unavailable', () => {
    expect(classifyUpstreamError({ error: { message: '该模型不存在', type: 'new_api_error' } }, 400)).toMatchObject({ kind: 'model_unavailable' });
    expect(classifyUpstreamError({ error: { message: '当前分组下无可用渠道', type: 'new_api_error' } }, 400)).toMatchObject({ kind: 'model_unavailable' });
  });

  it('distinguishes auth, balance, rate limits and server failures', () => {
    expect(classifyUpstreamError({ error: { message: '未提供令牌' } }, 401)).toMatchObject({ kind: 'auth' });
    expect(classifyUpstreamError({ error: { message: '余额不足' } }, 400)).toMatchObject({ kind: 'balance' });
    expect(classifyUpstreamError({ error: { message: '请求频率过高' } }, 400)).toMatchObject({ kind: 'rate_limit' });
    expect(classifyUpstreamError({}, 500)).toMatchObject({ kind: 'server' });
  });
});

describe('multi-interface model probing', () => {
  it('expands the testable interfaces from catalog declarations', () => {
    expect(modelInterfaces(discoveredModel())).toEqual(['openai']);
    expect(modelInterfaces(discoveredModel({ endpointTypes: ['anthropic', 'openai'] }))).toEqual(['openai', 'anthropic']);
    expect(modelInterfaces(discoveredModel({ endpointTypes: ['image-generation'] }))).toEqual(['openai']);
  });

  it('lists only declared generation interfaces for image, video and music probes', () => {
    expect(modelGenerationInterfaces(discoveredModel({ endpointTypes: ['image-generation', 'music', 'openai'] }))).toEqual(['image-generation', 'music']);
    expect(modelGenerationInterfaces(discoveredModel({ endpointTypes: ['doubao', 'jimeng'] }))).toEqual([]);
    expect(modelGenerationInterfaces(discoveredModel())).toEqual([]);
  });

  it('aggregates fake-name probe outcomes across interfaces', () => {
    expect(aggregateProbe([])).toBeUndefined();
    expect(aggregateProbe([{ accepted: true }])).toEqual({ accepted: true });
    expect(aggregateProbe([{ accepted: false, rejection: '网关判定该模型不存在或无可用渠道' }])).toEqual({ accepted: false, rejection: '网关判定该模型不存在或无可用渠道' });
    expect(aggregateProbe([{ accepted: false, rejection: '限流' }, { accepted: undefined }])).toEqual({ accepted: false, rejection: '限流' });
    expect(aggregateProbe([{ accepted: undefined }, { accepted: undefined }])).toBeUndefined();
  });

  it('records tested interfaces and the rejection reason in the name check', () => {
    const check = buildNameCheck('my-fake-model', [], { accepted: false, modelId: PROBE_FAKE_MODEL_ID, rejection: '网关判定该模型不存在或无可用渠道' }, new Date().toISOString(), { interfaces: ['openai', 'anthropic'] });
    expect(check).toMatchObject({
      interfaces: ['openai', 'anthropic'],
      probeRejection: '网关判定该模型不存在或无可用渠道',
      acceptsUnknownNames: false,
      probeModelId: PROBE_FAKE_MODEL_ID,
    });
  });

  it('carries the generation interface check through the name check', () => {
    const check = buildNameCheck('flux-pro', [], undefined, new Date().toISOString(), {
      interfaces: ['openai', 'image-generation'],
      generationCheck: {
        interfaces: ['image-generation'],
        nameServed: true,
        permissive: false,
        details: [{
          interface: 'image-generation',
          realAccepted: true,
          fakeAccepted: false,
          realShape: 'async-task',
          fakeShape: 'unknown',
          shapeConsistent: false,
        }],
      },
    });
    expect(check).toMatchObject({ interfaces: ['openai', 'image-generation'], generationCheck: { nameServed: true, permissive: false } });
    expect(check.generationCheck?.details[0]).toMatchObject({ realShape: 'async-task', fakeShape: 'unknown', shapeConsistent: false });
  });
});

describe('validation rejection interpretation', () => {
  it('explains a forced tool_choice rejection without declaring tools unsupported', () => {
    const result = interpretExplicitRejection('supportsTools', 'HTTP 400；服务端：当前模型或上游不支持指定工具的强制选择方式，请改用 tool_choice=auto');
    expect(result).toMatchObject({ value: 'unknown', confidence: 'medium' });
    expect(result.detail).toContain('tool_choice=auto');
  });

  it('distinguishes a prompt-word constraint from unsupported json mode', () => {
    const result = interpretExplicitRejection('supportsJsonMode', "HTTP 400；服务端：Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'.");
    expect(result).toMatchObject({ value: 'unknown', confidence: 'medium' });
    expect(result.detail).toContain('json');
  });

  it('treats an unavailable response_format as unsupported structured output', () => {
    const result = interpretExplicitRejection('supportsStructuredOutput', 'HTTP 400；服务端：This response_format type is unavailable now');
    expect(result).toMatchObject({ value: 'unsupported', confidence: 'medium' });
    expect(result.detail).toContain('结构化输出');
  });

  it('keeps the generic text for unrelated rejections', () => {
    const result = interpretExplicitRejection('supportsTemperature', 'HTTP 400；服务端：bad temperature');
    expect(result).toMatchObject({ value: 'unsupported', confidence: 'medium' });
    expect(result.detail).toBe('服务端明确拒绝参数：HTTP 400；服务端：bad temperature');
  });
});

describe('validation evidence merging', () => {
  it('drops the stale placeholder once validated evidence exists', () => {
    const previous = { value: 'unknown' as const, evidence: [{ source: 'unknown' as const, confidence: 'unknown' as const, detail: '尚未探测', timestamp: 't' }] };
    const merged = mergeValidationEvidence(previous, { value: 'supported', confidence: 'high', detail: 'observed' });
    expect(merged.evidence).toHaveLength(1);
    expect(merged.evidence[0]).toMatchObject({ source: 'validated', detail: 'observed' });
  });
});
