import type { AdapterRequest, CapabilityKey, ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records, STOP_PROBE_WORD, STOP_PROBE_POST, TOOLS_PROBE_NAME } from './shared';

// 短小、必然产出、对温度敏感：temperature=0 倾向固定字，temperature=1 输出更发散，便于比较。
const DUAL_PROBE_PROMPT = '请随机回复 3 个不同汉字，用空格分隔';
const DUAL_PROBE_MAX_TOKENS = 256;

function chatBodies(modelId: string, capability: CapabilityKey): Record<string, unknown> | Record<string, unknown>[] | null {
  const base: Record<string, unknown> = {
    model: modelId,
    messages: [{ role: 'user', content: '回复 OK' }],
    max_tokens: 8,
  };

  // 双探测：不同参数值发两次请求，比较输出差异
  if (capability === 'supportsTemperature') {
    return [
      { ...base, max_tokens: DUAL_PROBE_MAX_TOKENS, temperature: 0, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }] },
      { ...base, max_tokens: DUAL_PROBE_MAX_TOKENS, temperature: 1, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }] },
    ];
  }
  if (capability === 'supportsTopP') {
    return [
      { ...base, max_tokens: DUAL_PROBE_MAX_TOKENS, top_p: 1, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }] },
      { ...base, max_tokens: DUAL_PROBE_MAX_TOKENS, top_p: 0.01, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }] },
    ];
  }
  if (capability === 'supportsSeed') {
    return [
      { ...base, max_tokens: DUAL_PROBE_MAX_TOKENS, seed: 1 },
      { ...base, max_tokens: DUAL_PROBE_MAX_TOKENS, seed: 1 },
    ];
  }

  // 结构化输出：先发严格 schema；若服务端缺 xgrammar 等依赖返回 400，用 json_object 作回退探测
  if (capability === 'supportsStructuredOutput') {
    return [
      { ...base, max_tokens: 32, response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'probe', strict: true,
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        },
      } },
      { ...base, max_tokens: 32, messages: [{ role: 'user', content: '返回 {"ok":true}' }], response_format: { type: 'json_object' } },
    ];
  }

  const extras: Partial<Record<CapabilityKey, Record<string, unknown>>> = {
    supportsTools: {
      tools: [{ type: 'function', function: { name: TOOLS_PROBE_NAME, description: 'Return the current time', parameters: { type: 'object', properties: { time_zone: { type: 'string' } }, required: ['time_zone'] } } }],
      tool_choice: { type: 'function', function: { name: TOOLS_PROBE_NAME } },
    },
    supportsJsonMode: { response_format: { type: 'json_object' }, messages: [{ role: 'user', content: '仅返回 {"ok":true}' }] },
    supportsReasoning: { reasoning_effort: 'low' },
    // 停止词探测：提示词会自然输出停止词，再判断输出是否在其后继续——
    // 出现停止词但未出现后置标记 → 生效；出现后置标记 → 未生效；连停止词都未到 → 无法确认
    supportsStop: { messages: [{ role: 'user', content: '依次输出：一，二，三，四，五，六，七，八，九，十' }], max_tokens: 120, stop: [STOP_PROBE_WORD] },
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
        { method: 'POST', path: '/responses', body: { model: modelId, input: DUAL_PROBE_PROMPT, max_output_tokens: DUAL_PROBE_MAX_TOKENS, temperature: 0 } },
        { method: 'POST', path: '/responses', body: { model: modelId, input: DUAL_PROBE_PROMPT, max_output_tokens: DUAL_PROBE_MAX_TOKENS, temperature: 1 } },
      ];
    }
    if (capability === 'supportsTopP') {
      return [
        { method: 'POST', path: '/responses', body: { model: modelId, input: DUAL_PROBE_PROMPT, max_output_tokens: DUAL_PROBE_MAX_TOKENS, top_p: 1 } },
        { method: 'POST', path: '/responses', body: { model: modelId, input: DUAL_PROBE_PROMPT, max_output_tokens: DUAL_PROBE_MAX_TOKENS, top_p: 0.01 } },
      ];
    }

    const baseBody: Record<string, unknown> = { model: modelId, input: '回复 OK', max_output_tokens: 8 };
    const toolParams: Record<string, unknown> = { type: 'object', properties: { time_zone: { type: 'string' } }, required: ['time_zone'] };
    const schemaBody: Record<string, unknown> = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    if (capability === 'supportsTools') {
      const body = { ...baseBody, input: '调用 ' + TOOLS_PROBE_NAME + ' 获取当前时间',
        tools: [{ type: 'function', name: TOOLS_PROBE_NAME, description: 'Return the current time', parameters: toolParams }],
        tool_choice: 'required' };
      return { method: 'POST', path: '/responses', body };
    }
    if (capability === 'supportsJsonMode') {
      const body = { ...baseBody, input: '仅返回 {"ok":true}', text: { format: { type: 'json_object' } } };
      return { method: 'POST', path: '/responses', body };
    }
    if (capability === 'supportsStructuredOutput') {
      const strictBody = { ...baseBody, max_output_tokens: 32, input: '返回 ok=true',
        text: { format: { type: 'json_schema', name: 'probe', strict: true, schema: schemaBody } } };
      const fallbackBody = { ...baseBody, max_output_tokens: 32, input: '返回 {"ok":true}',
        text: { format: { type: 'json_object' } } };
      return [
        { method: 'POST', path: '/responses', body: strictBody },
        { method: 'POST', path: '/responses', body: fallbackBody },
      ];
    }
    if (capability === 'supportsReasoning') {
      const body = { ...baseBody, reasoning: { effort: 'low' } };
      return { method: 'POST', path: '/responses', body };
    }
    if (capability === 'supportsStreaming') {
      const body = { ...baseBody, stream: true };
      return { method: 'POST', path: '/responses', body };
    }
    return { method: 'POST', path: '/responses', body: baseBody };
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
