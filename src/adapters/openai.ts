import type { AdapterRequest, CapabilityKey, ProtocolAdapter } from '../domain/types';
import { normalizeModel, records } from './shared';

function chatBody(modelId: string, capability: CapabilityKey): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: [{ role: 'user', content: '回复 OK' }],
    max_tokens: 8,
  };
  const extras: Partial<Record<CapabilityKey, Record<string, unknown>>> = {
    supportsTools: {
      tools: [{ type: 'function', function: { name: 'probe_noop', description: 'Do not call', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'probe_noop' } },
    },
    supportsJsonMode: { response_format: { type: 'json_object' }, messages: [{ role: 'user', content: '仅返回 {"ok":true}' }] },
    supportsStructuredOutput: { response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } } },
    supportsReasoning: { reasoning_effort: 'low' },
    supportsTemperature: { temperature: 0 },
    supportsTopP: { top_p: 1 },
    supportsStop: { stop: ['NEVER_EMIT_THIS'] },
    supportsSeed: { seed: 1 },
    supportsStreaming: { stream: true },
  };
  return { ...body, ...(extras[capability] ?? {}) };
}

export const openAIAdapter: ProtocolAdapter = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  discoveryRequests: () => [{ method: 'GET', path: '/models' }],
  recognizes: (payload) => Boolean(payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)),
  parseModels: (payload) => {
    const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : [];
    return records(data).map((item) => {
      const model = normalizeModel(item, 'openai-compatible', 'GET /models');
      model.supportedEndpoints = ['/chat/completions', '/responses'];
      return model;
    });
  },
  buildValidationRequest: (modelId, capability): AdapterRequest | null => {
    if (capability === 'supportsPromptCache') return null;
    return { method: 'POST', path: '/chat/completions', body: chatBody(modelId, capability) };
  },
};

export const openAIChatAdapter: ProtocolAdapter = {
  ...openAIAdapter,
  id: 'openai-chat',
  label: 'OpenAI Chat Completions',
  parseModels: (payload) => openAIAdapter.parseModels(payload).map((model) => ({ ...model, protocol: 'openai-chat', supportedEndpoints: ['/chat/completions'] })),
};

export const openAIResponsesAdapter: ProtocolAdapter = {
  ...openAIAdapter,
  id: 'openai-responses',
  label: 'OpenAI Responses',
  parseModels: (payload) => openAIAdapter.parseModels(payload).map((model) => ({ ...model, protocol: 'openai-responses', supportedEndpoints: ['/responses'] })),
  buildValidationRequest: (modelId, capability): AdapterRequest | null => {
    if (capability === 'supportsPromptCache' || capability === 'supportsStop') return null;
    const body: Record<string, unknown> = { model: modelId, input: '回复 OK', max_output_tokens: 8 };
    if (capability === 'supportsTools') Object.assign(body, { tools: [{ type: 'function', name: 'probe_noop', description: 'Do not call', parameters: { type: 'object', properties: {} } }], tool_choice: 'required', input: '调用 probe_noop' });
    if (capability === 'supportsJsonMode') Object.assign(body, { text: { format: { type: 'json_object' } }, input: '仅返回 {"ok":true}' });
    if (capability === 'supportsStructuredOutput') Object.assign(body, { text: { format: { type: 'json_schema', name: 'probe', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }, input: '返回 ok=true' });
    if (capability === 'supportsReasoning') body.reasoning = { effort: 'low' };
    if (capability === 'supportsTemperature') body.temperature = 0;
    if (capability === 'supportsTopP') body.top_p = 1;
    if (capability === 'supportsSeed') body.seed = 1;
    if (capability === 'supportsStreaming') body.stream = true;
    return { method: 'POST', path: '/responses', body };
  },
};

export const simpleArrayAdapter: ProtocolAdapter = {
  id: 'manual',
  label: '通用数组',
  discoveryRequests: () => [{ method: 'GET', path: '/models' }],
  recognizes: (payload) => Array.isArray(payload),
  parseModels: (payload) => records(payload).map((item) => normalizeModel(item, 'manual', 'GET /models（数组）')),
  buildValidationRequest: () => null,
};
