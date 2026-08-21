import type { ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records } from './shared';

const CREATIVE_PROMPT = '写一段简短的创意文字，包含一个隐喻';

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
    if (capability === 'supportsPromptCache' || capability === 'supportsStructuredOutput' || capability === 'supportsSeed' || capability === 'supportsReasoning') return null;
    if (capability === 'supportsStreaming') return { method: 'POST', path: '/api/chat', body: { model: modelId, messages: [{ role: 'user', content: '回复 OK' }], stream: true, options: { num_predict: 8 } } };
    if (capability === 'supportsTemperature') {
      return [
        { method: 'POST', path: '/api/chat', body: { model: modelId, messages: [{ role: 'user', content: '回复 OK' }], options: { temperature: 0, num_predict: 8 } } },
        { method: 'POST', path: '/api/chat', body: { model: modelId, messages: [{ role: 'user', content: CREATIVE_PROMPT }], options: { temperature: 1, num_predict: 32 } } },
      ];
    }
    if (capability === 'supportsTopP') {
      return [
        { method: 'POST', path: '/api/chat', body: { model: modelId, messages: [{ role: 'user', content: '回复 OK' }], options: { top_p: 1, num_predict: 8 } } },
        { method: 'POST', path: '/api/chat', body: { model: modelId, messages: [{ role: 'user', content: CREATIVE_PROMPT }], options: { top_p: 0.01, num_predict: 32 } } },
      ];
    }
    const options: Record<string, unknown> = { num_predict: 4 };
    if (capability === 'supportsStop') options.stop = [DEFAULT_STOP_SEQUENCE];
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [{ role: 'user', content: capability === 'supportsJsonMode' ? '仅返回 {"ok":true}' : '回复 OK' }],
      stream: false,
      options: { ...options, num_predict: 8 },
    };
    if (capability === 'supportsJsonMode') body.format = 'json';
    if (capability === 'supportsTools') {
      body.tools = [{ type: 'function', function: { name: 'probe_noop', description: 'Do not call', parameters: { type: 'object', properties: {} } } }];
      body.tool_choice = 'required';
    }
    return { method: 'POST', path: '/api/chat', body };
  },
};
