import type { ProtocolAdapter } from '../domain/types';
import { normalizeModel, records } from './shared';

export const ollamaAdapter: ProtocolAdapter = {
  id: 'ollama',
  label: 'Ollama',
  discoveryRequests: () => [{ method: 'GET', path: '/api/tags' }],
  recognizes: (payload) => Boolean(payload && typeof payload === 'object' && Array.isArray((payload as { models?: unknown }).models)),
  parseModels: (payload) => {
    const list = payload && typeof payload === 'object' ? (payload as { models?: unknown }).models : [];
    return records(list).map((item) => {
      const details = item.details && typeof item.details === 'object' ? item.details as Record<string, unknown> : {};
      const model = normalizeModel({ ...item, ...details }, 'ollama', 'GET /api/tags');
      model.supportedEndpoints = ['/api/chat', '/api/generate'];
      return model;
    });
  },
  buildValidationRequest: (modelId, capability) => {
    if (capability === 'supportsPromptCache' || capability === 'supportsStructuredOutput' || capability === 'supportsSeed') return null;
    const options: Record<string, unknown> = { num_predict: 4 };
    if (capability === 'supportsTemperature') options.temperature = 0;
    if (capability === 'supportsTopP') options.top_p = 1;
    if (capability === 'supportsStop') options.stop = ['NEVER_EMIT_THIS'];
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [{ role: 'user', content: capability === 'supportsJsonMode' ? '仅返回 {"ok":true}' : '回复 OK' }],
      stream: capability === 'supportsStreaming',
      options: { ...options, num_predict: 8 },
    };
    if (capability === 'supportsJsonMode') body.format = 'json';
    if (capability === 'supportsTools') body.tools = [{ type: 'function', function: { name: 'probe_noop', description: 'Do not call', parameters: { type: 'object', properties: {} } } }];
    return { method: 'POST', path: '/api/chat', body };
  },
};
