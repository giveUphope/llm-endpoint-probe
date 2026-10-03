import { adapterCandidates, adapterFor } from '../adapters';
import {
  ENDPOINT_TYPE_PROTOCOL,
  GENERATION_INTERFACE_TYPES,
  PROBE_FAKE_MODEL_ID,
  TOOLS_PROBE_NAME,
  buildGenerationProbe,
  classifyGenerationShape,
  extractEchoedModel,
  imageConsistencyFlags,
  interfaceLabel,
  sameModelName,
  type GenerationShape,
} from '../adapters/shared';
import {
  conformsToOkSchema,
  contentText,
  evaluateStopFromOutcome,
  hasReasoningContent,
  hasToolCall,
  interpretExplicitRejection,
  isEventStream,
  parsesAsJsonObject,
  visibleText,
  type ProbeGroup,
  type ProbeOutcome as SlotOutcome,
  type ProbeOutcomes,
  type ProbeSlot,
  type ProbeVerdict,
} from '../adapters/probe';
import { capabilityKeys, evidence, modelConfidence } from '../domain/capabilities';
import type {
  AdapterRequest,
  CapabilityKey,
  CapabilityStatus,
  DiscoveryRun,
  DiscoveryStep,
  DiscoveredModel,
  EndpointProfile,
  EvidenceSource,
  GenerationCheck,
  GenerationInterfaceCheck,
  ModelNameCheck,
  ProbeErrorType,
  ProtocolAdapter,
  ProtocolType,
  ProxyResponse,
  RequestRecord,
} from '../domain/types';
import { mergeHeaders, normalizeApiKey, redactHeaders, redactText, sanitizeData } from '../lib/security';
import { buildPreview } from '../lib/preview';
import { canValidateWithoutKey, detectProvider } from '../lib/providers';
import { uid } from '../lib/profile';
import { authorizeEndpoint, ProbeError, proxyRequest } from './proxy';

export { interpretExplicitRejection };

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

// 弱信号：回应（含推理通道）中提及探测工具名，说明端点处理了工具选择；
// 这比真正的 tool_calls 弱，但强于“参数可能被忽略”，专门覆盖只把输出写进推理通道的模型。
// 仅当探测提示词本身不含工具名时成立（Chat 与 Responses 的探测提示词都满足）
function mentionsToolInvocation(data: unknown, toolName: string): boolean {
  return visibleText(data).text.includes(toolName);
}

// 双探测比较：temperature / top_p 用不同参数值发两次请求，seed 用相同 seed 发两次请求
// temperature/top_p：输出不同→参数生效；seed：输出相同→随机种子生效
function evaluateDualProbe(capability: CapabilityKey, responses: ProxyResponse[]): ProbeVerdict {
  const outputs = responses.map((response) => visibleText(response.data).text);
  const nonEmpty = outputs.filter((text) => text.length > 0);
  if (nonEmpty.length < 2) {
    if (nonEmpty.length === 0) {
      return { value: 'unknown', confidence: 'medium', detail: '两次探测响应输出均为空，无法比较输出差异' };
    }
    return { value: 'unknown', confidence: 'medium', detail: '其中一次探测响应输出为空，无法比较输出差异' };
  }
  const identical = outputs[0] === outputs[1];
  if (capability === 'supportsSeed') {
    return {
      value: identical ? 'supported' : 'unknown',
      confidence: 'high',
      detail: identical
        ? '相同 seed 下两次请求返回相同输出：随机种子生效'
        : '相同 seed 下两次请求返回不同输出：随机种子可能被忽略',
    };
  }
  return {
    value: !identical ? 'supported' : 'unknown',
    confidence: 'medium',
    detail: !identical
      ? '不同参数值下返回不同输出：参数实际生效'
      : '不同参数值下返回相同输出：单次短响应不足以判定参数是否生效',
  };
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

export interface UpstreamErrorClassification {
  kind: 'model_unavailable' | 'auth' | 'rate_limit' | 'balance' | 'server' | 'other';
  label: string;
}

// 识别中转网关（New API / one-api 等）与通用上游的结构化错误，用于把“名称是否真实”的结论落到具体原因
export function classifyUpstreamError(data: unknown, status: number): UpstreamErrorClassification {
  if (status === 401 || status === 403) return { kind: 'auth', label: '认证被拒绝' };
  if (status === 429) return { kind: 'rate_limit', label: '请求受限或限流' };
  if (status >= 500) return { kind: 'server', label: '服务端错误' };
  const root = record(data);
  const error = record(root?.error);
  const type = typeof error?.type === 'string' ? error.type : typeof root?.type === 'string' ? root.type : '';
  const message = typeof error?.message === 'string'
    ? error.message
    : typeof root?.message === 'string' ? root.message : typeof root?.detail === 'string' ? root.detail : '';
  const combined = `${type} ${message}`;
  if (/new_api_error/i.test(type) || /模型不存在|无可用渠道|当前分组|没有可用|model.*not.*found|no.*channel/i.test(combined)) {
    return { kind: 'model_unavailable', label: '网关判定该模型不存在或无可用渠道' };
  }
  if (/余额不足|额度不足|insufficient.*balance|quota/i.test(combined)) return { kind: 'balance', label: '账户余额或额度不足' };
  if (/限流|频率|rate.?limit/i.test(combined)) return { kind: 'rate_limit', label: '请求受限或限流' };
  return { kind: 'other', label: message ? `上游拒绝：${message.slice(0, 120)}` : '上游拒绝请求' };
}

// 目录声明的接口类型 → 协议；cohere/ollama/manual 等作为默认单接口
const INTERFACE_PROTOCOL: Record<string, ProtocolType> = {
  ...ENDPOINT_TYPE_PROTOCOL,
  cohere: 'cohere',
  ollama: 'ollama',
  manual: 'manual',
  llamacpp: 'llamacpp',
  auto: 'openai-compatible',
};

const PROTOCOL_INTERFACE_KEY: Record<string, string> = {
  'openai-compatible': 'openai',
  'openai-chat': 'openai',
  'openai-responses': 'openai-response',
  anthropic: 'anthropic',
  gemini: 'gemini',
  cohere: 'cohere',
  ollama: 'ollama',
  manual: 'manual',
  llamacpp: 'llamacpp',
};

// 模型实际可测的接口集合：默认来自识别出的协议，目录声明（endpointTypes）可追加更多接口
export function modelInterfaces(model: DiscoveredModel): string[] {
  const fromProtocol = PROTOCOL_INTERFACE_KEY[model.protocol] ?? model.protocol;
  const declared = (model.endpointTypes ?? []).filter((type) => type in INTERFACE_PROTOCOL);
  return [...new Set([fromProtocol, ...declared].filter((key): key is string => Boolean(key)))];
}

// 其中能构造最小探测请求的接口（用于验证对话框的请求数估计）
export function modelProbeInterfaces(model: DiscoveredModel): string[] {
  return modelInterfaces(model).filter((key) => Boolean(adapterFor(INTERFACE_PROTOCOL[key] ?? model.protocol).buildValidationRequest(PROBE_FAKE_MODEL_ID, 'supportsTemperature')));
}

// 模型声明且可做最小生成探测的绘图/音乐/视频接口
export function modelGenerationInterfaces(model: DiscoveredModel): string[] {
  const probeable = GENERATION_INTERFACE_TYPES as readonly string[];
  return (model.endpointTypes ?? []).filter((type) => probeable.includes(type));
}

export interface ProbeEstimate {
  chat: number;
  generation: number;
  total: number;
  /** 合并探测：请求数与勾选的能力数量不再成线性关系 */
  merged: boolean;
}

// 请求数预估必须由探测计划本身推导，不能在 UI 里另写一套算法：
// 合并探测下“勾 5 个能力”与“勾 9 个能力”可能都是同样的 8 次请求，
// 而失败升级（400 后的单参数回退、思考吃满预算后的重试）不计入预估，只在结果里如实呈现
export function estimateProbeRequests(model: DiscoveredModel, capabilities: CapabilityKey[]): ProbeEstimate {
  const chatInterfaces = modelInterfaces(model);
  let chat = 0;
  let merged = false;
  for (const interfaceKey of chatInterfaces) {
    const adapter = adapterFor(INTERFACE_PROTOCOL[interfaceKey] ?? model.protocol);
    const plan = adapter.buildProbePlan?.(model.id, capabilities);
    if (plan) {
      merged = true;
      chat += plan.groups.reduce((sum, group) => sum + group.slots.length, 0) + (plan.nameProbe ? 1 : 0);
      continue;
    }
    for (const capability of capabilities) {
      const requests = adapter.buildValidationRequest(model.id, capability);
      chat += Array.isArray(requests) ? requests.length : requests ? 1 : 0;
    }
    if (adapter.buildValidationRequest(PROBE_FAKE_MODEL_ID, 'supportsTemperature')) chat += 1;
  }
  const generation = modelGenerationInterfaces(model).length * 2;
  return { chat, generation, total: chat + generation, merged };
}

export function buildNameCheck(
  requestedId: string,
  echoes: string[],
  probe: { accepted?: boolean; modelId: string; rejection?: string } | undefined,
  checkedAt = new Date().toISOString(),
  extra: { interfaces?: string[]; generationCheck?: GenerationCheck } = {},
): ModelNameCheck {
  const check: ModelNameCheck = { checkedAt };
  if (extra.interfaces?.length) check.interfaces = extra.interfaces;
  if (extra.generationCheck) check.generationCheck = extra.generationCheck;
  const unique = [...new Set(echoes.map((echo) => echo.trim()).filter(Boolean))];
  const mismatched = unique.find((echo) => !sameModelName(echo, requestedId));
  if (mismatched) {
    check.echoedModelId = mismatched;
    check.aliased = true;
  } else if (unique.length) {
    check.echoedModelId = unique[0];
    check.aliased = false;
  }
  if (probe) {
    check.probeModelId = probe.modelId;
    if (probe.accepted !== undefined) check.acceptsUnknownNames = probe.accepted;
    if (probe.rejection) check.probeRejection = probe.rejection;
  }
  return check;
}

// 汇总各接口的虚假名探测结果：429 限流（accepted=undefined）不参与判定；
// 排除限流后，任一接口放行即整体宽松；全部拒绝则严格，优先给出“模型不存在”类原因；
// 若所有结果均为限流则保持未知，不做出确定性结论
export function aggregateProbe(outcomes: Array<{ accepted?: boolean; rejection?: string }>): { accepted?: boolean; rejection?: string } | undefined {
  if (!outcomes.length) return undefined;
  const definite = outcomes.filter((item) => item.accepted !== undefined);
  if (!definite.length) return undefined;
  if (definite.some((item) => item.accepted === true)) return { accepted: true };
  const rejections = definite.filter((item) => item.accepted === false);
  if (rejections.length === definite.length) {
    const unavailable = rejections.find((item) => /不存在|无可用渠道/.test(item.rejection ?? ''));
    return { accepted: false, rejection: unavailable?.rejection ?? rejections[0]?.rejection };
  }
  return { accepted: undefined };
}

// 逐能力验证的判定（未提供合并探测计划的协议仍走这条路）。
// 内容类观测（工具调用 / JSON / 结构化输出）只认内容通道：推理文本里出现 JSON
// 只说明模型想到了 JSON，不能说明服务端施加了约束
export function evaluateValidation(capability: CapabilityKey, response: ProxyResponse | ProxyResponse[]): ProbeVerdict {
  // 结构化输出支持“严格 schema + 基础 json_object 回退”双请求：任一命中即支持
  if (capability === 'supportsStructuredOutput' && Array.isArray(response) && response.length >= 2) {
    const hit = response.some((resp) => conformsToOkSchema(contentText(resp.data)));
    return hit
      ? { value: 'supported', confidence: 'high', detail: '请求成功并观察到符合 schema 的结构化输出' }
      : { value: 'unknown', confidence: 'medium', detail: '请求成功，但严格 schema 与基础 JSON 回退均未返回符合结构的输出' };
  }
  if (Array.isArray(response) && response.length >= 2) return evaluateDualProbe(capability, response);
  const single = Array.isArray(response) ? response[0] : response;
  if (!single) return { value: 'unknown', confidence: 'medium', detail: '未收到探测响应' };
  if (capability === 'supportsStop') {
    return evaluateStopFromOutcome({ ok: single.ok, status: single.status, data: single.data, headers: single.headers });
  }
  let observed = false;
  if (capability === 'supportsTools') observed = hasToolCall(single.data);
  else if (capability === 'supportsJsonMode') observed = parsesAsJsonObject(contentText(single.data));
  else if (capability === 'supportsStructuredOutput') observed = conformsToOkSchema(contentText(single.data));
  else if (capability === 'supportsStreaming') observed = isEventStream({ ok: single.ok, status: single.status, data: single.data, headers: single.headers });
  else if (capability === 'supportsReasoning') observed = hasReasoningContent(single.data);
  else return { value: 'unknown', confidence: 'medium', detail: '服务端接受了参数，但单次最小请求无法确认参数是否实际生效' };
  // tools 的弱信号：输出（含推理通道）中提及探测工具名，说明端点处理了工具选择（比忽略强，比真正调用弱）
  if (capability === 'supportsTools' && !observed && mentionsToolInvocation(single.data, TOOLS_PROBE_NAME)) {
    return { value: 'supported', confidence: 'medium', detail: '响应中提及探测工具名，说明端点处理了工具选择但未产生 tool_calls 数组' };
  }
  return observed
    ? { value: 'supported', confidence: 'high', detail: '请求成功并观察到预期响应结构' }
    : { value: 'unknown', confidence: 'medium', detail: '请求成功，但未观察到预期响应结构；参数可能被忽略' };
}

export function mergeValidationEvidence(
  previous: CapabilityStatus,
  result: { value: 'supported' | 'unsupported' | 'unknown'; confidence: 'high' | 'medium' | 'unknown'; detail: string; source?: EvidenceSource },
): CapabilityStatus {
  const item = evidence(result.source ?? 'validated', result.confidence, result.detail);
  // 验证产出真实证据后，移除能力矩阵里陈旧的“尚未探测”占位
  const retained = previous.evidence.filter((entry) => entry.source !== 'unknown' || entry.detail !== '尚未探测');
  if (result.value === 'unknown' && previous.value !== 'unknown') {
    return { ...previous, evidence: [...retained, item] };
  }
  return { value: result.value, evidence: [...retained, item] };
}

// 拒绝语义解释（interpretExplicitRejection）已随合并探测评估一起移到 adapters/probe.ts，
// 这里保留同名再导出，旧的引用方无需改动
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
    record.responsePreview = sanitizeData(response.preview ?? buildPreview(response.data), secrets);
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
    const authorization = await authorizeEndpoint(profile, signal);
    profile = authorization.profile;
    // 自动识别必须依据“授权后实际生效的协议”：服务端会用 URL 规则与厂商预设改写协议，
    // 若沿用授权前的值，就会出现“候选列表按 auto 展开、识别分支却按手动协议跳过 recognizes”
    // 的错配——那样列表里第一个适配器（gemini）会被无条件采纳
    const automaticProtocol = profile.protocol === 'auto';
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
    // 授权后协议已由服务端解析：'auto' 才需要逐个候选试探，否则只跑被指定的那一个
    const candidates = adapterCandidates(automaticProtocol ? 'auto' : profile.protocol);
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
    // 探测即验证：默认自动执行全部能力与名称真实性校验，覆盖所有发现的模型（不设上限）。
    // 模型之间顺序执行、单模型内部并发，可随时取消；这里只判断“能不能验证”
    const plan = planAutoValidation({
      models: run.models,
      hasKey: Boolean(normalizeApiKey(profile.apiKey, profile.authMode)),
      providerRequiresKey: Boolean(provider) && !canValidateWithoutKey(profile, provider),
      authenticationFailed,
    });
    if (plan.reason) {
      updateStep(run, 'capabilities', {
        status: 'warning', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        summary: plan.reason === 'auth-failed'
          ? `认证未通过：跳过 ${plan.blocked.length} 个模型的主动验证，能力结论仅为目录声明`
          : `免密目录可读但生成接口需要凭据：跳过 ${plan.blocked.length} 个模型的主动验证，能力结论仅为目录声明`,
      });
    } else {
      updateStep(run, 'capabilities', {
        status: 'running', startedAt: new Date().toISOString(),
        summary: `自动验证 0/${plan.targets.length} 个模型`,
      });
      let validatedCount = 0;
      let validationFailures = 0;
      for (let index = 0; index < plan.targets.length; index += 1) {
        const target = plan.targets[index];
        updateStep(run, 'capabilities', { summary: `自动验证 ${index + 1}/${plan.targets.length}：${target.id}` });
        onUpdate(structuredClone(run));
        const validated = await validateModel(
          profile,
          target,
          capabilityKeys,
          signal,
          (request) => {
            if (run.requests.some((item) => item.id === request.id)) return;
            run.requests.push(request);
            onUpdate(structuredClone(run));
          },
          { profile, endpointToken },
        ).catch((error: unknown) => {
          if (error instanceof ProbeError && error.type === 'cancelled') throw error;
          validationFailures += 1;
          return undefined;
        });
        if (!validated) continue;
        run.models = run.models.map((model) => (model.id === validated.id ? validated : model));
        validatedCount += 1;
        onUpdate(structuredClone(run));
      }
      updateStep(run, 'capabilities', {
        status: validationFailures ? 'warning' : 'success',
        completedAt: new Date().toISOString(),
        summary: validationFailures
          ? `${validatedCount}/${plan.targets.length} 个模型验证完成，${validationFailures} 个中断`
          : `已自动验证 ${validatedCount} 个模型的全部能力（含名称真实性校验）`,
      });
    }
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

interface ProbeOutcome { accepted?: boolean; echo?: string; rejection?: string; shape?: GenerationShape; contentHash?: string }

// 轻量内容指纹：排除 id/timestamp/status 等非确定性字段后对响应结构做哈希，
// 用于判断真实名与虚假名请求是否返回了相同的上游输出（非确定性字段被排除，
// 因此仅当响应内容确实一致时才匹配，非确定性内容自动判为不匹配）
function contentHash(data: unknown): string {
  const root = data && typeof data === 'object' ? data as Record<string, unknown> : data;
  if (!root || typeof root !== 'object') return typeof data === 'string' ? data.slice(0, 80) : '';
  const stripped: Record<string, unknown> = { ...root };
  for (const key of ['id', 'timestamp', 'created', 'created_at']) {
    if (key in stripped) delete stripped[key];
  }
  return JSON.stringify(stripped).slice(0, 200);
}

// 单次最小探测：2xx 视为接受；4xx（429 除外）记录拒绝原因；网络层失败视为未确认
async function probeOnce(
  run: DiscoveryRun,
  endpointToken: string,
  profile: EndpointProfile,
  request: AdapterRequest,
  signal: AbortSignal,
  onRequest?: (request: RequestRecord) => void,
): Promise<ProbeOutcome> {
  try {
    const response = await makeRequest(run, 'capabilities', endpointToken, profile, request, signal, () => {
      const latest = run.requests.at(-1);
      if (latest) onRequest?.(structuredClone(latest));
    });
    return { accepted: response.ok, echo: extractEchoedModel(response.data), shape: classifyGenerationShape(response.data), contentHash: contentHash(response.data) };
  } catch (error) {
    if (error instanceof ProbeError && error.type === 'cancelled') throw error;
    if (error instanceof ProbeError && error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
      return { accepted: false, rejection: classifyUpstreamError(error.details ?? error.message, error.status).label };
    }
    return { accepted: undefined };
  }
}

// 自动验证的前置条件：验证默认自动执行并覆盖全部发现的模型，不设数量上限。
// 这里只处理“能不能验证”：认证已失败、或需要凭据的远端厂商没有凭据时整批跳过，
// 避免成片 401 换回一堆无意义 unknown —— 那类模型的跳过后仍可由用户显式继续。
export interface AutoValidationPlan {
  targets: DiscoveredModel[];
  blocked: DiscoveredModel[];
  reason?: 'keyless' | 'auth-failed';
}

export function planAutoValidation(input: {
  models: DiscoveredModel[];
  hasKey: boolean;
  providerRequiresKey: boolean;
  authenticationFailed: boolean;
}): AutoValidationPlan {
  const pending = input.models.filter((model) => model.status !== 'validated');
  if (input.authenticationFailed) return { targets: [], blocked: pending, reason: 'auth-failed' };
  if (!input.hasKey && input.providerRequiresKey) return { targets: [], blocked: pending, reason: 'keyless' };
  return { targets: pending, blocked: [] };
}

// 执行一个合并探测组：先并发跑第一阶段槽位，再按第一阶段结果决定是否升级（如 400 后的单参数回退）。
// 观测结果一律转成数据而不是异常，交给纯函数评估；只有取消继续向上抛出
async function runProbeGroup(
  run: DiscoveryRun,
  endpointToken: string,
  profile: EndpointProfile,
  group: ProbeGroup,
  signal: AbortSignal,
  onRequest?: (request: RequestRecord) => void,
): Promise<ProbeOutcomes> {
  const outcomes = await runSlots(group.slots);
  const followUps = group.escalate?.(outcomes) ?? [];
  if (followUps.length) Object.assign(outcomes, await runSlots(followUps));
  return outcomes;

  async function runSlots(slots: ProbeSlot[]): Promise<ProbeOutcomes> {
    const settled = await Promise.allSettled(slots.map(async (slot) => {
      try {
        const response = await makeRequest(run, 'capabilities', endpointToken, profile, slot.request, signal, () => {
          const latest = run.requests.at(-1);
          if (latest) onRequest?.(structuredClone(latest));
        });
        return { name: slot.name, outcome: { ok: true, status: response.status, data: response.data, headers: response.headers } as SlotOutcome };
      } catch (error) {
        if (error instanceof ProbeError && error.type === 'cancelled') throw error;
        const probe = error instanceof ProbeError ? error : new ProbeError('探测失败', 'network');
        return {
          name: slot.name,
          outcome: { ok: false, status: probe.status, data: probe.details, errorType: probe.type, errorMessage: probe.message } as SlotOutcome,
        };
      }
    }));
    const cancelled = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
    if (cancelled) throw cancelled.reason;
    const collected: ProbeOutcomes = {};
    for (const item of settled) {
      if (item.status === 'fulfilled') collected[item.value.name] = item.value.outcome;
    }
    return collected;
  }
}

export async function validateModel(
  profile: EndpointProfile,
  model: DiscoveredModel,
  capabilities: CapabilityKey[],
  signal: AbortSignal,
  onRequest?: (request: RequestRecord) => void,
  // 探测流程已经授权过端点时复用同一 token，避免每个模型都重新申请一次会话
  preAuthorized?: { profile: EndpointProfile; endpointToken: string },
): Promise<DiscoveredModel> {
  const next = structuredClone(model);
  next.status = 'validating';
  let workingProfile = profile;
  let endpointToken: string;
  if (preAuthorized) {
    workingProfile = preAuthorized.profile;
    endpointToken = preAuthorized.endpointToken;
  } else {
    const authorization = await authorizeEndpoint(profile, signal);
    workingProfile = authorization.profile;
    endpointToken = authorization.endpointToken;
  }
  profile = workingProfile;
  const chatInterfaces = modelInterfaces(model);
  const generationInterfaces = modelGenerationInterfaces(model);
  const run = createRun(profile.id);
  const echoes: string[] = [];
  const probeOutcomes: Array<{ accepted?: boolean; rejection?: string }> = [];
  const generationDetails: GenerationInterfaceCheck[] = [];
  try {
    const jobs: Array<() => Promise<void>> = [];
    for (const interfaceKey of chatInterfaces) {
      const adapter = adapterFor(INTERFACE_PROTOCOL[interfaceKey] ?? model.protocol);
      const interfaceNote = chatInterfaces.length > 1 ? `（${interfaceLabel(interfaceKey)}）` : '';
      const plan = adapter.buildProbePlan?.(model.id, capabilities) ?? null;
      if (plan) {
        // 合并探测：一组请求产出多个能力结论，请求数从“每能力 1~2 次”降到典型 7 次。
        // 计划未覆盖的能力（如 supportsPromptCache）保留“无可用的最小验证方法”占位
        const covered = new Set(plan.groups.flatMap((group) => group.capabilities));
        for (const capability of capabilities) {
          if (covered.has(capability)) continue;
          next.capabilities[capability] = mergeValidationEvidence(next.capabilities[capability], {
            value: 'unknown', confidence: 'unknown', detail: `当前协议没有安全的最小验证方法${interfaceNote}`,
          });
        }
        for (const group of plan.groups) {
          jobs.push(async () => {
            const outcomes = await runProbeGroup(run, endpointToken, profile, group, signal, onRequest);
            const verdicts = group.evaluate(outcomes);
            for (const capability of group.capabilities) {
              const verdict = verdicts[capability]
                ?? { value: 'unknown' as const, confidence: 'unknown' as const, detail: '合并探测组未给出该能力的结论' };
              next.capabilities[capability] = mergeValidationEvidence(next.capabilities[capability], {
                ...verdict, detail: `${verdict.detail}${interfaceNote}`,
              });
            }
          });
        }
        // 名称真实性探测：计划给出最小请求，不再复用 256 token 的采样请求
        const nameProbe = plan.nameProbe;
        if (nameProbe) {
          jobs.push(async () => {
            const outcome = await probeOnce(run, endpointToken, profile, nameProbe, signal, onRequest);
            if (outcome.accepted !== undefined || outcome.rejection) probeOutcomes.push({ accepted: outcome.accepted, rejection: outcome.rejection });
          });
        }
        continue;
      }
      for (const capability of capabilities) {
        jobs.push(async () => {
          const requests = adapter.buildValidationRequest(model.id, capability);
          if (!requests) {
            next.capabilities[capability] = mergeValidationEvidence(next.capabilities[capability], { value: 'unknown', confidence: 'unknown', detail: `当前协议没有安全的最小验证方法${interfaceNote}` });
            return;
          }
          try {
            const requestList = Array.isArray(requests) ? requests : [requests];
            const results = await Promise.allSettled(requestList.map((req) => makeRequest(run, 'capabilities', endpointToken, profile, req, signal, () => {
              const latest = run.requests.at(-1);
              if (latest) onRequest?.(structuredClone(latest));
            })));
            const responses = results
              .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
              .map((result) => result.value);
            const rejected = results
              .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
              .map((result) => result.reason);
            responses.forEach((response) => {
              const echoed = extractEchoedModel(response.data);
              if (echoed) echoes.push(echoed);
            });
            const methodAndPath = `${requestList[0].method} ${requestList[0].path}`;
            let outcome: { value: 'supported' | 'unsupported' | 'unknown'; confidence: 'high' | 'medium' | 'unknown'; detail: string };
            if (responses.length === requestList.length) {
              outcome = evaluateValidation(capability, responses);
            } else {
              const firstError = rejected[0];
              const probe = firstError instanceof ProbeError ? firstError : (firstError instanceof Error ? new ProbeError(firstError.message, 'network') : new ProbeError('探测失败', 'network'));
              if (probe.type === 'cancelled') throw probe;
              const explicitlyRejected = probe.status === 400 || probe.status === 422;
              outcome = explicitlyRejected
                ? interpretExplicitRejection(capability, probe.message, interfaceNote)
                : { value: 'unknown', confidence: 'unknown', detail: `仅完成 ${responses.length}/${requestList.length} 次探测，无法比较输出差异：${probe.message}` };
            }
            next.capabilities[capability] = mergeValidationEvidence(next.capabilities[capability], { ...outcome, detail: `${outcome.detail}（${methodAndPath}${interfaceNote}）` });
          } catch (error) {
            const probe = error instanceof ProbeError ? error : new ProbeError('验证失败', 'network');
            if (probe.type === 'cancelled') throw probe;
            const explicitlyRejected = probe.status === 400 || probe.status === 422;
            next.capabilities[capability] = mergeValidationEvidence(next.capabilities[capability], explicitlyRejected
              ? interpretExplicitRejection(capability, probe.message, interfaceNote)
              : { value: 'unknown', confidence: 'unknown', detail: `无法判断${interfaceNote}：${probe.message}` });
          }
        });
      }
      // 对话类名称真实性探测：用虚假模型名发一次最小请求，判断网关是否对未知名称静默放行
      const probeRequests = adapter.buildValidationRequest(PROBE_FAKE_MODEL_ID, 'supportsTemperature');
      if (probeRequests) {
        const probeRequest = Array.isArray(probeRequests) ? probeRequests[0] : probeRequests;
        jobs.push(async () => {
          const outcome = await probeOnce(run, endpointToken, profile, probeRequest, signal, onRequest);
          if (outcome.accepted !== undefined || outcome.rejection) probeOutcomes.push({ accepted: outcome.accepted, rejection: outcome.rejection });
        });
      }
    }
    // 生成类接口（绘图/音乐/视频）名称一致性：真实名与虚假名各发一次最小生成请求
    for (const interfaceType of generationInterfaces) {
      jobs.push(async () => {
        const fakeRequest = buildGenerationProbe(interfaceType, PROBE_FAKE_MODEL_ID);
        const realRequest = buildGenerationProbe(interfaceType, model.id);
        if (!fakeRequest || !realRequest) return;
        const fake = await probeOnce(run, endpointToken, profile, fakeRequest, signal, onRequest);
        const real = await probeOnce(run, endpointToken, profile, realRequest, signal, onRequest);
        const detail: GenerationInterfaceCheck = {
          interface: interfaceType,
          realAccepted: real.accepted === true,
          fakeAccepted: fake.accepted === true,
        };
        if (real.echo) {
          detail.echo = real.echo;
          echoes.push(real.echo);
        }
        if (real.rejection) detail.rejection = real.rejection;
        if (real.shape) {
          detail.realShape = real.shape.family;
          Object.assign(detail, imageConsistencyFlags(real.shape));
        }
        if (fake.shape) detail.fakeShape = fake.shape.family;
        if (real.shape && fake.shape) detail.shapeConsistent = real.shape.family === fake.shape.family;
        if (real.contentHash && fake.contentHash && real.contentHash.length > 10 && fake.contentHash.length > 10) {
          detail.contentMatch = real.contentHash === fake.contentHash;
        }
        generationDetails.push(detail);
      });
    }
    await pooled(jobs, 2);
    next.status = 'validated';
  } catch (error) {
    if (!signal.aborted) throw error;
    next.status = 'partial';
  }
  const probeVerdict = aggregateProbe(probeOutcomes);
  const generationCheck: GenerationCheck | undefined = generationDetails.length
    ? {
        interfaces: generationDetails.map((detail) => detail.interface),
        nameServed: generationDetails.every((detail) => detail.realAccepted),
        permissive: generationDetails.some((detail) => detail.fakeAccepted),
        details: generationDetails,
      }
    : undefined;
  next.nameCheck = buildNameCheck(
    model.id,
    echoes,
    probeVerdict ? { ...probeVerdict, modelId: PROBE_FAKE_MODEL_ID } : undefined,
    new Date().toISOString(),
    {
      interfaces: [...chatInterfaces, ...generationInterfaces],
      generationCheck,
    },
  );
  next.lastProbedAt = new Date().toISOString();
  next.confidence = modelConfidence(next);
  return next;
}
