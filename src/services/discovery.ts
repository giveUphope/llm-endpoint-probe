import { adapterCandidates, adapterFor } from '../adapters';
import { evidence, modelConfidence } from '../domain/capabilities';
import type {
  CapabilityKey,
  CapabilityStatus,
  DiscoveryRun,
  DiscoveryStep,
  DiscoveredModel,
  EndpointProfile,
  ProbeErrorType,
  ProtocolAdapter,
  ProxyResponse,
  RequestRecord,
} from '../domain/types';
import { mergeHeaders, normalizeApiKey, redactHeaders, redactText, sanitizeData } from '../lib/security';
import { detectProvider } from '../lib/providers';
import { uid } from '../lib/profile';
import { authorizeEndpoint, ProbeError, proxyRequest } from './proxy';

const stepDefinitions = [
  ['connectivity', '连通性检查'],
  ['authentication', '认证诊断'],
  ['protocol', '协议识别'],
  ['models', '模型列表发现'],
  ['capabilities', '能力归一化'],
] as const;

export function createRun(endpointId: string): DiscoveryRun {
  return {
    id: uid(),
    endpointId,
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: stepDefinitions.map(([id, name]) => ({ id, name, status: 'pending', requestIds: [] })),
    requests: [],
    models: [],
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function outputContent(data: unknown): unknown {
  const root = record(data);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const firstChoice = record(choices[0]);
  const message = record(firstChoice?.message) ?? record(root?.message);
  if (message?.content != null) return message.content;
  const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
  const candidateParts = Array.isArray(record(record(candidates[0])?.content)?.parts)
    ? record(record(candidates[0])?.content)?.parts as unknown[]
    : [];
  if (candidateParts.length) return candidateParts;
  if (typeof root?.output_text === 'string') return root.output_text;
  const output = Array.isArray(root?.output) ? root.output : [];
  for (const item of output) {
    const content = Array.isArray(record(item)?.content) ? record(item)?.content as unknown[] : [];
    for (const part of content) {
      const text = record(part)?.text;
      if (typeof text === 'string') return text;
    }
  }
  return undefined;
}

function hasToolCall(data: unknown): boolean {
  const root = record(data);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const message = record(record(choices[0])?.message) ?? record(root?.message);
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) return true;
  const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
  const candidateParts = Array.isArray(record(record(candidates[0])?.content)?.parts)
    ? record(record(candidates[0])?.content)?.parts as unknown[]
    : [];
  if (candidateParts.some((item) => Boolean(record(item)?.functionCall))) return true;
  const content = Array.isArray(root?.content) ? root.content : [];
  const output = Array.isArray(root?.output) ? root.output : [];
  return [...content, ...output].some((item) => ['tool_use', 'function_call'].includes(String(record(item)?.type)));
}

function isJsonOutput(data: unknown): boolean {
  const content = outputContent(data);
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((item) => typeof item === 'string' ? item : String(record(item)?.text ?? '')).join('') : '';
  if (!text) return false;
  try { return Boolean(JSON.parse(text)); } catch { return false; }
}

function upstreamErrorMessage(data: unknown): string | undefined {
  const root = record(data);
  const nested = record(root?.error);
  const message = nested?.message ?? root?.message ?? root?.detail;
  return typeof message === 'string' ? message.slice(0, 240) : undefined;
}

export function summarizeResponse(data: unknown): unknown {
  const root = record(data);
  if (!root) return data;
  for (const key of ['data', 'models']) {
    const items = root[key];
    if (Array.isArray(items) && items.length > 3) {
      return { ...root, [key]: items.slice(0, 3), totalItems: items.length, truncated: true };
    }
  }
  return data;
}

export function describeHttpFailure(status: number, data: unknown, profile: EndpointProfile): string {
  const provider = detectProvider(profile.baseURL);
  const providerMessage = upstreamErrorMessage(data);
  const key = normalizeApiKey(profile.apiKey, profile.authMode);
  let guidance = `HTTP ${status}`;
  if (status === 401) {
    guidance = !key || profile.authMode === 'none'
      ? `HTTP 401：${provider?.label ?? '端点'}需要认证，请填写 API Key`
      : `HTTP 401：${provider?.label ?? '端点'}拒绝了自动认证，请确认 API Key 有效、未过期且具有接口权限`;
  } else if (status === 403) {
    guidance = `HTTP 403：认证已到达端点，但当前密钥或账号没有访问权限`;
  } else if (status === 429) {
    guidance = 'HTTP 429：请求受到限流或账户配额不足';
  }
  return providerMessage ? `${guidance}；服务端：${providerMessage}` : guidance;
}

export function evaluateValidation(capability: CapabilityKey, response: ProxyResponse): { value: 'supported' | 'unknown'; confidence: 'high' | 'medium'; detail: string } {
  let observed = false;
  if (capability === 'supportsTools') observed = hasToolCall(response.data);
  else if (capability === 'supportsJsonMode' || capability === 'supportsStructuredOutput') observed = isJsonOutput(response.data);
  else if (capability === 'supportsStreaming') observed = response.headers['content-type']?.includes('text/event-stream') || (typeof response.data === 'string' && /(^|\n)data:/.test(response.data));
  else return { value: 'unknown', confidence: 'medium', detail: '服务端接受了参数，但单次最小请求无法确认参数是否实际生效' };
  return observed
    ? { value: 'supported', confidence: 'high', detail: '请求成功并观察到预期响应结构' }
    : { value: 'unknown', confidence: 'medium', detail: '请求成功，但未观察到预期响应结构；参数可能被忽略' };
}

export function mergeValidationEvidence(
  previous: CapabilityStatus,
  result: { value: 'supported' | 'unsupported' | 'unknown'; confidence: 'high' | 'medium' | 'unknown'; detail: string },
): CapabilityStatus {
  const item = evidence('validated', result.confidence, result.detail);
  if (result.value === 'unknown' && previous.value !== 'unknown') {
    return { ...previous, evidence: [...previous.evidence, item] };
  }
  return { value: result.value, evidence: [...previous.evidence, item] };
}

type RunUpdate = (run: DiscoveryRun) => void;

function updateStep(run: DiscoveryRun, id: string, patch: Partial<DiscoveryStep>): void {
  const step = run.steps.find((item) => item.id === id);
  if (step) Object.assign(step, patch);
}

function publicURL(profile: EndpointProfile, path: string): string {
  return `${profile.baseURL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

async function makeRequest(
  run: DiscoveryRun,
  stepId: string,
  endpointToken: string,
  profile: EndpointProfile,
  request: { method: 'GET' | 'POST'; path: string; body?: unknown; headers?: Record<string, string> },
  signal: AbortSignal,
  onUpdate: RunUpdate,
) {
  const id = uid();
  const headers = mergeHeaders(request.headers);
  const secrets = [profile.apiKey, normalizeApiKey(profile.apiKey, profile.authMode)].filter(Boolean);
  const record: RequestRecord = {
    id,
    stepId,
    method: request.method,
    url: publicURL(profile, request.path),
    requestHeaders: redactHeaders(headers, secrets),
    requestBody: sanitizeData(request.body, secrets),
    timestamp: new Date().toISOString(),
  };
  run.requests.push(record);
  run.steps.find((item) => item.id === stepId)?.requestIds.push(id);
  onUpdate(structuredClone(run));
  try {
    let response: Awaited<ReturnType<typeof proxyRequest>> | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await proxyRequest({
          endpointToken,
          path: request.path,
          method: request.method,
          headers,
          body: request.body,
          timeoutMs: profile.timeoutMs,
        }, signal);
        if (response.status < 500 || attempt === 1) break;
        record.retryCount = 1;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ProbeError && error.type === 'network' && attempt === 0 && !signal.aborted;
        if (!retryable) throw error;
        record.retryCount = 1;
      }
    }
    if (!response) throw lastError instanceof Error ? lastError : new ProbeError('请求失败', 'network');
    record.status = response.status;
    record.finalURL = response.finalURL;
    record.durationMs = response.durationMs;
    record.responseBytes = response.responseBytes;
    record.responsePreview = sanitizeData(summarizeResponse(response.data), secrets);
    if (!response.ok) {
      const errorType = ((response as unknown as { errorType?: ProbeErrorType }).errorType || 'network');
      const message = describeHttpFailure(response.status, response.data, profile);
      record.errorType = errorType;
      record.errorMessage = message;
      throw new ProbeError(message, errorType, response.status, response.data);
    }
    return response;
  } catch (error) {
    const probeError = error instanceof ProbeError ? error : new ProbeError('请求失败', 'network');
    record.errorType = probeError.type;
    record.errorMessage = redactText(probeError.message, secrets);
    throw probeError;
  } finally {
    onUpdate(structuredClone(run));
  }
}

export async function discover(
  profile: EndpointProfile,
  signal: AbortSignal,
  onUpdate: RunUpdate,
): Promise<DiscoveryRun> {
  const run = createRun(profile.id);
  onUpdate(structuredClone(run));
  try {
    updateStep(run, 'connectivity', { status: 'running', startedAt: new Date().toISOString() });
    const submittedURL = profile.baseURL.trim();
    try { new URL(submittedURL); } catch {
      throw new ProbeError('baseURL 无效，请包含 http:// 或 https://', 'invalid_url');
    }
    profile = { ...profile, baseURL: submittedURL };
    const automaticProtocol = profile.protocol === 'auto';
    const authorization = await authorizeEndpoint(profile, signal);
    profile = authorization.profile;
    run.endpointName = profile.name;
    run.endpointBaseURL = profile.baseURL;
    run.endpointQueryParams = profile.queryParams;
    const endpointToken = authorization.endpointToken;
    const provider = detectProvider(profile.baseURL);
    updateStep(run, 'connectivity', {
      status: profile.baseURL.startsWith('https:') ? 'success' : 'warning',
      summary: profile.baseURL.startsWith('https:') ? `已授权 ${profile.baseURL}` : `HTTP 未加密：${profile.baseURL}`,
      completedAt: new Date().toISOString(),
    });

    let authenticationFailed = false;
    updateStep(run, 'authentication', { status: 'running', startedAt: new Date().toISOString() });
    const normalizedKey = normalizeApiKey(profile.apiKey, profile.authMode);
    if (provider?.authenticationRequest && normalizedKey && profile.authMode !== 'none') {
      try {
        const response = await makeRequest(run, 'authentication', endpointToken, profile, provider.authenticationRequest, signal, onUpdate);
        updateStep(run, 'authentication', {
          status: 'success', summary: `${provider.label} API Key 验证成功（HTTP ${response.status}）`, completedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (error instanceof ProbeError && error.type === 'cancelled') throw error;
        authenticationFailed = true;
        updateStep(run, 'authentication', {
          status: 'error', summary: error instanceof Error ? error.message : `${provider.label} 认证失败`, completedAt: new Date().toISOString(),
        });
      }
    } else if (!normalizedKey || profile.authMode === 'none') {
      updateStep(run, 'authentication', {
        status: 'warning',
        summary: provider?.id === 'openrouter'
          ? '未提供 OpenRouter API Key；模型目录仍可发现，但主动能力验证需要有效密钥'
          : '未配置 API Key；仅可探测允许匿名访问的端点',
        completedAt: new Date().toISOString(),
      });
    } else {
      updateStep(run, 'authentication', {
        status: 'success', summary: '认证 Header 已安全构造，将由只读模型端点验证', completedAt: new Date().toISOString(),
      });
    }

    updateStep(run, 'protocol', { status: 'running', startedAt: new Date().toISOString() });
    const fallbackCandidates = adapterCandidates(automaticProtocol ? 'auto' : profile.protocol);
    const preferredAdapter = automaticProtocol && provider ? adapterFor(profile.protocol) : undefined;
    const candidates = preferredAdapter
      ? [preferredAdapter, ...fallbackCandidates.filter((item) => item.id !== preferredAdapter.id)]
      : fallbackCandidates;
    let selected: ProtocolAdapter | undefined;
    let payload: unknown;
    let lastDiscoveryError: ProbeError | undefined;
    const attempted = new Set<string>();
    for (const adapter of candidates) {
      for (const request of adapter.discoveryRequests(profile.baseURL)) {
        const key = `${request.method}:${request.path}`;
        if (attempted.has(key)) continue;
        attempted.add(key);
        try {
          const response = await makeRequest(run, 'protocol', endpointToken, profile, request, signal, onUpdate);
          const recognizer = automaticProtocol
            ? candidates.find((item) => item.recognizes(response.data))
            : adapter;
          if (recognizer) {
            selected = recognizer;
            payload = response.data;
            break;
          }
        } catch (error) {
          if (error instanceof ProbeError && error.type === 'cancelled') throw error;
          if (error instanceof ProbeError) lastDiscoveryError = error;
        }
      }
      if (selected) break;
    }
    if (!selected) throw lastDiscoveryError ?? new ProbeError('未识别到兼容的模型列表响应', 'format');
    run.protocol = selected.id;
    updateStep(run, 'protocol', {
      status: 'success', summary: `识别为 ${selected.label}${provider ? `（${provider.label}）` : ''}`, completedAt: new Date().toISOString(),
    });

    updateStep(run, 'models', { status: 'running', startedAt: new Date().toISOString() });
    const models = selected.parseModels(payload).map((model) => ({
      ...model,
      ...(provider ? {
        discoverySource: `${provider.label} ${model.discoverySource}`,
        supportedEndpoints: provider.supportedEndpoints ?? model.supportedEndpoints,
      } : {}),
      ...(automaticProtocol && provider ? { protocol: profile.protocol } : {}),
      rawMetadata: sanitizeData(model.rawMetadata, [profile.apiKey]),
    }));
    if (!models.length) throw new ProbeError('响应有效，但未发现模型', 'format');
    run.models = models;
    updateStep(run, 'models', {
      status: 'success', summary: `发现 ${models.length} 个模型`, completedAt: new Date().toISOString(),
    });
    updateStep(run, 'capabilities', {
      status: 'success', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      summary: '已归一化声明与推测证据；主动验证仍为独立操作',
    });
    run.status = authenticationFailed ? 'partial' : 'success';
    run.completedAt = new Date().toISOString();
  } catch (error) {
    const probeError = error instanceof ProbeError ? error : new ProbeError('探测失败', 'network');
    const running = run.steps.find((step) => step.status === 'running');
    if (running) Object.assign(running, { status: probeError.type === 'cancelled' ? 'cancelled' : 'error', summary: probeError.message, completedAt: new Date().toISOString() });
    run.status = probeError.type === 'cancelled' ? 'cancelled' : 'error';
    run.completedAt = new Date().toISOString();
  }
  for (const step of run.steps) {
    if (step.startedAt && step.completedAt) step.durationMs = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
    if (run.status === 'cancelled' && step.status === 'pending') step.status = 'cancelled';
  }
  onUpdate(structuredClone(run));
  return run;
}

async function pooled<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor++;
      results[index] = await jobs[index]();
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

export async function validateModel(
  profile: EndpointProfile,
  model: DiscoveredModel,
  capabilities: CapabilityKey[],
  signal: AbortSignal,
  onRequest?: (request: RequestRecord) => void,
): Promise<DiscoveredModel> {
  if (!profile.allowValidation) throw new ProbeError('请先启用主动验证', 'blocked');
  const next = structuredClone(model);
  next.status = 'validating';
  const authorization = await authorizeEndpoint(profile, signal);
  profile = authorization.profile;
  const endpointToken = authorization.endpointToken;
  const adapter = adapterFor(model.protocol);
  const run = createRun(profile.id);
  try {
    await pooled(capabilities.map((capability) => async () => {
    const request = adapter.buildValidationRequest(model.id, capability);
    if (!request) {
      next.capabilities[capability] = mergeValidationEvidence(next.capabilities[capability], { value: 'unknown', confidence: 'unknown', detail: '当前协议没有安全的最小验证方法' });
      return;
    }
    try {
      const response = await makeRequest(run, 'capabilities', endpointToken, profile, request, signal, () => {
        const latest = run.requests.at(-1);
        if (latest) onRequest?.(structuredClone(latest));
      });
      const outcome = evaluateValidation(capability, response);
      next.capabilities[capability] = mergeValidationEvidence(next.capabilities[capability], { ...outcome, detail: `${outcome.detail}（${request.method} ${request.path}）` });
    } catch (error) {
      const probe = error instanceof ProbeError ? error : new ProbeError('验证失败', 'network');
      if (probe.type === 'cancelled') throw probe;
      const explicitlyRejected = probe.status === 400 || probe.status === 422;
      next.capabilities[capability] = mergeValidationEvidence(next.capabilities[capability], explicitlyRejected
        ? { value: 'unsupported', confidence: 'medium', detail: `服务端明确拒绝参数：${probe.message}` }
        : { value: 'unknown', confidence: 'unknown', detail: `无法判断：${probe.message}` });
    }
    }), 2);
    next.status = 'validated';
  } catch (error) {
    if (!signal.aborted) throw error;
    next.status = 'partial';
  }
  next.lastProbedAt = new Date().toISOString();
  next.confidence = modelConfidence(next);
  return next;
}
