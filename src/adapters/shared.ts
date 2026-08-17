import { emptyCapabilities, evidence, inferCapabilities, modelConfidence } from '../domain/capabilities';
import type { DiscoveredModel, ProtocolType } from '../domain/types';
import { sanitizeData } from '../lib/security';

export function numberFrom(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

export function normalizeModel(raw: Record<string, unknown>, protocol: ProtocolType, source: string): DiscoveredModel {
  const id = String(raw.id ?? raw.model ?? raw.name ?? 'unknown-model');
  const capabilities = emptyCapabilities();

  const declared = raw.capabilities && typeof raw.capabilities === 'object'
    ? raw.capabilities as Record<string, unknown>
    : {};
  const capabilityMap: Partial<Record<keyof typeof capabilities, string[]>> = {
    supportsTools: ['tools', 'tool_calling', 'supports_tools'],
    supportsJsonMode: ['json_mode', 'supports_json_mode'],
    supportsStructuredOutput: ['structured_output', 'supports_structured_output'],
    supportsReasoning: ['reasoning', 'supports_reasoning'],
    supportsStreaming: ['streaming', 'supports_streaming'],
  };

  for (const [key, aliases] of Object.entries(capabilityMap)) {
    const value = aliases?.map((alias) => declared[alias] ?? raw[alias]).find((item) => typeof item === 'boolean');
    if (typeof value === 'boolean') {
      capabilities[key as keyof typeof capabilities] = {
        value: value ? 'supported' : 'unsupported',
        evidence: [evidence('endpoint', 'medium', `${source} 元数据声明 ${aliases?.[0]}`)],
      };
    }
  }

  const supportedParameters = new Set(
    Array.isArray(raw.supported_parameters) ? raw.supported_parameters.map((item) => String(item).toLowerCase()) : [],
  );
  const parameterCapabilities: Partial<Record<keyof typeof capabilities, string[]>> = {
    supportsTools: ['tools', 'tool_choice'],
    supportsJsonMode: ['response_format'],
    supportsStructuredOutput: ['structured_outputs'],
    supportsReasoning: ['reasoning', 'reasoning_effort', 'include_reasoning'],
    supportsTemperature: ['temperature'],
    supportsTopP: ['top_p'],
    supportsStop: ['stop'],
    supportsSeed: ['seed'],
    supportsStreaming: ['stream'],
    supportsPromptCache: ['cache_control'],
  };
  for (const [key, parameters] of Object.entries(parameterCapabilities)) {
    const matched = parameters?.filter((parameter) => supportedParameters.has(parameter)) ?? [];
    if (matched.length) {
      capabilities[key as keyof typeof capabilities] = {
        value: 'supported',
        evidence: [evidence('endpoint', 'medium', `${source} supported_parameters 包含 ${matched.join(', ')}`)],
      };
    }
  }

  const architecture = raw.architecture && typeof raw.architecture === 'object'
    ? raw.architecture as Record<string, unknown>
    : {};
  const modalitiesRaw = raw.input_modalities ?? raw.modalities ?? architecture.input_modalities ?? declared.modalities;
  const modalities = Array.isArray(modalitiesRaw)
    ? [...new Set(modalitiesRaw.map((item) => String(item) === 'file' ? 'pdf' : String(item)).filter((item): item is DiscoveredModel['inputModalities'][number] =>
        ['text', 'image', 'audio', 'video', 'pdf'].includes(item),
      ))]
    : ['text' as const];

  const topProvider = raw.top_provider && typeof raw.top_provider === 'object'
    ? raw.top_provider as Record<string, unknown>
    : {};
  const reasoning = raw.reasoning && typeof raw.reasoning === 'object'
    ? raw.reasoning as Record<string, unknown>
    : {};
  const pricing = raw.pricing && typeof raw.pricing === 'object'
    ? raw.pricing as Record<string, unknown>
    : {};
  if (capabilities.supportsPromptCache.value === 'unknown' && pricing.input_cache_read != null) {
    capabilities.supportsPromptCache = {
      value: 'inferred',
      evidence: [evidence('inferred', 'low', `${source} pricing 包含 input_cache_read；实际缓存能力取决于路由 Provider`) ],
    };
  }

  const model = inferCapabilities({
    id,
    displayName: String(raw.display_name ?? raw.name ?? id),
    protocol,
    contextWindow: numberFrom(raw, ['context_window', 'context_length', 'num_ctx']),
    maxOutputTokens: numberFrom(raw, ['max_output_tokens', 'max_tokens', 'num_predict']) ?? numberFrom(topProvider, ['max_completion_tokens']),
    inputModalities: modalities,
    capabilities,
    reasoningLevels: Array.isArray(raw.reasoning_levels)
      ? raw.reasoning_levels.map(String)
      : Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts.map(String) : [],
    supportedEndpoints: Array.isArray(raw.supported_endpoints) ? raw.supported_endpoints.map(String) : [],
    discoverySource: source,
    confidence: 'unknown',
    status: 'discovered',
    lastProbedAt: new Date().toISOString(),
    rawMetadata: sanitizeData(raw),
  });
  model.confidence = modelConfidence(model);
  return model;
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
}
