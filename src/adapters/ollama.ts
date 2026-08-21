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

    const base: Record<string, unknown> = {
      model: modelId,
      messages: [{ role: 'user', content: '回复 OK' }],
      stream: false,
      options: { num_predict: 8 },
    };

    if (capability === 'supportsStreaming') {
      return { method: 'POST', path: '/api/chat', body: { ...base, stream: true, options: { num_predict: 8 } } };
    }

    // 双探测：不同温度值 → 输出不同则参数生效
    if (capability === 'supportsTemperature') {
      return [
        { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: CREATIVE_PROMPT }], options: { temperature: 0, num_predict: 8 } } },
        { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: CREATIVE_PROMPT }], options: { temperature: 1, num_predict: 8 } } },
      ];
    }

    // 双探测：不同 top_p 值 → 输出不同则参数生效
    if (capability === 'supportsTopP') {
      return [
        { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: CREATIVE_PROMPT }], options: { top_p: 1, num_predict: 8 } } },
        { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: CREATIVE_PROMPT }], options: { top_p: 0.01, num_predict: 8 } } },
      ];
    }

    if (capability === 'supportsStop') {
      return { method: 'POST', path: '/api/chat', body: { ...base, options: { num_predict: 8, stop: [DEFAULT_STOP_SEQUENCE] } } };
    }

    if (capability === 'supportsJsonMode') {
      return { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: '仅返回 {"ok":true}' }], format: 'json' } };
    }

    // 工具能力：Ollama 不支持 tool_choice=required（部分模型会死循环），
    // 改用 tool_choice=auto 配合引导 prompt，模型会自动决定是否调用
    if (capability === 'supportsTools') {
      return { method: 'POST', path: '/api/chat', body: {
        ...base,
        messages: [{ role: 'user', content: '用 probe_noop 工具回答' }],
        tools: [{ type: 'function', function: { name: 'probe_noop', description: 'A probe tool', parameters: { type: 'object', properties: {} } } }],
        tool_choice: 'auto',
      } };
    }

    return { method: 'POST', path: '/api/chat', body: base };
  },
};
