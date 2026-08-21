export type ProtocolType =
  | 'auto'
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini'
  | 'cohere'
  | 'ollama'
  | 'llamacpp'
  | 'openai-compatible'
  | 'manual';

export type AuthMode = 'auto' | 'bearer' | 'api-key' | 'custom' | 'none';
export type CapabilityValue = 'supported' | 'unsupported' | 'unknown' | 'inferred';
export type EvidenceSource = 'endpoint' | 'validated' | 'inferred' | 'unknown' | 'user';
export type Confidence = 'high' | 'medium' | 'low' | 'unknown';
export type InputModality = 'text' | 'image' | 'audio' | 'video' | 'pdf';

export interface KeyValue {
  id: string;
  key: string;
  value: string;
}

export interface EndpointProfile {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  authMode: AuthMode;
  customHeaderName: string;
  customHeaderTemplate: string;
  protocol: ProtocolType;
  headers: KeyValue[];
  queryParams: KeyValue[];
  timeoutMs: number;
  allowValidation: boolean;
  allowLocalNetwork: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityEvidence {
  source: EvidenceSource;
  confidence: Confidence;
  detail: string;
  timestamp: string;
  requestId?: string;
}

export interface CapabilityStatus {
  value: CapabilityValue;
  evidence: CapabilityEvidence[];
}

// 生成类接口（绘图/音乐/视频）上单个接口的名称一致性探测结果
export interface GenerationInterfaceCheck {
  interface: string; // image-generation / openai-video / music
  realAccepted: boolean; // 真实模型名在该接口被接受
  fakeAccepted: boolean; // 虚假模型名在该接口被接受（静默放行）
  rejection?: string; // 真实名被拒时网关给出的原因
  realShape?: string; // 真实名响应的结构族（openai-images / async-task / ...）
  fakeShape?: string; // 虚假名响应的结构族
  shapeConsistent?: boolean; // 真实名与虚假名响应结构是否同族（同族→疑似同一默认上游）
  echo?: string; // 真实名响应回显的模型名（如有）
  contentMatch?: boolean; // 真实名与虚假名响应内容是否高度相似（排除非确定性字段后）
  nHonored?: boolean; // 请求 n=1 是否被尊重（返回 1 张图）
  sizeHonored?: boolean; // 请求 256x256 是否被尊重（b64 长度未超阈值）
}

export interface GenerationCheck {
  interfaces: string[];
  nameServed: boolean; // 真实名在所有已测生成接口均被接受
  permissive: boolean; // 任一生成接口放行虚假名
  details: GenerationInterfaceCheck[];
}

// 模型名真实性校验：比对请求名与端点回显名，并用虚假模型名探测端点是否对未知名称放行
export interface ModelNameCheck {
  checkedAt: string;
  echoedModelId?: string; // 端点实际回显的模型名（如 data.model / modelVersion）
  aliased?: boolean; // 回显名与请求名不一致，请求名疑似别名
  acceptsUnknownNames?: boolean; // 虚假模型名探测被接受（端点对任意名称放行）
  probeModelId?: string; // 探测使用的虚假模型名
  interfaces?: string[]; // 实际执行过名称校验的接口
  probeRejection?: string; // 虚假名探测被拒绝时，网关给出的原因分类
  generationCheck?: GenerationCheck; // 生成类接口（绘图/音乐/视频）的名称一致性
}

export type CapabilityKey =
  | 'supportsTools'
  | 'supportsJsonMode'
  | 'supportsStructuredOutput'
  | 'supportsReasoning'
  | 'supportsTemperature'
  | 'supportsTopP'
  | 'supportsStop'
  | 'supportsSeed'
  | 'supportsStreaming'
  | 'supportsPromptCache';

export interface DiscoveredModel {
  id: string;
  displayName: string;
  protocol: ProtocolType;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities: InputModality[];
  inferredInputModalities?: InputModality[];
  capabilities: Record<CapabilityKey, CapabilityStatus>;
  reasoningLevels: string[];
  supportedEndpoints: string[];
  discoverySource: string;
  confidence: Confidence;
  status: 'discovered' | 'validating' | 'validated' | 'partial' | 'error';
  lastProbedAt: string;
  rawMetadata: unknown;
  nameCheck?: ModelNameCheck;
  vendor?: string; // 上游厂商（来自目录 vendor_name / owned_by），用于真假模型溯源
  endpointTypes?: string[]; // 目录声明的接口类型（openai / anthropic / gemini / openai-response / image-generation 等）
}

export type StepStatus = 'pending' | 'running' | 'success' | 'warning' | 'error' | 'cancelled';

export interface RequestRecord {
  id: string;
  stepId: string;
  method: string;
  url: string;
  finalURL?: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  status?: number;
  durationMs?: number;
  responseBytes?: number;
  responsePreview?: unknown;
  errorType?: ProbeErrorType;
  errorMessage?: string;
  retryCount?: number;
  timestamp: string;
}

export type ProbeErrorType =
  | 'invalid_url'
  | 'cors'
  | 'network'
  | 'timeout'
  | 'tls'
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'server'
  | 'format'
  | 'too_large'
  | 'cancelled'
  | 'blocked';

export interface DiscoveryStep {
  id: string;
  name: string;
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  summary?: string;
  requestIds: string[];
}

export interface DiscoveryRun {
  id: string;
  endpointId: string;
  endpointName?: string;
  endpointBaseURL?: string;
  endpointQueryParams?: KeyValue[];
  status: 'idle' | 'running' | 'success' | 'partial' | 'error' | 'cancelled';
  protocol?: ProtocolType;
  startedAt: string;
  completedAt?: string;
  steps: DiscoveryStep[];
  requests: RequestRecord[];
  models: DiscoveredModel[];
}

export interface AdapterRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ProtocolAdapter {
  id: ProtocolType;
  label: string;
  discoveryRequests(baseURL: string): AdapterRequest[];
  recognizes(payload: unknown): boolean;
  parseModels(payload: unknown): DiscoveredModel[];
  buildValidationRequest(modelId: string, capability: CapabilityKey): AdapterRequest | null;
}

export interface ProxyRequest {
  endpointToken: string;
  path: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface ProxyResponse {
  ok: boolean;
  status: number;
  durationMs: number;
  responseBytes: number;
  data: unknown;
  preview?: unknown;
  headers: Record<string, string>;
  finalURL?: string;
}
