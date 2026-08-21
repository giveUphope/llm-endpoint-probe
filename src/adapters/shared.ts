import { emptyCapabilities, evidence, inferCapabilities, modelConfidence } from '../domain/capabilities';
import type { AdapterRequest, DiscoveredModel, ProtocolType } from '../domain/types';
import { sanitizeData } from '../lib/security';

// 目录声明的接口类型 → 可复用的协议（用于多接口交叉验证）；
// 未列出的类型（image-generation / openai-video / doubao / jimeng 等）为展示性信息，不做对话类验证
export const ENDPOINT_TYPE_PROTOCOL: Record<string, ProtocolType> = {
  openai: 'openai-compatible',
  'openai-response': 'openai-responses',
  anthropic: 'anthropic',
  gemini: 'gemini',
};

// 可做最小生成探测的非对话接口类型（OpenAI 兼容表面：/images /videos /music generations）
export const GENERATION_INTERFACE_TYPES = ['image-generation', 'openai-video', 'music'] as const;

const ENDPOINT_TYPE_PATHS: Record<string, string> = {
  openai: '/chat/completions',
  'openai-response': '/responses',
  anthropic: '/messages',
  gemini: '/models/{model}:generateContent',
  completion: '/completions',
  embeddings: '/embeddings',
  image: '/images/generations',
  'image-generation': '/images/generations',
  'openai-video': '/videos/generations',
  doubao: '/chat/completions',
  jimeng: '/images/generations',
};

export function interfaceLabel(key: string): string {
  const labels: Record<string, string> = {
    openai: 'OpenAI Chat',
    'openai-response': 'OpenAI Responses',
    anthropic: 'Anthropic Messages',
    gemini: 'Gemini',
    completion: 'Completions',
    embeddings: 'Embeddings',
    image: '文生图',
    'image-generation': '文生图',
    'openai-video': '视频生成',
    music: '音乐生成',
    doubao: '豆包',
    jimeng: '即梦/图片',
  };
  return labels[key] ?? key;
}

// 生成类接口的最小探测请求（OpenAI 兼容表面）；未知类型返回 null
export function buildGenerationProbe(interfaceType: string, modelId: string): AdapterRequest | null {
  const body = { model: modelId };
  if (interfaceType === 'image-generation') {
    return { method: 'POST', path: '/images/generations', body: { ...body, prompt: '1x1 红色像素点', n: 1, size: '256x256', response_format: 'b64_json' } };
  }
  if (interfaceType === 'openai-video') {
    return { method: 'POST', path: '/videos/generations', body: { ...body, prompt: '纯黑静态画面，1 秒' } };
  }
  if (interfaceType === 'music') {
    return { method: 'POST', path: '/music/generations', body: { ...body, prompt: '简短环境音' } };
  }
  return null;
}

export interface GenerationShape {
  family: 'openai-images' | 'image-array' | 'output-array' | 'async-task' | 'status-only' | 'text' | 'unknown';
  label: string;
  imageCount?: number;
  b64Length?: number;
  taskStatus?: string;
}

// 生成类接口响应结构识别：图像/视频/音乐接口通常没有模型回显字段，
// 响应结构本身就是上游通道的指纹（OpenAI 标准图像 / 异步任务 / 图片数组等）
export function classifyGenerationShape(data: unknown): GenerationShape {
  const root = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
  const dataArray = Array.isArray(root?.data) ? root.data as unknown[] : [];
  const first = dataArray[0] && typeof dataArray[0] === 'object' ? dataArray[0] as Record<string, unknown> : undefined;
  if (typeof root?.id === 'string' && typeof root?.status === 'string') {
    return { family: 'async-task', label: `异步任务（status=${root.status}）`, taskStatus: root.status };
  }
  if (dataArray.length) {
    const b64 = typeof first?.b64_json === 'string' ? first.b64_json : typeof first?.b64 === 'string' ? first.b64 : undefined;
    return {
      family: 'openai-images',
      label: `OpenAI 图像（data[${dataArray.length}]${b64 ? '，含 b64_json' : typeof first?.url === 'string' ? '，含 url' : ''}）`,
      imageCount: dataArray.length,
      ...(b64 ? { b64Length: b64.length } : {}),
    };
  }
  if (Array.isArray(root?.images) && (root.images as unknown[]).length) {
    return { family: 'image-array', label: `images 数组（${(root.images as unknown[]).length}）`, imageCount: (root.images as unknown[]).length };
  }
  if (Array.isArray(root?.output) && (root.output as unknown[]).length) {
    return { family: 'output-array', label: `output 数组（${(root.output as unknown[]).length}）`, imageCount: (root.output as unknown[]).length };
  }
  if (typeof root?.status === 'string') return { family: 'status-only', label: `仅状态（status=${root.status}）` };
  if (typeof data === 'string') return { family: 'text', label: '文本响应（可能是 SSE 流）' };
  return { family: 'unknown', label: '无法识别的响应结构' };
}

const PREVIEW_MAX_B64_LENGTH = 150_000; // 256x256 图像的 b64 通常远小于此；超出则疑似未被按尺寸生成

// 最小参数尊重度：探测请求 n=1、size=256x256，据此判断请求是否被默认模型处理
export function imageConsistencyFlags(shape: GenerationShape): { nHonored?: boolean; sizeHonored?: boolean } {
  return {
    ...(shape.imageCount != null ? { nHonored: shape.imageCount === 1 } : {}),
    ...(shape.b64Length != null ? { sizeHonored: shape.b64Length <= PREVIEW_MAX_B64_LENGTH } : {}),
  };
}

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
        evidence: [evidence('endpoint', 'medium', `${source} 目录声明支持 ${aliases?.[0]}（声明证据，未实测）`)],
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

  const endpointTypesRaw = Array.isArray(raw.supported_endpoint_types) ? raw.supported_endpoint_types.map(String) : [];
  const endpointTypes = [...new Set(endpointTypesRaw)];
  const endpointPaths = endpointTypes.map((type) => ENDPOINT_TYPE_PATHS[type]).filter((path): path is string => Boolean(path));
  const vendor = typeof raw.vendor_name === 'string' && raw.vendor_name.trim()
    ? raw.vendor_name.trim()
    : typeof raw.owned_by === 'string' && raw.owned_by.trim() ? raw.owned_by.trim() : undefined;

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
    supportedEndpoints: endpointPaths.length ? endpointPaths : Array.isArray(raw.supported_endpoints) ? raw.supported_endpoints.map(String) : [],
    discoverySource: source,
    confidence: 'unknown',
    status: 'discovered',
    lastProbedAt: new Date().toISOString(),
    rawMetadata: sanitizeData(raw),
    ...(vendor ? { vendor } : {}),
    ...(endpointTypes.length ? { endpointTypes } : {}),
  });
  model.confidence = modelConfidence(model);
  return model;
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    : [];
}

// 用于探测端点是否对未知模型名静默放行的虚假模型名
export const PROBE_FAKE_MODEL_ID = 'zcode-probe-nonexistent-model';

// 停止词探测默认值；若出现在响应输出中则证明 stop 参数未被尊重
export const DEFAULT_STOP_SEQUENCE = 'ZCODE_STOP_SEQUENCE_HERE';

// 提取端点响应中实际回显的模型名；依次检查 data.model / modelVersion / choices[0].message.model，
// 覆盖 OpenAI / Cohere / Ollama / Gemini / OpenRouter 中继等主流响应形状；SSE 流字符串不提取
export function extractEchoedModel(data: unknown): string | undefined {
  const root = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
  if (!root) return undefined;
  if (typeof root.model === 'string' && root.model.trim()) return root.model.trim();
  if (typeof root.modelVersion === 'string' && root.modelVersion.trim()) return root.modelVersion.trim();
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : undefined;
  if (typeof firstChoice?.model === 'string' && firstChoice.model.trim()) return firstChoice.model.trim();
  const message = firstChoice?.message && typeof firstChoice.message === 'object'
    ? firstChoice.message as Record<string, unknown>
    : undefined;
  if (typeof message?.model === 'string' && message.model.trim()) return message.model.trim();
  return undefined;
}

// 回显名与请求名是否指向同一型号；Gemini 等会回显版本化全名（如 gemini-2.5-flash-001）。
// 仅当两个名存在前缀关系，且后接部分纯粹是版本号（数字、点、连字符、v）时视为同一型号；
// 形如 gpt-4o-mini / llama-3-8b / qwen-2.5-coder 等含字母的变体后缀会被正确区分
export function sameModelName(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const suffix = x.startsWith(y) ? x.slice(y.length) : y.startsWith(x) ? y.slice(x.length) : undefined;
  if (!suffix) return false;
  return /^[-.v]*\d+[-.v\d]*$/.test(suffix);
}
