import type { AdapterRequest, CapabilityKey, ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records } from './shared';

function chatBody(modelId: string, capability: CapabilityKey): Record<string, unknown> {
  const body: Record<string, unknown> = { model: modelId, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8 };
  if (capability === 'supportsTools') {
    body.messages = [{ role: 'user', content: '调用 probe_noop' }];
    body.tools = [{ type: 'function', function: { name: 'probe_noop', description: 'Do not call external systems', parameters: { type: 'object', properties: {} } } }];
    body.tool_choice = 'REQUIRED';
  }
  if (capability === 'supportsJsonMode') {
    body.messages = [{ role: 'user', content: '仅返回 {"ok":true}' }];
    body.response_format = { type: 'json_object' };
  }
  if (capability === 'supportsStructuredOutput') {
    body.response_format = { type: 'json_object', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } };
  }
  if (capability === 'supportsTemperature') body.temperature = 0;
  if (capability === 'supportsTopP') body.p = 1;
  if (capability === 'supportsStop') body.stop_sequences = [DEFAULT_STOP_SEQUENCE];
  if (capability === 'supportsSeed') body.seed = 1;
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
  buildValidationRequest: (modelId, capability): AdapterRequest | null => {
    if (capability === 'supportsReasoning' || capability === 'supportsPromptCache') return null;
    return { method: 'POST', path: '/v2/chat', body: chatBody(modelId, capability) };
  },
};
