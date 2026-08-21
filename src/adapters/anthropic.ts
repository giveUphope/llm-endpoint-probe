import type { ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records } from './shared';

const CREATIVE_PROMPT = '写一段简短的创意文字，包含一个隐喻';
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
        { method: 'POST', path: '/messages', headers: anthropicHeaders, body: { model: modelId, max_tokens: 8, messages: [{ role: 'user', content: '回复 OK' }], temperature: 0 } },
        { method: 'POST', path: '/messages', headers: anthropicHeaders, body: { model: modelId, max_tokens: 32, messages: [{ role: 'user', content: CREATIVE_PROMPT }], temperature: 1 } },
      ];
    }
    if (capability === 'supportsTopP') {
      return [
        { method: 'POST', path: '/messages', headers: anthropicHeaders, body: { model: modelId, max_tokens: 8, messages: [{ role: 'user', content: '回复 OK' }], top_p: 1 } },
        { method: 'POST', path: '/messages', headers: anthropicHeaders, body: { model: modelId, max_tokens: 32, messages: [{ role: 'user', content: CREATIVE_PROMPT }], top_p: 0.01 } },
      ];
    }

    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: 'user', content: '回复 OK' }] };
    if (capability === 'supportsTools') Object.assign(body, { tools: [{ name: 'probe_noop', description: 'Do not call', input_schema: { type: 'object', properties: {} } }], tool_choice: { type: 'tool', name: 'probe_noop' }, messages: [{ role: 'user', content: '调用 probe_noop' }] });
    if (capability === 'supportsStop') body.stop_sequences = [DEFAULT_STOP_SEQUENCE];
    if (capability === 'supportsStreaming') body.stream = true;
    return { method: 'POST', path: '/messages', headers: anthropicHeaders, body };
  },
};
