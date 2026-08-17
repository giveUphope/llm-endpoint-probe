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

  const modalitiesRaw = raw.input_modalities ?? raw.modalities ?? declared.modalities;
  const modalities = Array.isArray(modalitiesRaw)
    ? modalitiesRaw.filter((item): item is DiscoveredModel['inputModalities'][number] =>
        ['text', 'image', 'audio', 'video', 'pdf'].includes(String(item)),
      )
    : ['text' as const];

  const model = inferCapabilities({
    id,
    displayName: String(raw.display_name ?? raw.name ?? id),
    protocol,
    contextWindow: numberFrom(raw, ['context_window', 'context_length', 'num_ctx']),
    maxOutputTokens: numberFrom(raw, ['max_output_tokens', 'max_tokens', 'num_predict']),
    inputModalities: modalities,
    capabilities,
    reasoningLevels: Array.isArray(raw.reasoning_levels) ? raw.reasoning_levels.map(String) : [],
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
