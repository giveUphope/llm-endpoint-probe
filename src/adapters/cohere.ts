import type { AdapterRequest, CapabilityKey, ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records, STOP_PROBE_WORD, TOOLS_PROBE_NAME } from './shared';

// 短小、必然产出、对温度敏感：temperature=0 倾向固定字，temperature=1 输出更发散，便于比较。
const DUAL_PROBE_PROMPT = '请随机回复 3 个不同汉字，用空格分隔';
const DUAL_PROBE_MAX_TOKENS = 256;

function chatBodies(modelId: string, capability: CapabilityKey): Record<string, unknown> | Record<string, unknown>[] | null {
  if (capability === 'supportsReasoning' || capability === 'supportsPromptCache') return null;

  if (capability === 'supportsTemperature') {
    return [
      { model: modelId, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], max_tokens: DUAL_PROBE_MAX_TOKENS, temperature: 0 },
      { model: modelId, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], max_tokens: DUAL_PROBE_MAX_TOKENS, temperature: 1 },
    ];
  }
  if (capability === 'supportsTopP') {
    return [
      { model: modelId, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], max_tokens: DUAL_PROBE_MAX_TOKENS, p: 1 },
      { model: modelId, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], max_tokens: DUAL_PROBE_MAX_TOKENS, p: 0.01 },
    ];
  }
  if (capability === 'supportsSeed') {
    return [
      { model: modelId, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8, seed: 1 },
      { model: modelId, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8, seed: 1 },
    ];
  }

  const body: Record<string, unknown> = { model: modelId, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8 };
  if (capability === 'supportsTools') {
    body.messages = [{ role: 'user', content: '调用 ' + TOOLS_PROBE_NAME + ' 获取当前时间' }];
    body.tools = [{ type: 'function', function: { name: TOOLS_PROBE_NAME, description: 'Return the current time', parameters: { type: 'object', properties: { time_zone: { type: 'string' } }, required: ['time_zone'] } } }];
    body.tool_choice = 'REQUIRED';
  }
  if (capability === 'supportsJsonMode') {
    body.messages = [{ role: 'user', content: '仅返回 {"ok":true}' }];
    body.response_format = { type: 'json_object' };
  }
  if (capability === 'supportsStructuredOutput') {
    body.response_format = { type: 'json_object', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } };
  }
  if (capability === 'supportsStop') { body.messages = [{ role: 'user', content: '依次输出：一，二，三，四，五，六，七，八，九，十' }]; body.max_tokens = 120; body.stop_sequences = [STOP_PROBE_WORD]; }
  if (capability === 'supportsStreaming') body.stream = true;
  return body;
}

export const cohereAdapter: ProtocolAdapter = {
  id: 'cohere',
  label: 'Cohere v2 Chat',
  discoveryRequests: () => [{ method: 'GET', path: '/v1/models?page_size=1000' }],
  recognizes: (payload) => {
    const models = payload && typeof payload === 'object' ? (payload as { models?: unknown }).models : undefined;
    return records(models).some((item) => typeof item.name === 'string' && (Array.isArray(item.endpoints) || 'context_length' in item));
  },
  parseModels: (payload) => {
    const list = payload && typeof payload === 'object' ? (payload as { models?: unknown }).models : [];
    return records(list).map((item) => {
      const endpoints = Array.isArray(item.endpoints) ? item.endpoints.map(String) : [];
      return {
        ...normalizeModel({ ...item, id: item.name, display_name: item.name }, 'cohere', 'Cohere GET /v1/models'),
        supportedEndpoints: endpoints.map((endpoint) => `/v2/${endpoint}`),
      };
    });
  },
  buildValidationRequest: (modelId, capability): AdapterRequest | AdapterRequest[] | null => {
    const bodies = chatBodies(modelId, capability);
    if (!bodies) return null;
    if (Array.isArray(bodies)) return bodies.map((body) => ({ method: 'POST', path: '/v2/chat', body }));
    return { method: 'POST', path: '/v2/chat', body: bodies };
  },
};
