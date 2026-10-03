import type { AdapterRequest, CapabilityKey, ProbeGroup, ProbePlan, ProtocolAdapter } from '../domain/types';
import { normalizeModel, PROBE_FAKE_MODEL_ID, records, STOP_PROBE_PROMPT, STOP_PROBE_WORD, TOOLS_PROBE_NAME } from './shared';
import {
  contentText,
  conformsToOkSchema,
  evaluateSamplingGroup,
  evaluateStreamingGroup,
  evaluateStructuredGroup,
  evaluateToolsGroup,
  isExplicitRejection,
  isTruncated,
  type SamplingSlots,
  type StructuredSlots,
  type ToolsSlots,
} from './probe';

// 短小、必然产出、对温度敏感：temperature=0 倾向固定字，temperature=1 输出更发散，便于比较。
const DUAL_PROBE_PROMPT = '请随机回复 3 个不同汉字，用空格分隔';
const DUAL_PROBE_MAX_TOKENS = 256;

// 合并探测：同一个提示词同时承担“随机发散”（比较类参数）与“连续数数”（stop）两件事，
// 随机部分必须在前，这样即便 stop 把生成截断，采样比较仍有可比对的窗口。
// 提示词不得出现停止词与其后置词（玖、拾），否则推理模型复述提示词就会污染 stop 判定
const SAMPLING_PROMPT = '请先随机输出 3 个不同汉字，用空格分隔；然后另起一行，从壹开始按顺序连续输出中文数字（壹、贰、叁…），不要停顿，尽可能多输出';
const SAMPLING_MAX_TOKENS = 320;
// 结构化探测的 max_tokens 不能太小：实测思考模型（llama.cpp + Qwen3.6）在 256 时思考阶段就把预算吃光、
// 内容通道永远为空，512 起才稳定写出符合 schema 的内容；8~32 则连 json_object 都拿不到结果
const STRUCTURED_MAX_TOKENS = 512;
// 但思考长度本身在抖动（实测同一条请求 reasoningLen 764~2018），512 仍会被偶尔吃满；
// 因此被截断且内容通道为空时按 1536 重试一次，而不是直接退回 unknown
const STRUCTURED_RETRY_MAX_TOKENS = 1536;
const TOOLS_MAX_TOKENS = 256;

const TOOLS_PROBE_SCHEMA = {
  type: 'object',
  properties: { time_zone: { type: 'string' } },
  required: ['time_zone'],
};

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

  // 结构化输出：先发严格 schema；若服务端缺 xgrammar 等依赖返回 400，用 json_object 作回退探测。
  // max_tokens 必须留足思考空间：实测 32 会被思考阶段吃光，内容通道永远为空，判定必然塌成 unknown
  if (capability === 'supportsStructuredOutput') {
    return [
      { ...base, max_tokens: STRUCTURED_MAX_TOKENS, response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'probe', strict: true,
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        },
      } },
      { ...base, max_tokens: STRUCTURED_MAX_TOKENS, messages: [{ role: 'user', content: '返回 {"ok":true}' }], response_format: { type: 'json_object' } },
    ];
  }

  const extras: Partial<Record<CapabilityKey, Record<string, unknown>>> = {
    supportsTools: {
      tools: [{ type: 'function', function: { name: TOOLS_PROBE_NAME, description: 'Return the current time', parameters: { type: 'object', properties: { time_zone: { type: 'string' } }, required: ['time_zone'] } } }],
      tool_choice: { type: 'function', function: { name: TOOLS_PROBE_NAME } },
    },
    supportsJsonMode: { response_format: { type: 'json_object' }, messages: [{ role: 'user', content: '仅返回 {"ok":true}' }], max_tokens: STRUCTURED_MAX_TOKENS },
    supportsReasoning: { reasoning_effort: 'low' },
    // 停止词探测：提示词要求连续数数逼近停止词，提示词本身不含被检词，
    // 于是“输出跨过停止词”才是未生效的证据（合规实现会把停止词从输出里剔除）
    supportsStop: { messages: [{ role: 'user', content: STOP_PROBE_PROMPT }], max_tokens: 120, stop: [STOP_PROBE_WORD] },
    supportsStreaming: { stream: true },
  };
  if (capability === 'supportsPromptCache') return null;
  return { ...base, ...(extras[capability] ?? {}) };
}

// 合并探测的槽位名：temperature/top_p/seed/stop 四个槽位两两只差一个参数，
// repeat 与 highTemp 完全一致，用来区分“参数生效”与“端点本身非确定性”
export const CHAT_SAMPLING_SLOTS: Required<SamplingSlots> = {
  lowTemp: 'sampling_low_temp',
  highTemp: 'sampling_high_temp',
  repeat: 'sampling_repeat',
  lowTopP: 'sampling_low_top_p',
  control: 'sampling_control',
  onlyTemperature: 'sampling_only_temperature',
  onlyTopP: 'sampling_only_top_p',
  onlySeed: 'sampling_only_seed',
  onlyStop: 'sampling_only_stop',
};

export const CHAT_TOOLS_SLOTS: Required<ToolsSlots> = {
  tools: 'tools_forced',
  toolsAuto: 'tools_auto',
  reasoningOnly: 'reasoning_only',
};

export const CHAT_STRUCTURED_SLOTS: Required<StructuredSlots> = {
  strict: 'structured_strict',
  strictRetry: 'structured_strict_retry',
  jsonObject: 'structured_json_object',
};

const STREAMING_SLOT = 'streaming';

function chatPost(body: Record<string, unknown>): AdapterRequest {
  return { method: 'POST', path: '/chat/completions', body };
}

function strictSchemaRequest(modelId: string, maxTokens: number): AdapterRequest {
  return chatPost({
    model: modelId,
    messages: [{ role: 'user', content: '返回 ok=true' }],
    max_tokens: maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'probe',
        strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
      },
    },
  });
}

const jsonObjectRequest = (modelId: string) => chatPost({
  model: modelId,
  messages: [{ role: 'user', content: '仅返回 {"ok":true}' }],
  max_tokens: STRUCTURED_MAX_TOKENS,
  response_format: { type: 'json_object' },
});

// OpenAI 兼容 Chat 的合并探测计划：
// 采样组（4 次请求产出 temperature/top_p/seed/stop）+ 工具与推理（1 次）+ 结构化输出（1 次，必要时升级）
// + 流式（1 次），典型 7 次，取代原先逐能力的 13 次。
// 任何一次被 400/422 显式拒绝时按组升级：先用极简对照请求判断是不是模型整体不可用，
// 再用单参数请求把拒绝归因到具体参数，因此“合并”不会牺牲拒绝归因
export function chatProbePlan(modelId: string, capabilities: CapabilityKey[]): ProbePlan | null {
  const wanted = new Set(capabilities);
  const groups: ProbeGroup[] = [];

  const samplingKeys: CapabilityKey[] = ['supportsTemperature', 'supportsTopP', 'supportsSeed', 'supportsStop'];
  if (samplingKeys.some((key) => wanted.has(key))) {
    const sampling = (overrides: Record<string, unknown>) => chatPost({
      model: modelId,
      messages: [{ role: 'user', content: SAMPLING_PROMPT }],
      max_tokens: SAMPLING_MAX_TOKENS,
      ...overrides,
    });
    const withStop = (overrides: Record<string, unknown>) => sampling({ stop: [STOP_PROBE_WORD], ...overrides });
    const slots = CHAT_SAMPLING_SLOTS;
    groups.push({
      id: 'sampling',
      capabilities: samplingKeys,
      slots: [
        { name: slots.lowTemp, request: withStop({ temperature: 0, top_p: 0.01, seed: 1 }) },
        { name: slots.highTemp, request: withStop({ temperature: 1, top_p: 1, seed: 1 }) },
        { name: slots.repeat, request: withStop({ temperature: 1, top_p: 1, seed: 1 }) },
        { name: slots.lowTopP, request: withStop({ temperature: 1, top_p: 0.01, seed: 1 }) },
      ],
      escalate: (outcomes) => {
        const rejected = [slots.lowTemp, slots.highTemp, slots.repeat, slots.lowTopP]
          .some((name) => isExplicitRejection(outcomes[name]));
        if (!rejected) return [];
        return [
          { name: slots.control, request: chatPost({ model: modelId, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8 }) },
          { name: slots.onlyTemperature, request: sampling({ temperature: 1 }) },
          { name: slots.onlyTopP, request: sampling({ top_p: 0.01 }) },
          { name: slots.onlySeed, request: sampling({ seed: 1 }) },
          { name: slots.onlyStop, request: sampling({ stop: [STOP_PROBE_WORD] }) },
        ];
      },
      evaluate: (outcomes) => evaluateSamplingGroup(outcomes, slots),
    });
  }

  const toolKeys: CapabilityKey[] = ['supportsTools', 'supportsReasoning'];
  if (toolKeys.some((key) => wanted.has(key))) {
    const tools = [{
      type: 'function',
      function: { name: TOOLS_PROBE_NAME, description: 'Return the current time', parameters: TOOLS_PROBE_SCHEMA },
    }];
    // 提示词刻意不含工具名：输出里出现该函数名，只可能来自 tools 声明被真实转发
    const forced = chatPost({
      model: modelId,
      messages: [{ role: 'user', content: '回复 OK' }],
      max_tokens: TOOLS_MAX_TOKENS,
      tools,
      tool_choice: { type: 'function', function: { name: TOOLS_PROBE_NAME } },
      reasoning_effort: 'low',
    });
    groups.push({
      id: 'tools',
      capabilities: toolKeys,
      slots: [{ name: CHAT_TOOLS_SLOTS.tools, request: forced }],
      escalate: (outcomes) => (isExplicitRejection(outcomes[CHAT_TOOLS_SLOTS.tools]) ? [
        { name: CHAT_TOOLS_SLOTS.toolsAuto, request: chatPost({
          model: modelId,
          messages: [{ role: 'user', content: '回复 OK' }],
          max_tokens: TOOLS_MAX_TOKENS,
          tools,
          tool_choice: 'auto',
        }) },
        { name: CHAT_TOOLS_SLOTS.reasoningOnly, request: chatPost({
          model: modelId,
          messages: [{ role: 'user', content: '回复 OK' }],
          max_tokens: TOOLS_MAX_TOKENS,
          reasoning_effort: 'low',
        }) },
      ] : []),
      evaluate: (outcomes) => evaluateToolsGroup(outcomes, CHAT_TOOLS_SLOTS),
    });
  }

  const structuredKeys: CapabilityKey[] = ['supportsStructuredOutput', 'supportsJsonMode'];
  if (structuredKeys.some((key) => wanted.has(key))) {
    const slots = CHAT_STRUCTURED_SLOTS;
    groups.push({
      id: 'structured',
      capabilities: structuredKeys,
      slots: [{ name: slots.strict, request: strictSchemaRequest(modelId, STRUCTURED_MAX_TOKENS) }],
      // 升级按失败原因分叉：
      // - 被 max_tokens 截断且内容通道为空 → 实测是思考阶段吃光了预算，加预算重试同一条严格请求
      // - 接受参数但内容通道有文本却不符合 schema → 参数没被强制，改试 json_object 基础模式
      // - 显式拒绝 → 直接改试 json_object
      // 网络类失败不升级——那只会再浪费一次必然失败的请求
      escalate: (outcomes) => {
        const strict = outcomes[slots.strict];
        if (!strict || (strict.ok && conformsToOkSchema(contentText(strict.data)))) return [];
        if (!strict.ok) return isExplicitRejection(strict) ? [{ name: slots.jsonObject, request: jsonObjectRequest(modelId) }] : [];
        return isTruncated(strict) && !contentText(strict.data)
          ? [{ name: slots.strictRetry, request: strictSchemaRequest(modelId, STRUCTURED_RETRY_MAX_TOKENS) }]
          : [{ name: slots.jsonObject, request: jsonObjectRequest(modelId) }];
      },
      evaluate: (outcomes) => evaluateStructuredGroup(outcomes, slots),
    });
  }

  if (wanted.has('supportsStreaming')) {
    groups.push({
      id: 'streaming',
      capabilities: ['supportsStreaming'],
      slots: [{ name: STREAMING_SLOT, request: chatPost({ model: modelId, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8, stream: true }) }],
      evaluate: (outcomes) => evaluateStreamingGroup(outcomes[STREAMING_SLOT]),
    });
  }

  if (!groups.length) return null;
  return {
    groups,
    // 名称真实性探测用最小请求：旧实现复用 256 token 的采样请求，白白多花算力
    nameProbe: chatPost({ model: PROBE_FAKE_MODEL_ID, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8 }),
  };
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
  buildProbePlan: chatProbePlan,
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
  // Responses API 暂无合并方案：手上没有可验证的 Responses 端点，
  // 不引入无法实测的合并路径，继续走逐能力探测
  buildProbePlan: undefined,
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
