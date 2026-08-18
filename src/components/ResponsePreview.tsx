import { ChevronRight, Clipboard } from 'lucide-react';
import { useMemo, useState } from 'react';
import { buildPreview, isPreviewNode, type PreviewArray, type PreviewNode, type PreviewObject, type PreviewScalar, type PreviewText } from '../lib/preview';

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN');
}

function scalarText(node: PreviewScalar): string {
  if (node.value === null) return 'null';
  if (typeof node.value === 'string') return `"${node.value}"`;
  return String(node.value);
}

function nodeTypeLabel(node: PreviewNode): string {
  if (node.kind === 'scalar') return node.value === null ? 'null' : typeof node.value === 'string' ? '字符串' : typeof node.value;
  if (node.kind === 'text') return `文本 ${formatNumber(node.length)} 字符`;
  if (node.kind === 'array') return `数组 ${formatNumber(node.length)} 项`;
  if (node.kind === 'object') return `对象 ${formatNumber(node.length)} 键`;
  return '内容省略';
}

interface PreviewStats {
  rootType: string;
  totalChars: number;
  truncatedTexts: number;
  omitted: number;
}

function collectStats(root: PreviewNode): PreviewStats {
  const stats: PreviewStats = { rootType: nodeTypeLabel(root), totalChars: 0, truncatedTexts: 0, omitted: 0 };
  const visit = (node: PreviewNode): void => {
    if (node.kind === 'text') {
      stats.totalChars += node.length;
      if (node.tail) stats.truncatedTexts += 1;
      return;
    }
    if (node.kind === 'array' || node.kind === 'object') {
      if (node.shown < node.length) stats.omitted += node.length - node.shown;
      const children = node.kind === 'array' ? node.items : node.entries.map((entry) => entry.node);
      for (const child of children) visit(child);
    }
  };
  visit(root);
  return stats;
}

function TextCard({ node }: { node: PreviewText }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const truncated = Boolean(node.tail);
  const copy = async () => {
    await navigator.clipboard.writeText(truncated ? `${node.head}\n…（共 ${formatNumber(node.length)} 字符）…\n${node.tail}` : node.head);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const body = truncated
    ? (expanded ? `${node.head}\n\n… 中间省略 ${formatNumber(node.length - node.head.length - node.tail.length)} 字符 …\n\n${node.tail}` : `${node.head}…`)
    : node.head;
  return (
    <div className="preview-text">
      <div className="preview-text-meta">
        <span>文本 · {formatNumber(node.length)} 字符 · {formatNumber(node.lines)} 行</span>
        {truncated && <span className="preview-warn">已截断</span>}
        <span className="preview-text-actions">
          {truncated && <button onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开首尾'}</button>}
          <button onClick={() => void copy()}>{copied ? '已复制' : '复制'}</button>
        </span>
      </div>
      <pre className="preview-text-body">{body}</pre>
    </div>
  );
}

function ContainerChildren({ node }: { node: PreviewArray | PreviewObject }) {
  const children = node.kind === 'array'
    ? node.items.map((item, index) => ({ key: `[${index}]`, node: item }))
    : node.entries.map((entry) => ({ key: entry.key, node: entry.node }));
  return (
    <div className="preview-children">
      {children.map(({ key, node: child }) => (
        <div className="preview-row" key={key}>
          <span className="preview-key">{key}</span>
          <div className="preview-cell"><ChildNode node={child} /></div>
        </div>
      ))}
      {node.shown < node.length && <div className="preview-more">… 已省略 {formatNumber(node.length - node.shown)} 项</div>}
    </div>
  );
}

function ContainerNode({ node }: { node: PreviewArray | PreviewObject }) {
  const [expanded, setExpanded] = useState(false);
  const omitted = node.length - node.shown;
  return (
    <div className="preview-container">
      <button className="preview-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ChevronRight size={13} className={expanded ? 'rotated' : ''} />
        <span>{nodeTypeLabel(node)}</span>
        {omitted > 0 && <span className="preview-warn">已省略 {formatNumber(omitted)} 项</span>}
      </button>
      {expanded && <ContainerChildren node={node} />}
    </div>
  );
}

function ChildNode({ node }: { node: unknown }) {
  const normalized = isPreviewNode(node) ? node : buildPreview(node);
  if (normalized.kind === 'scalar') return <span className={`preview-scalar preview-scalar-${normalized.value === null ? 'null' : typeof normalized.value}`}>{scalarText(normalized)}</span>;
  if (normalized.kind === 'text') return <TextCard node={normalized} />;
  if (normalized.kind === 'truncated') return <span className="preview-more">… 深层内容省略</span>;
  return <ContainerNode node={normalized} />;
}

export function ResponsePreview({ value }: { value: unknown }) {
  const root = useMemo(() => isPreviewNode(value) ? value : buildPreview(value), [value]);
  const stats = useMemo(() => collectStats(root), [root]);
  if (value == null) return <div className="preview-empty">暂无响应内容。</div>;
  return (
    <div className="preview" data-testid="response-preview">
      <div className="preview-stats">
        <span>{stats.rootType}</span>
        {stats.totalChars > 0 && <span>文本合计 {formatNumber(stats.totalChars)} 字符</span>}
        {stats.truncatedTexts > 0 && <span className="preview-warn">{stats.truncatedTexts} 个长文本已截断</span>}
        {stats.omitted > 0 && <span className="preview-warn">省略 {formatNumber(stats.omitted)} 项</span>}
      </div>
      <div className="preview-tree">
        {root.kind === 'scalar' || root.kind === 'text' || root.kind === 'truncated' ? <ChildNode node={root} /> : <ContainerChildren node={root} />}
      </div>
    </div>
  );
}
