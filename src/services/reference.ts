import { PARAMETER_CAPABILITIES } from '../adapters/shared';
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

// —— 名称归一化 ——
const TIER_SUFFIX = /:([a-z][a-z0-9-]*)$/;

// 档位词：既可能写成 `:free` 后缀，也可能混在名字尾段里
const TIER_TOKENS = new Set(['free', 'batch', 'extended', 'standard', 'online']);

// 形态词：有无这些词不改变“同一权重家族”这一事实。只收录公认无区分度的词——
// mini / pro / vl / vision / audio / coder / math / flash / large 都会改变型号，绝不收录
const FLAVOR_TOKENS = new Set(['instruct', 'instruction', 'chat', 'it', 'nl', 'base', 'latest', 'stable', 'lts', 'beta', 'exp', 'thinking', 'reasoning', 'text']);

const SEPARATORS = /[-._\s:/\\]+/g;
// 日期形态（2024、20240513、2024-05-13）：版本快照与基准名是同一种型号，不该被当成两个型号
const DATE_SEQUENCE = /(?:19|20)\d{2}(?:-?(?:0[1-9]|1[0-2])(?:-?(?:0[1-9]|[12]\d|3[1]))?)?/g;
// 量化/打包标记只反映本地部署形态，不是型号差异
const QUANT_MARKER = /(?:^|[-_ ])(?:q\d+(?:[-_][a-z0-9]+)*|fp(?:16|32)(?:[-_][a-z0-9]+)*|bf16|int[248](?:[-_]p)?|gguf|ggml|awq|gptq|mlc|mlx|ned)(?:$|[-_ ])/g;

export function normalizeReferenceId(id: string): string {
  return id.trim().toLowerCase().replace(/^~/, '').replace(TIER_SUFFIX, '');
}

function tierOf(id: string): string | undefined {
  return TIER_SUFFIX.exec(id.trim())?.[1];
}

function tailOf(base: string): string {
  return base.includes('/') ? base.slice(base.lastIndexOf('/') + 1) : base;
}

// 把任意写法的型号名折成可比较的词集合：统一分隔符、拆字母/数字边界、去掉日期与量化标记、
// 去掉 v 前缀和形态词。目标是让 `Qwen2.5-Coder-7B-Instruct`、`qwen2.5-coder-7b`、
// `qwen/qwen-2.5-coder-7b-instruct:free` 落到同一个词集合，同时保留尺寸与子型号词，
// 使 7b / 72b / coder / vl 之间永远不会互相匹配
function nameWords(name: string): string[] {
  const dashed = name.toLowerCase().replace(SEPARATORS, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const stripped = dashed.replace(DATE_SEQUENCE, '').replace(QUANT_MARKER, '-');
  const parts = stripped
    .replace(/([a-z])(\d)/g, '$1-$2')
    .replace(/(\d)([a-z])/g, '$1-$2')
    .split('-')
    .map((token) => token.replace(/^v(?=\d)/, ''))
    .filter((token) => token && !FLAVOR_TOKENS.has(token));
  return [...new Set(parts)];
}

interface ParsedName {
  vendorKey: string;
  vendorWords: string[];
  coreKey: string;
  coreWords: string[];
}

function keyOfWords(words: string[]): string {
  return [...new Set(words)].sort().join(' ');
}

// provider 前缀单独留下：既用于强度判定，也用于容忍 `Meta-Llama-3.1-8B`
// 这种把厂商名重复进型号名的写法（多出来的厂商词不算另一种型号）
function parseModelName(raw: string): ParsedName {
  const value = raw.trim().toLowerCase().replace(/^~/, '');
  const tierWord = tierOf(value);
  const withoutTier = value.replace(TIER_SUFFIX, '');
  const slash = withoutTier.lastIndexOf('/');
  const vendorPart = slash >= 0 ? withoutTier.slice(0, slash) : '';
  const namePart = slash >= 0 ? withoutTier.slice(slash + 1) : withoutTier;
  const words = nameWords(namePart).filter((word) => !TIER_TOKENS.has(word));
  // `llama3.1:8b` 这类 Ollama 风格 tag 里带着尺寸信息，必须并进词集合，
  // 否则 8b 请求会匹配到同家族的 70b 条目
  const kept = tierWord && !TIER_TOKENS.has(tierWord) ? [...new Set([...words, ...nameWords(tierWord)])] : words;
  const vendorWords = vendorPart ? nameWords(vendorPart) : [];
  return {
    vendorKey: keyOfWords(vendorWords),
    vendorWords,
    coreKey: keyOfWords(kept),
    coreWords: kept,
  };
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
  const canonicalSlug = typeof item.canonical_slug === 'string' && item.canonical_slug.trim()
    ? normalizeReferenceId(item.canonical_slug)
    : undefined;
  const aliasTargetRecord = record(item.alias_target);
  const aliasTarget = typeof aliasTargetRecord?.slug === 'string' && aliasTargetRecord.slug.trim()
    ? aliasTargetRecord.slug.trim()
    : undefined;
  const tier = tierOf(id);
  const contextWindow = positiveInt(item.context_length);
  return {
    id,
    ...(name ? { name } : {}),
    ...(aliasTarget ? { alias: true, aliasTarget } : {}),
    ...(canonicalSlug ? { canonicalSlug } : {}),
    ...(tier ? { tier } : {}),
    ...(contextWindow != null ? { contextWindow } : {}),
    inputModalities,
    ...(supportedParameters ? { supportedParameters } : {}),
    reasoningLevels,
  };
}

// 把 OpenRouter 公开目录响应归一化为参照目录；无效条目跳过而不是中断整次比对
export function parseReferenceCatalog(payload: unknown, url: string, fetchedAt: string): ReferenceCatalog {
  const root = record(payload);
  // 容忍两种信封：代理直接给出条目数组，或原样透传上游的 { data: [...] }
  const nested = record(root?.data);
  const entries = Array.isArray(root?.data) ? root.data : Array.isArray(nested?.data) ? nested.data : undefined;
  if (!entries) throw new ProbeError('参照目录响应缺少 data 数组', 'format');
  const models = entries
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
  const payload = await response.json().catch(() => ({})) as {
    url?: unknown; fetchedAt?: unknown; data?: unknown; error?: string; stale?: unknown; staleReason?: unknown;
  };
  if (!response.ok) throw new ProbeError(payload.error || `参照目录服务返回 HTTP ${response.status}`, 'network', response.status);
  if (typeof payload.url !== 'string' || typeof payload.fetchedAt !== 'string') {
    throw new ProbeError('参照目录响应缺少来源或时间戳', 'format');
  }
  const catalog = parseReferenceCatalog(payload, payload.url, payload.fetchedAt);
  // 上游不可用时代理会回退到过期快照：保留降级原因供展示层说明，参照仍然只是参照
  return payload.stale === true
    ? { ...catalog, stale: true, ...(typeof payload.staleReason === 'string' ? { staleReason: payload.staleReason } : {}) }
    : catalog;
}

// —— 参照目录索引 ——
// 详情面板每次渲染都要定位参照条目；全目录 460+ 条逐条归一化比对纯属浪费。
// 索引挂在 catalog 对象上（WeakMap），换一次快照自然重建，无需手动失效
interface ReferenceGroup {
  key: string;
  vendorKey: string;
  vendorWords: string[];
  coreKey: string;
  coreWords: string[];
  entries: ReferenceModelEntry[];
  label: string;
}

interface ReferenceIndex {
  byVendorCore: Map<string, ReferenceGroup>;
  byCore: Map<string, ReferenceGroup[]>;
  byNormalizedId: Map<string, ReferenceGroup[]>;
}

const indexByCatalog = new WeakMap<ReferenceCatalog, ReferenceIndex>();

// 档位排序：主档优先，其次目录里 id 就等于 canonical_slug 的规范条目，最后按 id 字典序，
// 保证同一端点多次比对选出的代表条目一致
function variantRank(entry: ReferenceModelEntry): number {
  if (entry.tier) return 2;
  if (entry.canonicalSlug && entry.canonicalSlug === normalizeReferenceId(entry.id)) return 0;
  return 1;
}

function sortVariants(entries: ReferenceModelEntry[]): ReferenceModelEntry[] {
  return entries.slice().sort((left, right) => variantRank(left) - variantRank(right) || left.id.localeCompare(right.id));
}

function buildReferenceIndex(catalog: ReferenceCatalog): ReferenceIndex {
  const byVendorCore = new Map<string, ReferenceGroup>();
  const byCore = new Map<string, ReferenceGroup[]>();
  for (const entry of catalog.models) {
    const parsed = parseModelName(entry.id);
    if (!parsed.coreKey) continue;
    const key = `${parsed.vendorKey}\u0000${parsed.coreKey}`;
    let group = byVendorCore.get(key);
    if (!group) {
      group = { key, ...parsed, entries: [], label: tailOf(normalizeReferenceId(entry.id)) };
      byVendorCore.set(key, group);
      byCore.set(parsed.coreKey, [...(byCore.get(parsed.coreKey) ?? []), group]);
    }
    group.entries.push(entry);
  }
  for (const group of byVendorCore.values()) group.entries = sortVariants(group.entries);
  // 别名条目跳转用：按归一化 id 索引，`~vendor/model-latest` 能找到真实上架条目
  const byNormalizedId = new Map<string, ReferenceGroup[]>();
  for (const group of byVendorCore.values()) {
    for (const entry of group.entries) {
      const normalized = normalizeReferenceId(entry.id);
      byNormalizedId.set(normalized, [...(byNormalizedId.get(normalized) ?? []), group]);
    }
  }
  return { byVendorCore, byCore, byNormalizedId };
}

function referenceIndex(catalog: ReferenceCatalog): ReferenceIndex {
  const existing = indexByCatalog.get(catalog);
  if (existing) return existing;
  const built = buildReferenceIndex(catalog);
  indexByCatalog.set(catalog, built);
  return built;
}

// 候选词集合：允许端点名比参照名多/少至多两个“厂商词级别”的差异，
// 由 collectHits 再校验这些差集是否真能由 provider 前缀解释；
// 尺寸、子型号、模态词永远不在容忍范围内
function candidateKeys(parsed: ParsedName): string[] {
  const keys = new Set<string>([parsed.coreKey]);
  const words = parsed.coreWords;
  for (let i = 0; i < words.length; i += 1) {
    keys.add(keyOfWords(words.filter((_, index) => index !== i)));
    for (let j = i + 1; j < words.length; j += 1) {
      keys.add(keyOfWords(words.filter((_, index) => index !== i && index !== j)));
    }
  }
  for (const word of parsed.vendorWords) keys.add(keyOfWords([...words, word]));
  return [...keys].filter((key) => key.length > 0);
}

// 强度：4 = provider 与型号词都相符；3 = 型号词相符（provider 不同或端点未写 provider）；
// 2 = 词集合差集能被对方的 provider 前缀解释（`Meta-Llama-3.1-8B` 这类回显写法）
interface GroupHit {
  group: ReferenceGroup;
  strength: number;
}

function collectHits(parsed: ParsedName, index: ReferenceIndex): GroupHit[] {
  const endpointWords = new Set(parsed.coreWords);
  const hits = new Map<string, GroupHit>();
  for (const key of candidateKeys(parsed)) {
    const exactVendor = index.byVendorCore.get(`${parsed.vendorKey}\u0000${key}`);
    const groups = exactVendor ? [exactVendor] : index.byCore.get(key) ?? [];
    for (const group of groups) {
      const groupWords = new Set(group.coreWords);
      const endpointExtra = parsed.coreWords.filter((word) => !groupWords.has(word));
      const groupExtra = group.coreWords.filter((word) => !endpointWords.has(word));
      if (endpointExtra.length && !endpointExtra.every((word) => group.vendorWords.includes(word))) continue;
      if (groupExtra.length && !groupExtra.every((word) => parsed.vendorWords.includes(word))) continue;
      const sameVendor = Boolean(parsed.vendorKey) && parsed.vendorKey === group.vendorKey;
      const exact = !endpointExtra.length && !groupExtra.length;
      const strength = exact && sameVendor ? 4 : exact ? 3 : 2;
      const seen = hits.get(group.key);
      if (!seen || seen.strength < strength) hits.set(group.key, { group, strength });
    }
  }
  return [...hits.values()];
}

export interface ReferenceMatch {
  entry: ReferenceModelEntry;
  variants: ReferenceModelEntry[];
  /** 只能靠 provider 前缀解释词差、且命中了多个互不相同的条目：参照侧不再单独下结论 */
  ambiguous: boolean;
  /** 歧义时未被选为代表的那些条目，供展示与人工判断 */
  otherGroups: string[];
  /** 同名条目来自多少个不同 provider：能力声明按并集保守取值 */
  providerCount: number;
}

// 别名条目常常只带名字与跳转目标、不带能力声明：此时顺着 alias_target 把真实条目的声明并进来，
// 否则 `vendor/model-latest` 这类端点名只能得到“参照未覆盖”
function expandAliasTargets(
  variants: ReferenceModelEntry[],
  index: ReferenceIndex,
): ReferenceModelEntry[] {
  const bare = variants.filter((variant) => variant.aliasTarget && variant.supportedParameters === undefined);
  if (!bare.length) return variants;
  const extra = bare.flatMap((variant) => (index.byNormalizedId.get(normalizeReferenceId(variant.aliasTarget ?? '')) ?? [])
    .flatMap((group) => group.entries));
  const merged = extra.filter((entry) => !variants.includes(entry));
  return merged.length ? sortVariants([...variants, ...merged]) : variants;
}

export function matchReference(model: DiscoveredModel, catalog: ReferenceCatalog): ReferenceMatch | undefined {
  const parsed = parseModelName(model.id);
  if (!parsed.coreKey) return undefined;
  const index = referenceIndex(catalog);
  const hits = collectHits(parsed, index);
  if (!hits.length) return undefined;
  const bestStrength = Math.max(...hits.map((hit) => hit.strength));
  const winners = hits.filter((hit) => hit.strength === bestStrength);
  // 同名不同 provider 是同一个型号的多个上架条目：合并成一份参照，
  // 声明取并集（保守方向，不会凭空造出冲突），并在展示里说明合并范围
  const variants = expandAliasTargets(sortVariants(winners.flatMap((hit) => hit.group.entries)), index);
  if (!variants.length) return undefined;
  const weakMultiHit = bestStrength <= 2 && winners.length > 1;
  return {
    entry: variants[0],
    variants,
    ambiguous: weakMultiHit,
    otherGroups: weakMultiHit
      ? winners.slice(1).map((hit) => hit.group.entries[0]?.id ?? hit.group.label)
      : [...new Set(winners.map((hit) => hit.group.entries[0]?.id).filter((id): id is string => Boolean(id)))].slice(1),
    providerCount: new Set(variants.map((variant) => parseModelName(variant.id).vendorKey)).size,
  };
}

export type ConflictSeverity = 'validated-over-declaration' | 'declaration-divergence';

export interface ReferenceRow {
  key: CapabilityKey;
  label: string;
  local: CapabilityValue;
  reference: CapabilityValue;
  /** 参照只在部分同名条目里声明支持：不足以推翻端点的“不支持”结论 */
  partial: boolean;
  supportingListings: number;
  conflict: boolean;
  /** 冲突强度：端点已实测 vs 两侧都只是声明 */
  severity?: ConflictSeverity;
}

export interface ReferenceReasoningVerdict {
  local: string[];
  reference: string[];
  covered: boolean;
  referenceOnly: string[];
  localOnly: string[];
}

export interface ReferenceComparison {
  entry: ReferenceModelEntry;
  /** 参与合并声明的同型号条目（含代表条目本身） */
  variants: ReferenceModelEntry[];
  ambiguous: boolean;
  otherGroups: string[];
  providerCount: number;
  rows: ReferenceRow[];
  contextConflict: boolean;
  /** 参照各条目声明的上下文窗口，用于判定端点值是否落在其中 */
  contextTiers: number[];
  localContextWindow?: number;
  referenceContextWindow?: number;
  /** 端点声明了参照没有的模态才算冲突；参照声明更广只作提示 */
  modalityConflict: boolean;
  referenceOnlyModalities: InputModality[];
  localModalities: InputModality[];
  referenceModalities: InputModality[];
  reasoning: ReferenceReasoningVerdict;
  conflictCount: number;
  /** 端点侧已有实测证据、参照声明与之相左：通常意味着参照声明过时或被裁剪 */
  validatedConflicts: number;
  /** 两侧都只是声明：谁更可信要靠实测决定 */
  declaredConflicts: number;
}

function definitive(value: CapabilityValue): boolean {
  return value === 'supported' || value === 'unsupported';
}

// 端点侧这条结论的证据强度：只有真实验证请求算“实测”，目录声明与规则推测都不算
function localSeverity(model: DiscoveredModel, key: CapabilityKey): ConflictSeverity {
  return model.capabilities[key].evidence.some((item) => item.source === 'validated')
    ? 'validated-over-declaration'
    : 'declaration-divergence';
}

// 端点结论 vs 参照目录声明的逐能力比对：
// 只有两侧都给出确定结论且不同时才标记冲突；参照缺失一律 unknown，绝不写成“不支持”
export function compareReference(model: DiscoveredModel, target: ReferenceModelEntry | ReferenceMatch): ReferenceComparison {
  const match: ReferenceMatch = 'entry' in target
    ? target
    : { entry: target, variants: [target], ambiguous: false, otherGroups: [], providerCount: 1 };
  const { entry, variants, ambiguous, otherGroups, providerCount } = match;
  // 任一同名条目声明支持即视为参照支持：档位与多 provider 上架是计费/渠道变体，
  // 窄档位不代表型号不支持；反过来“不支持”要求所有声明过参数的条目都没列出它
  const reasoningLevels = [...new Set(variants.flatMap((variant) => variant.reasoningLevels))];
  const localReasoningLevels = [...new Set(model.reasoningLevels)];
  const localContextWindow = model.contextWindow;
  const contextTiers = [...new Set(variants.map((variant) => variant.contextWindow).filter((value): value is number => value != null))];
  const localModalities = [...new Set(model.inputModalities)];
  const referenceModalities = [...new Set(variants.flatMap((variant) => variant.inputModalities))];
  const rows: ReferenceRow[] = (Object.keys(capabilityLabels) as CapabilityKey[]).map((key) => {
    const local = model.capabilities[key].value;
    const parameters = PARAMETER_CAPABILITIES[key];
    const excluded = NOT_DECLARED_IN_REFERENCE.includes(key);
    // Reasoning 除了参数名还看 supported_efforts：有些条目只列档位不列参数
    const declares = (variant: ReferenceModelEntry) => Array.isArray(variant.supportedParameters)
      || (key === 'supportsReasoning' && variant.reasoningLevels.length > 0);
    const supports = (variant: ReferenceModelEntry) => Boolean(
      variant.supportedParameters?.some((parameter) => parameters.includes(parameter)),
    ) || (key === 'supportsReasoning' && variant.reasoningLevels.length > 0);
    const declaringListings = excluded ? 0 : variants.filter(declares).length;
    const supportingListings = excluded ? 0 : variants.filter(supports).length;
    const covered = declaringListings > 0;
    // “不支持”必须所有声明过的条目都没列；只有一部分条目列了就算 partial，
    // 不足以据此推翻端点的“不支持”结论
    const reference: CapabilityValue = !covered ? 'unknown' : supportingListings > 0 ? 'supported' : 'unsupported';
    const partial = reference === 'supported' && supportingListings < declaringListings;
    const conflict = !ambiguous && definitive(local) && definitive(reference) && local !== reference
      && !(local === 'unsupported' && partial);
    return {
      key,
      label: capabilityLabels[key],
      local,
      reference,
      partial,
      supportingListings,
      conflict,
      ...(conflict ? { severity: localSeverity(model, key) } : {}),
    };
  });
  const contextConflict = !ambiguous
    && localContextWindow != null && contextTiers.length > 0 && !contextTiers.includes(localContextWindow);
  const modalityConflict = !ambiguous && localModalities.length > 0 && referenceModalities.length > 0
    && localModalities.some((item) => !referenceModalities.includes(item));
  return {
    entry,
    variants,
    ambiguous,
    otherGroups,
    providerCount,
    rows,
    contextConflict,
    contextTiers,
    ...(localContextWindow != null ? { localContextWindow } : {}),
    ...(entry.contextWindow != null ? { referenceContextWindow: entry.contextWindow } : {}),
    modalityConflict,
    referenceOnlyModalities: referenceModalities.filter((item) => !localModalities.includes(item)),
    localModalities,
    referenceModalities,
    reasoning: {
      local: localReasoningLevels,
      reference: reasoningLevels,
      covered: reasoningLevels.length > 0,
      referenceOnly: reasoningLevels.filter((level) => !localReasoningLevels.includes(level)),
      localOnly: localReasoningLevels.filter((level) => !reasoningLevels.includes(level)),
    },
    conflictCount: rows.filter((row) => row.conflict).length,
    validatedConflicts: rows.filter((row) => row.conflict && row.severity === 'validated-over-declaration').length,
    declaredConflicts: rows.filter((row) => row.conflict && row.severity === 'declaration-divergence').length,
  };
}

export type ReferenceState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalog: ReferenceCatalog };
