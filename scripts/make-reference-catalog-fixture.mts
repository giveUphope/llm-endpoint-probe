/**
 * 参照目录基准样本生成器。
 *
 * src/services/reference.catalog.sample.json 是参照匹配的回归基准（档位上架、别名条目、
 * 多 provider 分组），真实目录会持续漂移，因此这个脚本保留在仓库里用于再生成：
 *
 *   curl -o .tmp-or-models.json https://openrouter.ai/api/v1/models
 *   npm run fixture:reference            # 或 npx tsx scripts/make-reference-catalog-fixture.mts <快照> <输出>
 *
 * 只保留比对真正读取的字段，并且一律原样取自快照（不做任何名称清洗），
 * 这样样本失配时可以直接归因到匹配逻辑，而不是生成器。
 */
import { readFileSync, writeFileSync } from 'node:fs';

type RawModel = Record<string, unknown>;

const SNAPSHOT_PATH = process.argv[2] ?? '.tmp-or-models.json';
const OUTPUT_PATH = process.argv[3] ?? 'src/services/reference.catalog.sample.json';
const MAX_ENTRIES = 260;
const MAX_BYTES = 90_000;
const ENVELOPE_URL = 'https://openrouter.ai/api/v1/models';
const ENVELOPE_FETCHED_AT = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';

// 样本要覆盖的模型族（对 id 做子串匹配；快照里不存在的会被跳过并回报）
const NAME_TOKENS = [
  'gpt-4o', 'gpt-4o-mini', 'gpt-4', 'gpt-4.1', 'gpt-5', 'gpt-5.2', 'o3', 'o4-mini',
  'gpt-audio', 'claude-sonnet', 'claude-opus', 'claude-haiku', 'claude-fable', 'llama-3.1',
  'llama-3.2', 'llama-3.3', 'llama-4', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-r1',
  'deepseek-v', 'deepseek-coder', 'mistral-large', 'mistral-small', 'mistral-medium', 'ministral',
  'codestral', 'devstral', 'pixtral', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3',
  'qwen-2.5', 'qwen2.5', 'qwen3', 'qwq', 'qwen-vl', 'gemma', 'phi-4', 'phi-3', 'command-r',
  'minimax', 'kimi', 'glm', 'grok', 'nemotron', 'whisper', 'nomic-embed',
];

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as { data?: RawModel[] };
if (!Array.isArray(snapshot.data)) throw new Error(`快照缺少 data 数组：${SNAPSHOT_PATH}`);
const models = snapshot.data;

function slim(entry: RawModel): RawModel {
  const result: RawModel = {};
  if (typeof entry.id === 'string') result.id = entry.id;
  if (typeof entry.canonical_slug === 'string') result.canonical_slug = entry.canonical_slug;
  if (typeof entry.name === 'string') result.name = entry.name;
  if (typeof entry.context_length === 'number') result.context_length = entry.context_length;
  const architecture = entry.architecture as RawModel | null | undefined;
  if (architecture && Array.isArray(architecture.input_modalities)) {
    result.architecture = { input_modalities: architecture.input_modalities };
  }
  if (Array.isArray(entry.supported_parameters)) result.supported_parameters = entry.supported_parameters;
  const reasoning = entry.reasoning as RawModel | null | undefined;
  if (reasoning && Array.isArray(reasoning.supported_efforts)) {
    result.reasoning = { supported_efforts: reasoning.supported_efforts };
  }
  const alias = entry.alias_target as RawModel | null | undefined;
  if (alias && typeof alias.slug === 'string') result.alias_target = { slug: alias.slug };
  return result;
}

const groupCounts = new Map<string, number>();
for (const entry of models) {
  const slug = typeof entry.canonical_slug === 'string' ? entry.canonical_slug : '(missing)';
  groupCounts.set(slug, (groupCounts.get(slug) ?? 0) + 1);
}

// 优先级：档位上架 > 别名条目 > 多条目分组 > 模型族样本；体积超预算时从队尾裁
const rawMatches = { rule1: 0, rule2: 0, rule3: 0, rule4: 0 };
const priority = new Map<string, number>();
const familyOrder = new Map<string, number>();
for (const entry of models) {
  const id = entry.id;
  if (typeof id !== 'string') throw new Error('快照条目缺少字符串 id');
  const tiered = id.includes(':');
  const alias = entry.alias_target != null && typeof entry.alias_target === 'object';
  const grouped = (groupCounts.get(typeof entry.canonical_slug === 'string' ? entry.canonical_slug : '(missing)') ?? 0) > 1;
  if (tiered) rawMatches.rule1 += 1;
  if (alias) rawMatches.rule2 += 1;
  if (grouped) rawMatches.rule3 += 1;
  let rank = tiered ? 1 : alias ? 2 : grouped ? 3 : 0;
  const index = NAME_TOKENS.findIndex((token) => id.toLowerCase().includes(token));
  if (index >= 0) {
    rawMatches.rule4 += 1;
    familyOrder.set(id, index);
    if (rank === 0) rank = 4;
  }
  if (rank > 0) priority.set(id, rank);
}

const pool = [...priority.entries()].sort((left, right) => {
  if (left[1] !== right[1]) return left[1] - right[1];
  const orderLeft = left[1] === 4 ? (familyOrder.get(left[0]) ?? 0) : 0;
  const orderRight = right[1] === 4 ? (familyOrder.get(right[0]) ?? 0) : 0;
  if (orderLeft !== orderRight) return orderLeft - orderRight;
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
});

const slimById = new Map(models.map((entry) => [entry.id as string, slim(entry)]));

function serialize(ids: string[]): string {
  const entries = ids
    .map((id) => slimById.get(id)!)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  // 保持上游 { data: { data: [...] } } 嵌套信封：解析层必须同时容忍扁平与嵌套两种形状
  return JSON.stringify({ url: ENVELOPE_URL, fetchedAt: ENVELOPE_FETCHED_AT, data: { data: entries } });
}

let keep = Math.min(pool.length, MAX_ENTRIES);
let output = serialize(pool.slice(0, keep).map(([id]) => id));
while (keep > 1 && Buffer.byteLength(output + '\n', 'utf8') > MAX_BYTES) {
  keep -= 1;
  output = serialize(pool.slice(0, keep).map(([id]) => id));
}

writeFileSync(OUTPUT_PATH, output + '\n', 'utf8');
const written = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')) as { data: { data: RawModel[] } };
const kept = new Set(pool.slice(0, keep).map(([id]) => id));
const coverage = { tiered: 0, alias: 0, grouped: 0, family: 0 };
for (const id of kept) {
  const rank = priority.get(id)!;
  if (rank === 1) coverage.tiered += 1;
  else if (rank === 2) coverage.alias += 1;
  else if (rank === 3) coverage.grouped += 1;
  else coverage.family += 1;
}

console.log(JSON.stringify({
  snapshot: SNAPSHOT_PATH,
  output: OUTPUT_PATH,
  snapshotModels: models.length,
  rawMatches,
  droppedByBudget: pool.length - keep,
  coverage,
  finalEntries: written.data.data.length,
  bytes: Buffer.byteLength(output + '\n', 'utf8'),
  skippedNameTokens: NAME_TOKENS.filter((token) => !models.some((entry) => String(entry.id).toLowerCase().includes(token))),
}, null, 2));
