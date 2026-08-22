import type { ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records, STOP_PROBE_WORD, TOOLS_PROBE_NAME } from './shared';

// 短小、必然产出、对温度敏感：temperature=0 倾向固定字，temperature=1 输出更发散，便于比较。
const DUAL_PROBE_PROMPT = '请随机回复 3 个不同汉字，用空格分隔';
const DUAL_PROBE_MAX_TOKENS = 256;

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
        { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], options: { temperature: 0, num_predict: DUAL_PROBE_MAX_TOKENS } } },
        { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], options: { temperature: 1, num_predict: DUAL_PROBE_MAX_TOKENS } } },
      ];
    }

    // 双探测：不同 top_p 值 → 输出不同则参数生效
    if (capability === 'supportsTopP') {
      return [
        { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], options: { top_p: 1, num_predict: DUAL_PROBE_MAX_TOKENS } } },
        { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: DUAL_PROBE_PROMPT }], options: { top_p: 0.01, num_predict: DUAL_PROBE_MAX_TOKENS } } },
      ];
    }

    if (capability === 'supportsStop') {
      return { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: '依次输出：一，二，三，四，五，六，七，八，九，十' }], options: { num_predict: 120, stop: [STOP_PROBE_WORD] } } };
    }

    if (capability === 'supportsJsonMode') {
      return { method: 'POST', path: '/api/chat', body: { ...base, messages: [{ role: 'user', content: '仅返回 {"ok":true}' }], format: 'json' } };
    }

    // 工具能力：Ollama 不支持 tool_choice=required（部分模型会死循环），
    // 改用 tool_choice=auto 配合引导 prompt，模型会自动决定是否调用
    if (capability === 'supportsTools') {
      return { method: 'POST', path: '/api/chat', body: {
        ...base,
        messages: [{ role: 'user', content: '用 ' + TOOLS_PROBE_NAME + ' 工具获取当前时间' }],
        tools: [{ type: 'function', function: { name: TOOLS_PROBE_NAME, description: 'Return the current time', parameters: { type: 'object', properties: { time_zone: { type: 'string' } }, required: ['time_zone'] } } }],
        tool_choice: 'auto',
      } };
    }

    return { method: 'POST', path: '/api/chat', body: base };
  },
};
