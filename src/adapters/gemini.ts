import { evidence, modelConfidence } from '../domain/capabilities';
import type { AdapterRequest, CapabilityKey, ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records } from './shared';

const CREATIVE_PROMPT = '写一段简短的创意文字，包含一个隐喻';

function generationBodies(capability: CapabilityKey): Record<string, unknown> | Record<string, unknown>[] | null {
  const creativeContent = { contents: [{ role: 'user', parts: [{ text: CREATIVE_PROMPT }] }] };
  const defaultContent = { contents: [{ role: 'user', parts: [{ text: '回复 OK' }] }] };

  if (capability === 'supportsTemperature') {
    return [
      { ...defaultContent, generationConfig: { maxOutputTokens: 32, temperature: 0 } },
      { ...creativeContent, generationConfig: { maxOutputTokens: 32, temperature: 1 } },
    ];
  }
  if (capability === 'supportsTopP') {
    return [
      { ...defaultContent, generationConfig: { maxOutputTokens: 32, topP: 1 } },
      { ...creativeContent, generationConfig: { maxOutputTokens: 32, topP: 0.01 } },
    ];
  }
  if (capability === 'supportsSeed') {
    return [
      { ...defaultContent, generationConfig: { maxOutputTokens: 8, seed: 1 } },
      { ...defaultContent, generationConfig: { maxOutputTokens: 8, seed: 1 } },
    ];
  }
  if (capability === 'supportsPromptCache' || capability === 'supportsStructuredOutput') return null;

  const generationConfig: Record<string, unknown> = { maxOutputTokens: 8 };
  const body: Record<string, unknown> = {
    ...defaultContent,
    generationConfig,
  };
  if (capability === 'supportsTools') {
    body.contents = [{ role: 'user', parts: [{ text: '调用 probe_noop' }] }];
    body.tools = [{ functionDeclarations: [{ name: 'probe_noop', description: 'Do not call', parameters: { type: 'OBJECT', properties: {} } }] }];
    body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['probe_noop'] } };
  }
  if (capability === 'supportsJsonMode') {
    body.contents = [{ role: 'user', parts: [{ text: '仅返回 {"ok":true}' }] }];
    generationConfig.responseMimeType = 'application/json';
  }
  if (capability === 'supportsReasoning') generationConfig.thinkingConfig = { thinkingBudget: 128 };
  if (capability === 'supportsStop') generationConfig.stopSequences = [DEFAULT_STOP_SEQUENCE];
  return body;
}

function buildStreamValidation(modelId: string): AdapterRequest {
  return { method: 'POST', path: `/models/${modelId}:streamGenerateContent?alt=sse`, body: { contents: [{ role: 'user', parts: [{ text: '回复 OK' }] }], generationConfig: { maxOutputTokens: 8 } } };
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
        supported_parameters: Array.isArray(item.supported_parameters)
          ? [...new Set([...item.supported_parameters, ...(item.thinking ? ['reasoning'] : [])])]
          : (item.temperature != null || item.topP != null)
            ? [...new Set([item.temperature != null ? 'temperature' : null, item.topP != null ? 'top_p' : null, ...(item.thinking ? ['reasoning'] : [])].filter(Boolean))]
            : [],
        reasoning: item.thinking ? { supported_efforts: ['low', 'high'] } : undefined,
      }, 'gemini', 'GET /models');
      const base: string[] = [];
      if (methods.includes('generateContent')) base.push(`/models/${rawName.replace(/^models\//, '')}:generateContent`);
      if (methods.includes('streamGenerateContent')) base.push(`/models/${rawName.replace(/^models\//, '')}:streamGenerateContent`);
      return { ...model, supportedEndpoints: base };
    });
  },
  buildValidationRequest: (modelId, capability): AdapterRequest | AdapterRequest[] | null => {
    if (capability === 'supportsStreaming') return buildStreamValidation(modelId);
    const bodies = generationBodies(capability);
    if (!bodies) return null;
    if (Array.isArray(bodies)) return bodies.map((body) => ({ method: 'POST', path: `/models/${modelId}:generateContent`, body }));
    return { method: 'POST', path: `/models/${modelId}:generateContent`, body: bodies };
  },
};
