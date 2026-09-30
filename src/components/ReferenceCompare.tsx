import { RefreshCw } from 'lucide-react';
import { capabilityValueLabels } from '../domain/capabilities';
import type { CapabilityValue, DiscoveredModel } from '../domain/types';
import { compareReference, matchReference, type ReferenceState } from '../services/reference';

interface Props {
  model: DiscoveredModel;
  reference: ReferenceState;
  onRetry: () => void;
}

type Tone = 'good' | 'bad' | 'muted';

interface Verdict {
  text: string;
  tone: Tone;
}

function definitive(value: CapabilityValue): boolean {
  return value === 'supported' || value === 'unsupported';
}

// 比对结论：两侧都是确定结论才可能“一致/冲突”；参照缺失记为“参照未覆盖”，
// 端点未验证则记为“待端点验证” —— 参照声明从不单独推翻或确认端点结论
function verdict(local: CapabilityValue, reference: CapabilityValue): Verdict {
  if (definitive(local) && definitive(reference)) {
    return local === reference ? { text: '一致', tone: 'good' } : { text: '冲突', tone: 'bad' };
  }
  if (reference === 'unknown') return { text: '参照未覆盖', tone: 'muted' };
  return { text: '待端点验证', tone: 'muted' };
}

function pairVerdict(leftPresent: boolean, rightPresent: boolean, equal: boolean): Verdict {
  if (leftPresent && rightPresent) return equal ? { text: '一致', tone: 'good' } : { text: '冲突', tone: 'bad' };
  if (!rightPresent) return { text: '参照未覆盖', tone: 'muted' };
  return { text: '待端点验证', tone: 'muted' };
}

function toneClass(tone: Tone): string {
  return tone === 'good' ? 'ref-match' : tone === 'bad' ? 'ref-conflict' : 'ref-muted';
}

function referenceLabel(value: CapabilityValue): string {
  return value === 'unknown' ? '参照未覆盖' : capabilityValueLabels[value];
}

// OpenRouter 参照比对区块：纯展示层，不写入模型证据链、不触发任何探测请求
export function ReferenceCompare({ model, reference, onRetry }: Props) {
  if (reference.status === 'loading') {
    return <p className="ref-note">正在通过本地受控代理获取 OpenRouter 公开模型目录…</p>;
  }
  if (reference.status === 'error') {
    return (
      <div className="ref-note warn">
        <span>参照目录不可用：{reference.message}。参照不可用不会改变端点探测结论。</span>
        <button className="icon-button subtle" title="重新获取参照目录" onClick={onRetry}><RefreshCw size={14} /></button>
      </div>
    );
  }
  const { catalog } = reference;
  const entry = matchReference(model, catalog);
  if (!entry) {
    return <p className="ref-note">OpenRouter 公开目录中未匹配到「{model.id}」：无法交叉比对。参照缺失不代表该端点或模型不支持任何能力。</p>;
  }
  const comparison = compareReference(model, entry);
  const conflicts = [
    comparison.conflictCount ? `${comparison.conflictCount} 项能力声明冲突` : '',
    comparison.contextConflict ? '上下文窗口不一致' : '',
    comparison.modalityConflict ? '输入模态不一致' : '',
  ].filter(Boolean);
  const covered = comparison.rows.filter((row) => row.reference !== 'unknown').length;
  const snapshot = new Date(catalog.fetchedAt).toLocaleString('zh-CN', { hour12: false });
  const context = pairVerdict(
    comparison.localContextWindow != null,
    comparison.referenceContextWindow != null,
    comparison.localContextWindow === comparison.referenceContextWindow,
  );
  const modalities = pairVerdict(
    comparison.localModalities.length > 0,
    comparison.referenceModalities.length > 0,
    !comparison.modalityConflict,
  );
  return (
    <div className="ref-compare">
      <div className="name-check">
        <div className="name-check-row"><span>参照条目</span><code>{entry.id}{entry.name ? ` · ${entry.name}` : ''}</code></div>
        <div className="name-check-row"><span>目录快照</span><code>{snapshot}</code></div>
      </div>
      <p className="ref-note">以下为 OpenRouter 公开目录的第三方声明，仅用于与当前端点结果交叉比对；出现冲突时，以当前端点的实测（validated）证据为准。</p>
      {conflicts.length
        ? <div className="name-check-note warn">{conflicts.join('；')}：请结合两端证据判断是端点声明过时、参照声明过时，还是实际能力差异，不要单凭参照下结论。</div>
        : <div className="name-check-note good">端点结论与参照目录声明未发现冲突（参照覆盖 {covered} 项能力）。</div>}
      <div className="ref-table">
        <div className="ref-row ref-head"><span>能力</span><span>端点结论</span><span>参照声明</span><span>比对</span></div>
        {comparison.rows.map((row) => {
          const result = verdict(row.local, row.reference);
          return (
            <div className="ref-row" key={row.key}>
              <span className="ref-label">{row.label}</span>
              <span className="ref-value">{capabilityValueLabels[row.local]}</span>
              <span className="ref-value">{referenceLabel(row.reference)}</span>
              <span className={toneClass(result.tone)}>{result.text}</span>
            </div>
          );
        })}
        <div className="ref-row">
          <span className="ref-label">上下文窗口</span>
          <span className="ref-value">{comparison.localContextWindow?.toLocaleString() ?? '未知'}</span>
          <span className="ref-value">{comparison.referenceContextWindow?.toLocaleString() ?? '参照未覆盖'}</span>
          <span className={toneClass(context.tone)}>{context.text}</span>
        </div>
        <div className="ref-row">
          <span className="ref-label">输入模态</span>
          <span className="ref-value">{comparison.localModalities.join(' / ') || '—'}</span>
          <span className="ref-value">{comparison.referenceModalities.join(' / ') || '—'}</span>
          <span className={toneClass(modalities.tone)}>{modalities.text}</span>
        </div>
      </div>
    </div>
  );
}
