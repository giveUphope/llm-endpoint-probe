import { evidence, modelConfidence } from '../domain/capabilities';
import type { AdapterRequest, CapabilityKey, ProtocolAdapter } from '../domain/types';
import { DEFAULT_STOP_SEQUENCE, normalizeModel, records, STOP_PROBE_WORD, TOOLS_PROBE_NAME } from './shared';

// 短小、必然产出、对温度敏感：temperature=0 倾向固定字，temperature=1 输出更发散，便于比较。
const DUAL_PROBE_PROMPT = '请随机回复 3 个不同汉字，用空格分隔';
const DUAL_PROBE_MAX_TOKENS = 256;

function generationBodies(capability: CapabilityKey): Record<string, unknown> | Record<string, unknown>[] | null {
  const dualProbeContent = { contents: [{ role: 'user', parts: [{ text: DUAL_PROBE_PROMPT }] }] };
  const defaultContent = { contents: [{ role: 'user', parts: [{ text: '回复 OK' }] }] };

  if (capability === 'supportsTemperature') {
    return [
      { ...dualProbeContent, generationConfig: { maxOutputTokens: DUAL_PROBE_MAX_TOKENS, temperature: 0 } },
      { ...dualProbeContent, generationConfig: { maxOutputTokens: DUAL_PROBE_MAX_TOKENS, temperature: 1 } },
    ];
  }
  if (capability === 'supportsTopP') {
    return [
      { ...dualProbeContent, generationConfig: { maxOutputTokens: DUAL_PROBE_MAX_TOKENS, topP: 1 } },
      { ...dualProbeContent, generationConfig: { maxOutputTokens: DUAL_PROBE_MAX_TOKENS, topP: 0.01 } },
    ];
  }
  if (capability === 'supportsSeed') {
    return [
      { ...defaultContent, generationConfig: { maxOutputTokens: 16, seed: 1 } },
      { ...defaultContent, generationConfig: { maxOutputTokens: 16, seed: 1 } },
    ];
  }
  if (capability === 'supportsPromptCache' || capability === 'supportsStructuredOutput') return null;

  const generationConfig: Record<string, unknown> = { maxOutputTokens: 8 };
  const body: Record<string, unknown> = {
    ...defaultContent,
    generationConfig,
  };
  if (capability === 'supportsTools') {
    body.contents = [{ role: 'user', parts: [{ text: '调用 ' + TOOLS_PROBE_NAME + ' 获取当前时间' }] }];
    body.tools = [{ functionDeclarations: [{ name: TOOLS_PROBE_NAME, description: 'Return the current time', parameters: { type: 'OBJECT', properties: { time_zone: { type: 'STRING' } }, required: ['time_zone'] } }] }];
    body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [TOOLS_PROBE_NAME] } };
  }
  if (capability === 'supportsJsonMode') {
    body.contents = [{ role: 'user', parts: [{ text: '仅返回 {"ok":true}' }] }];
    generationConfig.responseMimeType = 'application/json';
  }
  if (capability === 'supportsReasoning') generationConfig.thinkingConfig = { thinkingBudget: 128 };
  if (capability === 'supportsStop') { body.contents = [{ role: 'user', parts: [{ text: '依次输出：一，二，三，四，五，六，七，八，九，十' }] }]; generationConfig.maxOutputTokens = 120; generationConfig.stopSequences = [STOP_PROBE_WORD]; }
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
