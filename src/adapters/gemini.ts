import { evidence, modelConfidence } from '../domain/capabilities';
import type { AdapterRequest, CapabilityKey, ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records } from './shared';

function generationBody(capability: CapabilityKey): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { maxOutputTokens: 8 };
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: '回复 OK' }] }],
    generationConfig,
  };
  if (capability === 'supportsTools') {
    body.contents = [{ role: 'user', parts: [{ text: '调用 probe_noop' }] }];
    body.tools = [{ functionDeclarations: [{ name: 'probe_noop', description: 'Do not call external systems', parameters: { type: 'OBJECT', properties: {} } }] }];
    body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['probe_noop'] } };
  }
  if (capability === 'supportsJsonMode') {
    body.contents = [{ role: 'user', parts: [{ text: '仅返回 {"ok":true}' }] }];
    generationConfig.responseMimeType = 'application/json';
  }
  if (capability === 'supportsStructuredOutput') {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] };
  }
  if (capability === 'supportsReasoning') generationConfig.thinkingConfig = { thinkingBudget: 128 };
  if (capability === 'supportsTemperature') generationConfig.temperature = 0;
  if (capability === 'supportsTopP') generationConfig.topP = 1;
  if (capability === 'supportsStop') generationConfig.stopSequences = [DEFAULT_STOP_SEQUENCE];
  if (capability === 'supportsSeed') generationConfig.seed = 1;
  return body;
}

export const geminiAdapter: ProtocolAdapter = {
  id: 'gemini',
  label: 'Google Gemini',
  discoveryRequests: () => [{ method: 'GET', path: '/models?pageSize=1000' }],
  recognizes: (payload) => {
    const models = payload && typeof payload === 'object' ? (payload as { models?: unknown }).models : undefined;
    return records(models).some((item) => typeof item.name === 'string' && item.name.startsWith('models/') && ('supportedGenerationMethods' in item || 'inputTokenLimit' in item));
  },
  parseModels: (payload) => {
    const list = payload && typeof payload === 'object' ? (payload as { models?: unknown }).models : [];
    return records(list).map((item) => {
      const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods.map(String) : [];
      const rawName = String(item.name ?? 'unknown-model');
      const model = normalizeModel({
        ...item,
        id: rawName.replace(/^models\//, ''),
        display_name: item.displayName,
        context_window: item.inputTokenLimit,
        max_output_tokens: item.outputTokenLimit,
      }, 'gemini', 'Gemini GET /models');
      model.supportedEndpoints = methods.map((method) => `/models/{model}:${method}`);
      if (item.thinking === true) {
        model.capabilities.supportsReasoning = { value: 'supported', evidence: [evidence('endpoint', 'high', 'Gemini 模型元数据 thinking=true')] };
      }
      for (const [key, field] of [['supportsTemperature', 'temperature'], ['supportsTopP', 'topP']] as const) {
        if (typeof item[field] === 'number') model.capabilities[key] = { value: 'supported', evidence: [evidence('endpoint', 'medium', `Gemini 模型元数据包含 ${field}`)] };
      }
      model.confidence = modelConfidence(model);
      return model;
    });
  },
  buildValidationRequest: (modelId, capability): AdapterRequest | null => {
    if (capability === 'supportsPromptCache') return null;
    const method = capability === 'supportsStreaming' ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return { method: 'POST', path: `/models/${modelId}:${method}`, body: generationBody(capability) };
  },
};
