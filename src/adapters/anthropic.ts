import type { ProtocolAdapter } from '../domain/types';
import { normalizeModel, records, STOP_PROBE_PROMPT, STOP_PROBE_WORD, TOOLS_PROBE_NAME } from './shared';

// 短小、必然产出、对温度敏感：temperature=0 倾向固定字，temperature=1 输出更发散，便于比较。
const DUAL_PROBE_PROMPT = '请随机回复 3 个不同汉字，用空格分隔';
const DUAL_PROBE_MAX_TOKENS = 256;
const anthropicHeaders = { 'anthropic-version': '2023-06-01' };

export const anthropicAdapter: ProtocolAdapter = {
  id: 'anthropic',
  label: 'Anthropic Messages',
  discoveryRequests: () => [{ method: 'GET', path: '/models', headers: anthropicHeaders }],
  recognizes: (payload) => Boolean(payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)),
  parseModels: (payload) => {
    const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : [];
    return records(data).map((item) => ({ ...normalizeModel(item, 'anthropic', 'GET /models'), supportedEndpoints: ['/messages'] }));
  },
  buildValidationRequest: (modelId, capability) => {
    if (['supportsJsonMode', 'supportsStructuredOutput', 'supportsReasoning', 'supportsSeed', 'supportsPromptCache'].includes(capability)) return null;

    if (capability === 'supportsTemperature') {
      return [
        { method: 'POST', path: '/messages', headers: anthropicHeaders, body: { model: modelId, max_tokens: DUAL_PROBE_MAX_TOKENS, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], temperature: 0 } },
        { method: 'POST', path: '/messages', headers: anthropicHeaders, body: { model: modelId, max_tokens: DUAL_PROBE_MAX_TOKENS, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], temperature: 1 } },
      ];
    }
    if (capability === 'supportsTopP') {
      return [
        { method: 'POST', path: '/messages', headers: anthropicHeaders, body: { model: modelId, max_tokens: DUAL_PROBE_MAX_TOKENS, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], top_p: 1 } },
        { method: 'POST', path: '/messages', headers: anthropicHeaders, body: { model: modelId, max_tokens: DUAL_PROBE_MAX_TOKENS, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], top_p: 0.01 } },
      ];
    }

    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: 'user', content: '回复 OK' }] };
    if (capability === 'supportsTools') Object.assign(body, { tools: [{ name: TOOLS_PROBE_NAME, description: 'Return the current time', input_schema: { type: 'object', properties: { time_zone: { type: 'string' } }, required: ['time_zone'] } }], tool_choice: { type: 'tool', name: TOOLS_PROBE_NAME }, messages: [{ role: 'user', content: '调用 ' + TOOLS_PROBE_NAME + ' 获取当前时间' }] });
    if (capability === 'supportsStop') { body.messages = [{ role: 'user', content: STOP_PROBE_PROMPT }]; body.max_tokens = 120; body.stop_sequences = [STOP_PROBE_WORD]; }
    if (capability === 'supportsStreaming') body.stream = true;
    return { method: 'POST', path: '/messages', headers: anthropicHeaders, body };
  },
};
