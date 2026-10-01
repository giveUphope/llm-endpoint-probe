import { PROBE_FAKE_MODEL_ID } from '../adapters/shared';
import { emptyCapabilities } from '../domain/capabilities';
import type {
  CapabilityKey,
  CapabilityStatus,
  CapabilityValue,
  Confidence,
  DiscoveryRun,
  DiscoveredModel,
  InputModality,
  ProtocolType,
} from '../domain/types';

// 仅开发环境使用的演示数据：让参照比对、能力判定分级等展示层可以在没有真实端点
// 与 API Key 的情况下被目测。四台"端点"的声明都对照了 OpenRouter 在线目录的真实条目，
// 因此每个模型都能稳定命中一种判定：一致 / 实测优先 / 声明分歧 / 参照部分声明 /
// 参照更广 / 参照未覆盖 / 上下文与模态冲突 / 档位合并 / reasoning 档位分歧。
// 这里不发送任何请求：示例只填充展示层，绝不进入证据链或配置回写。

interface CapabilitySeed {
  key: CapabilityKey;
  value: CapabilityValue;
  source: CapabilityStatus['evidence'][number]['source'];
  confidence: CapabilityStatus['evidence'][number]['confidence'];
  detail: string;
}

function capabilities(seeds: CapabilitySeed[]): DiscoveredModel['capabilities'] {
  const next = emptyCapabilities();
  for (const seed of seeds) {
    next[seed.key] = {
      value: seed.value,
      evidence: [{ source: seed.source, confidence: seed.confidence, detail: seed.detail, timestamp: new Date().toISOString() }],
    };
  }
  return next;
}

interface SampleSpec {
  id: string;
  displayName: string;
  protocol: ProtocolType;
  vendor?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities: InputModality[];
  reasoningLevels?: string[];
  supportedEndpoints: string[];
  discoverySource: string;
  confidence: Confidence;
  status: DiscoveredModel['status'];
  seeds: CapabilitySeed[];
  rawMetadata: Record<string, unknown>;
}

function toModel(spec: SampleSpec): DiscoveredModel {
  return {
    id: spec.id,
    displayName: spec.displayName,
    protocol: spec.protocol,
    ...(spec.vendor ? { vendor: spec.vendor } : {}),
    ...(spec.contextWindow != null ? { contextWindow: spec.contextWindow } : {}),
    ...(spec.maxOutputTokens != null ? { maxOutputTokens: spec.maxOutputTokens } : {}),
    inputModalities: spec.inputModalities,
    capabilities: capabilities(spec.seeds),
    reasoningLevels: spec.reasoningLevels ?? [],
    supportedEndpoints: spec.supportedEndpoints,
    discoverySource: spec.discoverySource,
    confidence: spec.confidence,
    status: spec.status,
    lastProbedAt: new Date().toISOString(),
    rawMetadata: spec.rawMetadata,
  };
}

const SPECS: SampleSpec[] = [
  {
    // 中转网关：静默丢弃 temperature、忽略 stop，但确实能出工具调用
    id: 'gpt-4o',
    displayName: 'GPT-4o（中转网关）',
    protocol: 'openai-chat',
    vendor: 'OpenAI',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputModalities: ['text'],
    supportedEndpoints: ['/chat/completions'],
    discoverySource: 'sample · /v1/models',
    confidence: 'high',
    status: 'validated',
    seeds: [
      { key: 'supportsTools', value: 'supported', source: 'validated', confidence: 'high', detail: '实测到 tool_calls 数组' },
      { key: 'supportsJsonMode', value: 'supported', source: 'validated', confidence: 'high', detail: 'response_format=json_object 返回可解析 JSON' },
      { key: 'supportsStructuredOutput', value: 'supported', source: 'validated', confidence: 'high', detail: '严格 json_schema 输出符合 schema' },
      // 参照目录所有上架都声明支持 temperature：实测不生效 → 实测优先（参照声明过时或被裁剪）
      { key: 'supportsTemperature', value: 'unsupported', source: 'validated', confidence: 'medium', detail: '双探测 temperature=0 与 1 输出逐字相同' },
      // 两侧都只是声明 → 声明分歧
      { key: 'supportsStop', value: 'unsupported', source: 'endpoint', confidence: 'medium', detail: '目录未声明 stop' },
      { key: 'supportsSeed', value: 'supported', source: 'endpoint', confidence: 'medium', detail: '目录声明支持 seed' },
      { key: 'supportsReasoning', value: 'inferred', source: 'inferred', confidence: 'low', detail: '基于模型系列推测' },
    ],
    rawMetadata: { id: 'gpt-4o', object: 'model', created: 1715000000, owned_by: 'openai', max_input_tokens: 128000 },
  },
  {
    // Ollama 本地：id 写法 llama3.1:8b 依赖参照匹配的名称折叠才能命中
    id: 'llama3.1:8b',
    displayName: 'LLaMA 3.1 8B',
    protocol: 'ollama',
    vendor: 'meta-llama',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    inputModalities: ['text'],
    supportedEndpoints: ['/api/chat', '/chat/completions'],
    discoverySource: 'sample · /api/tags',
    confidence: 'medium',
    status: 'validated',
    seeds: [
      { key: 'supportsTools', value: 'supported', source: 'validated', confidence: 'high', detail: '实测到 tool_calls 数组' },
      { key: 'supportsStreaming', value: 'supported', source: 'validated', confidence: 'high', detail: '检测到 SSE 事件流' },
      // 参照该上架未声明 temperature：实测生效 → 实测优先（端点比参照更准）
      { key: 'supportsTemperature', value: 'supported', source: 'validated', confidence: 'high', detail: '双探测输出随 temperature 明显变化' },
      { key: 'supportsJsonMode', value: 'supported', source: 'endpoint', confidence: 'medium', detail: '目录声明 response_format' },
    ],
    rawMetadata: { name: 'llama3.1:8b', model: 'llama3.1:8b', size: 4_900_000_000, details: { family: 'llama', parameter_size: '8b', quantization: 'Q4_K_M' } },
  },
  {
    // 自建部署对齐参照的 :free 档上下文，且 structured_outputs 只在主档声明 → 参照部分声明
    id: 'qwen3.8-27b',
    displayName: 'Qwen3.8 27B',
    protocol: 'openai-compatible',
    vendor: 'Qwen',
    contextWindow: 262144,
    maxOutputTokens: 32768,
    inputModalities: ['text', 'image'],
    reasoningLevels: ['low', 'high'],
    supportedEndpoints: ['/chat/completions'],
    discoverySource: 'sample · /v1/models',
    confidence: 'medium',
    status: 'partial',
    seeds: [
      { key: 'supportsTools', value: 'supported', source: 'validated', confidence: 'high', detail: '实测到 tool_calls 数组' },
      { key: 'supportsReasoning', value: 'supported', source: 'validated', confidence: 'high', detail: '响应含 message.reasoning' },
      { key: 'supportsStructuredOutput', value: 'unsupported', source: 'validated', confidence: 'medium', detail: '严格 schema 与回退 json_object 均输出非法 JSON' },
      { key: 'supportsTopP', value: 'unknown', source: 'unknown', confidence: 'unknown', detail: '尚未探测' },
    ],
    rawMetadata: { id: 'qwen3.8-27b', object: 'model', owned_by: 'qwen', context_length: 262144 },
  },
  {
    // 上下文被裁到 64K 且声称支持图片：命中参照的上下文冲突与模态冲突
    id: 'deepseek-chat',
    displayName: 'DeepSeek Chat（降配渠道）',
    protocol: 'openai-chat',
    vendor: 'DeepSeek',
    contextWindow: 64000,
    maxOutputTokens: 8192,
    inputModalities: ['text', 'image'],
    supportedEndpoints: ['/chat/completions', '/completions'],
    discoverySource: 'sample · /v1/models',
    confidence: 'low',
    status: 'partial',
    seeds: [
      { key: 'supportsTools', value: 'supported', source: 'endpoint', confidence: 'medium', detail: '目录声明 tools' },
      // 参照声明支持 response_format，实测拿不到 JSON → 实测优先
      { key: 'supportsJsonMode', value: 'unsupported', source: 'validated', confidence: 'medium', detail: '请求 json_object 返回带前后缀的自然语言' },
      { key: 'supportsSeed', value: 'supported', source: 'endpoint', confidence: 'medium', detail: '目录声明 seed' },
    ],
    rawMetadata: { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
  },
];

function probeRecords(models: DiscoveredModel[]): DiscoveryRun['requests'] {
  const timestamp = new Date().toISOString();
  return models.map((model, index) => ({
    id: `sample-request-${index + 1}`,
    stepId: 'sample-step-validation',
    method: 'POST',
    url: '/v1/chat/completions',
    finalURL: `https://sample.invalid/v1/chat/completions?model=${encodeURIComponent(model.id)}`,
    requestHeaders: { Authorization: '[REDACTED]', 'Content-Type': 'application/json' },
    requestBody: { model: model.id, messages: [{ role: 'user', content: 'Reply with JSON only.' }], max_tokens: 16 },
    status: 200,
    durationMs: 180 + index * 37,
    responseBytes: 512 + index * 96,
    responsePreview: { id: `chatcmpl-sample-${index + 1}`, object: 'chat.completion', model: model.id, choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] },
    timestamp,
  }));
}

export function createSampleRun(): DiscoveryRun {
  const startedAt = new Date().toISOString();
  const models = SPECS.map(toModel).map((model, index) => ({
    ...model,
    ...(index === 0 ? {
      nameCheck: {
        checkedAt: startedAt,
        echoedModelId: 'gpt-4o-2024-08-06',
        aliased: false,
        acceptsUnknownNames: false,
        probeModelId: PROBE_FAKE_MODEL_ID,
        interfaces: ['openai'],
      },
    } : {}),
  }));
  const requests = probeRecords(models);
  return {
    id: 'sample-run',
    endpointId: 'sample-endpoint',
    endpointName: '示例端点（仅开发环境）',
    endpointBaseURL: 'https://sample.invalid/v1',
    status: 'success',
    protocol: 'openai-chat',
    startedAt,
    completedAt: startedAt,
    steps: [
      { id: 'sample-step-connect', name: '连通性检查', status: 'success', startedAt, completedAt: startedAt, durationMs: 96, requestIds: [], summary: '示例数据，未发送真实请求' },
      { id: 'sample-step-protocol', name: '协议识别', status: 'success', startedAt, completedAt: startedAt, durationMs: 42, requestIds: [], summary: 'OpenAI Chat 兼容' },
      { id: 'sample-step-discovery', name: '模型发现', status: 'success', startedAt, completedAt: startedAt, durationMs: 128, requestIds: [], summary: `${models.length} 个模型` },
      { id: 'sample-step-validation', name: '能力验证', status: 'warning', startedAt, completedAt: startedAt, durationMs: requests.length * 200, requestIds: requests.map((item) => item.id), summary: 'Top P / 提示词缓存 仍为未知' },
    ],
    requests,
    models,
  };
}
