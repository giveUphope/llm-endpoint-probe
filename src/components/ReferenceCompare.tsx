import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { capabilityValueLabels } from '../domain/capabilities';
import type { CapabilityValue, DiscoveredModel, ReferenceSource } from '../domain/types';
import { compareReference, matchReference, type ReferenceRow, type ReferenceState } from '../services/reference';

interface Props {
  model: DiscoveredModel;
  reference: ReferenceState;
  onRetry: () => void;
  /** 第二个只读参照源（models.dev）：undefined 表示尚未请求，切过去才拉取，避免每次探测都下载大目录 */
  modelsDev?: ReferenceState;
  onLoadModelsDev?: () => void;
}

const SOURCE_LABELS: Record<ReferenceSource, string> = { openrouter: 'OpenRouter', modelsdev: 'models.dev' };

// 两本目录能表达的字段面不同。说清覆盖面，是为了防止把“目录压根没这个字段”
// 读成“目录说不支持”——比对层的按来源限定（NOT_DECLARED_BY_SOURCE）在数据层已经保证了这点
const SOURCE_COVERAGE: Record<ReferenceSource, string> = {
  openrouter: '未覆盖 stream 与缓存标记',
  modelsdev: '没有 top_p / seed / stop / response_format / stream 字段',
};

type Tone = 'good' | 'bad' | 'info' | 'muted';

interface Verdict {
  text: string;
  tone: Tone;
}

function definitive(value: CapabilityValue): boolean {
  return value === 'supported' || value === 'unsupported';
}

// 比对结论：两侧都是确定结论才可能一致/冲突；参照缺失记为“参照未覆盖”，端点未验证记为“待端点验证”。
// 冲突按端点侧证据强度分级：已实测的结论优先于第三方声明（多为自己部署裁剪或参照目录过时），
// 两侧都只是声明时才是真正需要实测来分的“声明分歧”
function rowVerdict(row: ReferenceRow, ambiguous: boolean): Verdict {
  if (ambiguous) return { text: '匹配歧义', tone: 'muted' };
  if (row.conflict) {
    return row.severity === 'validated-over-declaration'
      ? { text: '实测优先', tone: 'info' }
      : { text: '声明分歧', tone: 'bad' };
  }
  if (row.local === 'unsupported' && row.reference === 'supported' && row.partial) {
    return { text: '参照部分声明', tone: 'muted' };
  }
  if (definitive(row.local) && definitive(row.reference)) return { text: '一致', tone: 'good' };
  if (row.reference === 'unknown') return { text: '参照未覆盖', tone: 'muted' };
  return { text: '待端点验证', tone: 'muted' };
}

function toneClass(tone: Tone): string {
  if (tone === 'good') return 'ref-match';
  if (tone === 'bad') return 'ref-conflict';
  if (tone === 'info') return 'ref-info';
  return 'ref-muted';
}

function referenceLabel(value: CapabilityValue): string {
  return value === 'unknown' ? '参照未覆盖' : capabilityValueLabels[value];
}

// 单个参照源的比对表：纯展示层，不写入模型证据链、不触发任何探测请求
function ReferenceSourceTable({ model, state, onRetry }: { model: DiscoveredModel; state: ReferenceState; onRetry: () => void }) {
  if (state.status === 'loading') {
    return <p className="ref-note">正在通过本地受控代理获取参照目录…</p>;
  }
  if (state.status === 'error') {
    return (
      <div className="ref-note warn">
        <span>参照目录不可用：{state.message}。参照不可用不会改变端点探测结论。</span>
        <button className="icon-button subtle" title="重新获取参照目录" onClick={onRetry}><RefreshCw size={14} /></button>
      </div>
    );
  }
  const { catalog } = state;
  const sourceLabel = SOURCE_LABELS[catalog.source];
  const match = matchReference(model, catalog);
  if (!match) {
    return <p className="ref-note">{sourceLabel} 公开目录中未匹配到「{model.id}」：无法交叉比对。参照缺失不代表该端点或模型不支持任何能力。</p>;
  }
  const comparison = compareReference(model, match);
  const { entry, variants, ambiguous, providerCount } = comparison;
  const tierList = variants.map((variant) => variant.tier ?? '主档');
  // 只有真出现档位时才用“档位合并”这套措辞：models.dev 没有档位概念，
  // 同名条目是几十份 provider 上架声明，标成“合并 N 个档位声明”是错的
  const hasTiers = variants.some((variant) => variant.tier);
  const snapshot = new Date(catalog.fetchedAt).toLocaleString('zh-CN', { hour12: false });
  const conflicts = [
    ambiguous ? `该名称在参照目录中匹配到 ${comparison.otherGroups.length + 1} 个不同条目（另含 ${comparison.otherGroups.join('、')}）` : '',
    comparison.conflictCount
      ? `${comparison.conflictCount} 项冲突（实测优先 ${comparison.validatedConflicts} 项、声明分歧 ${comparison.declaredConflicts} 项）`
      : '',
    comparison.contextConflict ? '上下文窗口不属于参照任一声明值' : '',
    comparison.modalityConflict ? '端点声明了参照未覆盖的输入模态' : '',
  ].filter(Boolean);
  const covered = comparison.rows.filter((row) => row.reference !== 'unknown').length;
  const mergeNote = [
    hasTiers && variants.length > 1 ? `已合并 ${variants.length} 个档位声明` : '',
    providerCount > 1 ? `同名条目来自 ${providerCount} 个 provider（声明取并集）` : '',
  ].filter(Boolean).join('，');
  const context = ambiguous
    ? { text: '匹配歧义', tone: 'muted' } as Verdict
    : comparison.localContextWindow == null
      ? { text: '待端点验证', tone: 'muted' } as Verdict
      : comparison.contextTiers.length === 0
        ? { text: '参照未覆盖', tone: 'muted' } as Verdict
        : comparison.contextConflict
          ? { text: '冲突', tone: 'info' } as Verdict
          : { text: '一致', tone: 'good' } as Verdict;
  const modalities = ambiguous
    ? { text: '匹配歧义', tone: 'muted' } as Verdict
    : comparison.modalityConflict
      ? { text: '冲突', tone: 'info' } as Verdict
      : comparison.localModalities.length === 0
        ? { text: '待端点验证', tone: 'muted' } as Verdict
        : comparison.referenceModalities.length === 0
          ? { text: '参照未覆盖', tone: 'muted' } as Verdict
          : comparison.referenceOnlyModalities.length > 0
            ? { text: '参照更广', tone: 'muted' } as Verdict
            : { text: '一致', tone: 'good' } as Verdict;
  const reasoning = comparison.reasoning;
  const reasoningVerdict = ambiguous
    ? { text: '匹配歧义', tone: 'muted' } as Verdict
    : !reasoning.covered
      ? { text: '参照未覆盖', tone: 'muted' } as Verdict
      : reasoning.local.length === 0
        ? { text: '待端点验证', tone: 'muted' } as Verdict
        : reasoning.localOnly.length > 0
          ? { text: '档位分歧', tone: 'info' } as Verdict
          : reasoning.referenceOnly.length > 0
            ? { text: '参照更广', tone: 'muted' } as Verdict
            : { text: '一致', tone: 'good' } as Verdict;
  return (
    <div className="ref-compare">
      {catalog.stale && <div className="ref-note warn"><span>参照快照来自过期缓存（{snapshot}）：{catalog.staleReason ?? '上游本次获取失败'}。降级快照只用于展示，不影响端点探测结论。</span></div>}
      <div className="name-check">
        <div className="name-check-row"><span>参照条目</span><code>{entry.id}{entry.name ? ` · ${entry.name}` : ''}</code></div>
        <div className="name-check-row"><span>目录快照</span><code>{snapshot}</code></div>
        {hasTiers && variants.length > 1 && <div className="name-check-row"><span>档位合并</span><code>{tierList.join(' / ')}</code></div>}
        {entry.alias && entry.aliasTarget && <div className="name-check-row"><span>别名指向</span><code>{entry.aliasTarget}</code></div>}
      </div>
            <p className="ref-note">以下为 {sourceLabel} 公开目录的第三方声明，仅用于与当前端点结果交叉比对；出现冲突时，以当前端点的实测（validated）证据为准。</p>
      {/* 覆盖度单独一行：解释“参照未覆盖”为什么出现，避免被读成“目录说该端点不支持” */}
      <p className="ref-note">{sourceLabel} {SOURCE_COVERAGE[catalog.source]}，这些能力在本表里一律记为“参照未覆盖”，不参与冲突判定。</p>
      {conflicts.length
        ? <div className="name-check-note warn">{conflicts.join('；')}：请结合两端证据判断是端点声明过时、参照声明过时，还是实际能力差异，不要单凭参照下结论。</div>
        : <div className="name-check-note good">端点结论与参照目录声明未发现冲突（参照覆盖 {covered} 项能力{mergeNote ? `，${mergeNote}` : ''}）。</div>}
      <div className="ref-table">
        <div className="ref-row ref-head"><span>能力</span><span>端点结论</span><span>参照声明</span><span>比对</span></div>
        {comparison.rows.map((row) => {
          const result = rowVerdict(row, ambiguous);
          return (
            <div className="ref-row" key={row.key}>
              <span className="ref-label">{row.label}</span>
              <span className="ref-value">{capabilityValueLabels[row.local]}</span>
              <span className="ref-value">
                {referenceLabel(row.reference)}
                {row.partial && row.reference === 'supported' && <em className="ref-sub">{row.supportingListings}/{variants.length} 个条目声明</em>}
              </span>
              <span className={toneClass(result.tone)}>{result.text}</span>
            </div>
          );
        })}
        <div className="ref-row">
          <span className="ref-label">上下文窗口</span>
          <span className="ref-value">{comparison.localContextWindow?.toLocaleString() ?? '未知'}</span>
          <span className="ref-value">
            {comparison.referenceContextWindow?.toLocaleString() ?? (comparison.contextTiers.length ? comparison.contextTiers[0].toLocaleString() : '参照未覆盖')}
            {comparison.contextTiers.length > 1 && <em className="ref-sub">声明值 {comparison.contextTiers.map((value) => value.toLocaleString()).join(' / ')}</em>}
          </span>
          <span className={toneClass(context.tone)}>{context.text}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">输入模态</span>
          <span className="ref-value">{comparison.localModalities.join(' / ') || '—'}</span>
          <span className="ref-value">
            {comparison.referenceModalities.join(' / ') || '—'}
            {comparison.referenceOnlyModalities.length > 0 && <em className="ref-sub">参照另声明 {comparison.referenceOnlyModalities.join(' / ')}</em>}
          </span>
          <span className={toneClass(modalities.tone)}>{modalities.text}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">Reasoning 档位</span>
          <span className="ref-value">{reasoning.local.join(' / ') || '—'}</span>
          <span className="ref-value">
            {reasoning.reference.join(' / ') || '—'}
            {reasoning.referenceOnly.length > 0 && <em className="ref-sub">参照另声明 {reasoning.referenceOnly.join(' / ')}</em>}
          </span>
          <span className={toneClass(reasoningVerdict.tone)}>{reasoningVerdict.text}</span>
        </div>
      </div>
    </div>
  );
}

// 参照源切换：两本目录各自的覆盖面不同，并排展示会让“参照声明”这一列出现两种语义，
// 因此做成互斥切换，同一时刻只有一份目录声明参与比对；切换本身不产生任何探测请求，
// models.dev 体积较大（约 5 MB），首次切过去才通过只读路由拉取
export function ReferenceCompare({ model, reference, onRetry, modelsDev, onLoadModelsDev }: Props) {
  const [source, setSource] = useState<ReferenceSource>('openrouter');
  const loadModelsDev = onLoadModelsDev ?? (() => undefined);
  const state: ReferenceState = source === 'openrouter' ? reference : modelsDev ?? { status: 'loading' };
  return (
    <div className="ref-sources">
      <div className="ref-source-bar">
        <div className="ref-source-switch" role="group" aria-label="参照目录来源">
          {(['openrouter', 'modelsdev'] as ReferenceSource[]).map((item) => (
            <button
              key={item}
              type="button"
              className={item === source ? 'active' : ''}
              title={item === 'modelsdev' ? '切换到 models.dev 目录（约 5 MB，只读，首次切换时才拉取）' : '切换到 OpenRouter 目录'}
              onClick={() => {
                setSource(item);
                if (item === 'modelsdev' && !modelsDev) loadModelsDev();
              }}
            >
              {SOURCE_LABELS[item]}
            </button>
          ))}
        </div>
        <span className="ref-note">第三方目录均为只读：不产生探测请求，也不写入模型证据链。</span>
      </div>
      <ReferenceSourceTable model={model} state={state} onRetry={source === 'openrouter' ? onRetry : loadModelsDev} />
    </div>
  );
}
