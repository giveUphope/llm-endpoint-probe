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

export type AuthMode = 'bearer' | 'api-key' | 'custom' | 'none';
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
  queryParams: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface ProxyResponse {
  ok: boolean;
  status: number;
  durationMs: number;
  responseBytes: number;
  data: unknown;
  headers: Record<string, string>;
  finalURL?: string;
}
