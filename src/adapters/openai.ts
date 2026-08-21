import type { AdapterRequest, CapabilityKey, ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records } from './shared';

const CREATIVE_PROMPT = '写一段简短的创意文字，包含一个隐喻';

function chatBodies(modelId: string, capability: CapabilityKey): Record<string, unknown> | Record<string, unknown>[] | null {
  const base: Record<string, unknown> = {
    model: modelId,
    messages: [{ role: 'user', content: '回复 OK' }],
    max_tokens: 8,
  };

  // 双探测：不同参数值发两次请求，比较输出差异
  if (capability === 'supportsTemperature') {
    return [
      { ...base, temperature: 0, messages: [{ role: 'user', content: CREATIVE_PROMPT }] },
      { ...base, temperature: 1, messages: [{ role: 'user', content: CREATIVE_PROMPT }] },
    ];
  }
  if (capability === 'supportsTopP') {
    return [
      { ...base, top_p: 1, messages: [{ role: 'user', content: CREATIVE_PROMPT }] },
      { ...base, top_p: 0.01, messages: [{ role: 'user', content: CREATIVE_PROMPT }] },
    ];
  }
  if (capability === 'supportsSeed') {
    return [
      { ...base, seed: 1, max_tokens: 16 },
      { ...base, seed: 1, max_tokens: 16 },
    ];
  }

  const extras: Partial<Record<CapabilityKey, Record<string, unknown>>> = {
    supportsTools: {
      tools: [{ type: 'function', function: { name: 'probe_noop', description: 'Do not call', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'probe_noop' } },
    },
    supportsJsonMode: { response_format: { type: 'json_object' }, messages: [{ role: 'user', content: '仅返回 {"ok":true}' }] },
    supportsStructuredOutput: {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'probe',
          strict: true,
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        },
      },
    },
    supportsReasoning: { reasoning_effort: 'low' },
    supportsStop: { stop: [DEFAULT_STOP_SEQUENCE] },
    supportsStreaming: { stream: true },
  };
  if (capability === 'supportsPromptCache') return null;
  return { ...base, ...(extras[capability] ?? {}) };
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
  buildValidationRequest: (modelId, capability): AdapterRequest | AdapterRequest[] | null => {
    if (capability === 'supportsPromptCache') return null;
    const bodies = chatBodies(modelId, capability);
    if (!bodies) return null;
    if (Array.isArray(bodies)) return bodies.map((body) => ({ method: 'POST', path: '/chat/completions', body }));
    return { method: 'POST', path: '/chat/completions', body: bodies };
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
  buildValidationRequest: (modelId, capability): AdapterRequest | AdapterRequest[] | null => {
    if (capability === 'supportsPromptCache' || capability === 'supportsStop' || capability === 'supportsSeed') return null;

    if (capability === 'supportsTemperature') {
      return [
        { method: 'POST', path: '/responses', body: { model: modelId, input: CREATIVE_PROMPT, max_output_tokens: 32, temperature: 0 } },
        { method: 'POST', path: '/responses', body: { model: modelId, input: CREATIVE_PROMPT, max_output_tokens: 32, temperature: 1 } },
      ];
    }
    if (capability === 'supportsTopP') {
      return [
        { method: 'POST', path: '/responses', body: { model: modelId, input: CREATIVE_PROMPT, max_output_tokens: 32, top_p: 1 } },
        { method: 'POST', path: '/responses', body: { model: modelId, input: CREATIVE_PROMPT, max_output_tokens: 32, top_p: 0.01 } },
      ];
    }

    const body: Record<string, unknown> = { model: modelId, input: '回复 OK', max_output_tokens: 8 };
    if (capability === 'supportsTools') Object.assign(body, { tools: [{ type: 'function', name: 'probe_noop', description: 'Do not call', parameters: { type: 'object', properties: {} } }], tool_choice: 'required', input: '调用 probe_noop' });
    if (capability === 'supportsJsonMode') Object.assign(body, { text: { format: { type: 'json_object' } }, input: '仅返回 {"ok":true}' });
    if (capability === 'supportsStructuredOutput') Object.assign(body, { text: { format: { type: 'json_schema', name: 'probe', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }, input: '返回 ok=true' });
    if (capability === 'supportsReasoning') body.reasoning = { effort: 'low' };
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
