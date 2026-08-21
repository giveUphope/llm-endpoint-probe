import type { AdapterRequest, CapabilityKey, ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records } from './shared';

const CREATIVE_PROMPT = '写一段简短的创意文字，包含一个隐喻';

function chatBodies(modelId: string, capability: CapabilityKey): Record<string, unknown> | Record<string, unknown>[] | null {
  if (capability === 'supportsReasoning' || capability === 'supportsPromptCache') return null;

  if (capability === 'supportsTemperature') {
    return [
      { model: modelId, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8, temperature: 0 },
      { model: modelId, messages: [{ role: 'user', content: CREATIVE_PROMPT }], max_tokens: 32, temperature: 1 },
    ];
  }
  if (capability === 'supportsTopP') {
    return [
      { model: modelId, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8, p: 1 },
      { model: modelId, messages: [{ role: 'user', content: CREATIVE_PROMPT }], max_tokens: 32, p: 0.01 },
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
    body.messages = [{ role: 'user', content: '调用 probe_noop' }];
    body.tools = [{ type: 'function', function: { name: 'probe_noop', description: 'Do not call', parameters: { type: 'object', properties: {} } } }];
    body.tool_choice = 'REQUIRED';
  }
  if (capability === 'supportsJsonMode') {
    body.messages = [{ role: 'user', content: '仅返回 {"ok":true}' }];
    body.response_format = { type: 'json_object' };
  }
  if (capability === 'supportsStructuredOutput') {
    body.response_format = { type: 'json_object', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } };
  }
  if (capability === 'supportsStop') body.stop_sequences = [DEFAULT_STOP_SEQUENCE];
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
