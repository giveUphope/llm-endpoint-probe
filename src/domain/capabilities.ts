import type {
  CapabilityEvidence,
  CapabilityKey,
  CapabilityStatus,
  Confidence,
  DiscoveredModel,
  InputModality,
} from './types';

export const capabilityKeys: CapabilityKey[] = [
  'supportsTools',
  'supportsJsonMode',
  'supportsStructuredOutput',
  'supportsReasoning',
  'supportsTemperature',
  'supportsTopP',
  'supportsStop',
  'supportsSeed',
  'supportsStreaming',
  'supportsPromptCache',
];

export const capabilityLabels: Record<CapabilityKey, string> = {
  supportsTools: 'Tools',
  supportsJsonMode: 'JSON 模式',
  supportsStructuredOutput: '结构化输出',
  supportsReasoning: 'Reasoning',
  supportsTemperature: 'Temperature',
  supportsTopP: 'Top P',
  supportsStop: 'Stop',
  supportsSeed: 'Seed',
  supportsStreaming: 'Streaming',
  supportsPromptCache: '提示词缓存',
};

export function evidence(
  source: CapabilityEvidence['source'],
  confidence: Confidence,
  detail: string,
): CapabilityEvidence {
  return { source, confidence, detail, timestamp: new Date().toISOString() };
}

export function unknownCapability(detail = '尚未探测'): CapabilityStatus {
  return { value: 'unknown', evidence: [evidence('unknown', 'unknown', detail)] };
}

export function emptyCapabilities(): DiscoveredModel['capabilities'] {
  return Object.fromEntries(capabilityKeys.map((key) => [key, unknownCapability()])) as DiscoveredModel['capabilities'];
}

const inferenceRules: Array<{
  test: RegExp;
  modalities?: InputModality[];
  reasoning?: boolean;
  tools?: boolean;
}> = [
  { test: /(?:vision|vl|gpt-4o|gemini|claude-3)/i, modalities: ['text', 'image'] },
  { test: /(?:^|[-_.])(o1|o3|o4|r1|reasoner)(?:$|[-_.])/i, reasoning: true },
  { test: /(?:gpt-4|gpt-5|claude|qwen|llama-3)/i, tools: true },
];

export function inferCapabilities(model: DiscoveredModel): DiscoveredModel {
  const next = structuredClone(model);
  for (const rule of inferenceRules) {
    if (!rule.test.test(model.id)) continue;
    if (rule.modalities && model.inputModalities.length === 1) {
      next.inputModalities = rule.modalities;
      next.inferredInputModalities = rule.modalities.filter((item) => !model.inputModalities.includes(item));
    }
    if (rule.reasoning) {
      next.capabilities.supportsReasoning = {
        value: 'inferred',
        evidence: [evidence('inferred', 'low', `基于模型名称 ${model.id} 推测`) ],
      };
    }
    if (rule.tools) {
      next.capabilities.supportsTools = {
        value: 'inferred',
        evidence: [evidence('inferred', 'low', `基于模型系列 ${model.id} 推测`) ],
      };
    }
  }
  return next;
}

export function modelConfidence(model: DiscoveredModel): Confidence {
  const values = Object.values(model.capabilities);
  if (values.some((cap) => cap.evidence.some((item) => item.source === 'validated'))) return 'high';
  if (model.contextWindow || model.maxOutputTokens) return 'medium';
  return values.some((cap) => cap.value === 'inferred') ? 'low' : 'unknown';
}
