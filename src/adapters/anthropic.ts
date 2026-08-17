import type { ProtocolAdapter } from '../domain/types';
import { normalizeModel, records } from './shared';

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
    const body: Record<string, unknown> = { model: modelId, max_tokens: 8, messages: [{ role: 'user', content: '回复 OK' }] };
    if (capability === 'supportsTools') Object.assign(body, { tools: [{ name: 'probe_noop', description: 'Do not call', input_schema: { type: 'object', properties: {} } }], tool_choice: { type: 'tool', name: 'probe_noop' }, messages: [{ role: 'user', content: '调用 probe_noop' }] });
    if (capability === 'supportsTemperature') body.temperature = 0;
    if (capability === 'supportsTopP') body.top_p = 1;
    if (capability === 'supportsStop') body.stop_sequences = ['NEVER_EMIT_THIS'];
    if (capability === 'supportsStreaming') body.stream = true;
    return { method: 'POST', path: '/messages', headers: anthropicHeaders, body };
  },
};
