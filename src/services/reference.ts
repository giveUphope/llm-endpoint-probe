import { PARAMETER_CAPABILITIES, sameModelName } from '../adapters/shared';
import { capabilityLabels } from '../domain/capabilities';
import type {
  CapabilityKey,
  CapabilityValue,
  DiscoveredModel,
  InputModality,
  ReferenceCatalog,
  ReferenceModelEntry,
} from '../domain/types';
import { ProbeError } from './proxy';

// OpenRouter 公开模型目录的本地只读代理路由（固定白名单，服务端硬编码上游地址）
export const REFERENCE_ROUTE = '/api/reference/models';

// OpenRouter 的 supported_parameters 不覆盖传输层与缓存标记：
// 这两类能力在参照侧一律记为“参照未覆盖”(unknown)，不参与冲突判定
const NOT_DECLARED_IN_REFERENCE: CapabilityKey[] = ['supportsStreaming', 'supportsPromptCache'];

const INPUT_MODALITIES: InputModality[] = ['text', 'image', 'audio', 'video', 'pdf'];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// OpenRouter 条目 ID 形如 provider/model，可能带 :free / :batch 等分档后缀与 ~ 别名前缀；
// 匹配前统一剥离，避免把同一型号拆成多个候选
export function normalizeReferenceId(id: string): string {
  return id.trim().toLowerCase().replace(/^~/, '').replace(/:[a-z][a-z0-9-]*$/, '');
}

function idCandidates(id: string): string[] {
  const base = normalizeReferenceId(id);
  const tail = base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
  return [...new Set([base, tail])];
}

function parseEntry(raw: unknown): ReferenceModelEntry | undefined {
  const item = record(raw);
  const id = typeof item?.id === 'string' ? item.id.trim() : '';
  if (!item || !id) return undefined;
  const architecture = record(item.architecture);
  const modalitiesRaw = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : [];
  const parsedModalities = modalitiesRaw
    .map((value) => (value === 'file' ? 'pdf' : String(value)))
    .filter((value): value is InputModality => INPUT_MODALITIES.includes(value as InputModality));
  const inputModalities = [...new Set(parsedModalities.length ? parsedModalities : ['text' as const])];
  const supportedParameters = Array.isArray(item.supported_parameters)
    ? item.supported_parameters.map((value) => String(value).toLowerCase())
    : undefined;
  const reasoning = record(item.reasoning);
  const reasoningLevels = Array.isArray(reasoning?.supported_efforts)
    ? reasoning.supported_efforts.map((value) => String(value))
    : [];
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined;
  return {
    id,
    ...(name ? { name } : {}),
    ...(record(item.alias_target) ? { alias: true } : {}),
    ...(positiveInt(item.context_length) != null ? { contextWindow: positiveInt(item.context_length) } : {}),
    inputModalities,
    ...(supportedParameters ? { supportedParameters } : {}),
    reasoningLevels,
  };
}

// 把 OpenRouter 公开目录响应归一化为参照目录；无效条目跳过而不是中断整次比对
export function parseReferenceCatalog(payload: unknown, url: string, fetchedAt: string): ReferenceCatalog {
  const root = record(payload);
  if (!root || !Array.isArray(root.data)) throw new ProbeError('参照目录响应缺少 data 数组', 'format');
  const models = root.data
    .map(parseEntry)
    .filter((entry): entry is ReferenceModelEntry => Boolean(entry));
  if (!models.length) throw new ProbeError('参照目录中没有可用条目', 'format');
  return { source: 'openrouter', url, fetchedAt, models };
}

export async function fetchReferenceCatalog(signal?: AbortSignal): Promise<ReferenceCatalog> {
  let response: Response;
  try {
    response = await fetch(REFERENCE_ROUTE, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new ProbeError('参照目录获取已取消', 'cancelled');
    throw new ProbeError('参照目录获取失败：本地受控代理不可达', 'network', undefined, error);
  }
  const payload = await response.json().catch(() => ({})) as { url?: unknown; fetchedAt?: unknown; data?: unknown; error?: string };
  if (!response.ok) throw new ProbeError(payload.error || `参照目录服务返回 HTTP ${response.status}`, 'network', response.status);
  if (typeof payload.url !== 'string' || typeof payload.fetchedAt !== 'string') {
    throw new ProbeError('参照目录响应缺少来源或时间戳', 'format');
  }
  return parseReferenceCatalog(payload, payload.url, payload.fetchedAt);
}

// 在参照目录中定位端点发现的模型：先剥前缀/后缀归一化，再用 sameModelName 做版本号宽松匹配
export function matchReference(model: DiscoveredModel, catalog: ReferenceCatalog): ReferenceModelEntry | undefined {
  const candidates = idCandidates(model.id);
  for (const entry of catalog.models) {
    const entryCandidates = idCandidates(entry.id);
    if (entryCandidates.some((left) => candidates.some((right) => sameModelName(left, right)))) return entry;
  }
  return undefined;
}

export interface ReferenceRow {
  key: CapabilityKey;
  label: string;
  local: CapabilityValue;
  reference: CapabilityValue;
  conflict: boolean;
}

export interface ReferenceComparison {
  entry: ReferenceModelEntry;
  rows: ReferenceRow[];
  contextConflict: boolean;
  localContextWindow?: number;
  referenceContextWindow?: number;
  modalityConflict: boolean;
  localModalities: InputModality[];
  referenceModalities: InputModality[];
  conflictCount: number;
}

function definitive(value: CapabilityValue): boolean {
  return value === 'supported' || value === 'unsupported';
}

// 端点侧结论 vs 参照目录声明的逐能力比对：
// 只有两侧都给出确定结论且不同时才标记冲突；参照缺失一律 unknown，绝不写成“不支持”
export function compareReference(model: DiscoveredModel, entry: ReferenceModelEntry): ReferenceComparison {
  const declared = entry.supportedParameters ? new Set(entry.supportedParameters) : undefined;
  const rows: ReferenceRow[] = (Object.keys(capabilityLabels) as CapabilityKey[]).map((key) => {
    const local = model.capabilities[key].value;
    const covered = declared && !NOT_DECLARED_IN_REFERENCE.includes(key);
    const reference: CapabilityValue = !covered
      ? 'unknown'
      : [...declared].some((parameter) => PARAMETER_CAPABILITIES[key].includes(parameter)) ? 'supported' : 'unsupported';
    return {
      key,
      label: capabilityLabels[key],
      local,
      reference,
      conflict: definitive(local) && definitive(reference) && local !== reference,
    };
  });
  const localContextWindow = model.contextWindow;
  const referenceContextWindow = entry.contextWindow;
  const localModalities = [...new Set(model.inputModalities)];
  const referenceModalities = [...new Set(entry.inputModalities)];
  const modalityConflict = localModalities.length > 0 && referenceModalities.length > 0 &&
    (localModalities.some((item) => !referenceModalities.includes(item)) ||
      referenceModalities.some((item) => !localModalities.includes(item)));
  return {
    entry,
    rows,
    contextConflict: localContextWindow != null && referenceContextWindow != null && localContextWindow !== referenceContextWindow,
    ...(localContextWindow != null ? { localContextWindow } : {}),
    ...(referenceContextWindow != null ? { referenceContextWindow } : {}),
    modalityConflict,
    localModalities,
    referenceModalities,
    conflictCount: rows.filter((row) => row.conflict).length,
  };
}

export type ReferenceState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalog: ReferenceCatalog };
