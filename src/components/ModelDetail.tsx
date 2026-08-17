import { Braces, Clipboard, Code2, FileJson, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { capabilityKeys, capabilityLabels } from '../domain/capabilities';
import type { DiscoveredModel, RequestRecord } from '../domain/types';
import { modelSnippet } from '../lib/exporters';
import { CapabilityBadge } from './CapabilityBadge';

interface Props { model: DiscoveredModel; requests: RequestRecord[]; onClose: () => void; onValidate: () => void; canValidate: boolean }

export function ModelDetail({ model, requests, onClose, onValidate, canValidate }: Props) {
  const [rawOpen, setRawOpen] = useState(false);
  const [format, setFormat] = useState<'json' | 'yaml'>('json');
  const copy = () => navigator.clipboard.writeText(modelSnippet(model, format));
  const lastRequest = [...requests].reverse().find((request) => {
    const body = request.requestBody && typeof request.requestBody === 'object' ? request.requestBody as Record<string, unknown> : undefined;
    return body?.model === model.id;
  }) ?? requests.at(-1);
  return (
    <aside className="model-detail">
      <div className="detail-heading"><div><span className="eyebrow">模型详情</span><h2>{model.displayName}</h2><code>{model.id}</code></div><button className="icon-button" title="关闭详情" onClick={onClose}><X size={17} /></button></div>
      <div className="detail-meta"><div><span>协议</span><strong>{model.protocol}</strong></div><div><span>置信度</span><strong>{model.confidence}</strong></div><div><span>上下文</span><strong>{model.contextWindow?.toLocaleString() ?? '未知'}</strong></div><div><span>最大输出</span><strong>{model.maxOutputTokens?.toLocaleString() ?? '未知'}</strong></div></div>
      <button className="validate-button" disabled={!canValidate || model.status === 'validating'} onClick={onValidate}><RefreshCw className={model.status === 'validating' ? 'spin' : ''} size={15} />{canValidate ? '选择能力并重新验证' : '端点未允许主动验证'}</button>
      <section className="detail-section"><div className="subsection-heading"><strong>标准化能力</strong><span>状态与证据</span></div>
        <div className="capability-matrix">{capabilityKeys.map((key) => { const status = model.capabilities[key]; return <div className="capability-row" key={key}><span>{capabilityLabels[key]}</span><CapabilityBadge status={status} /><div className="evidence-list">{status.evidence.map((item, index) => <small key={`${item.timestamp}-${index}`}><b>{item.source}</b> · {item.confidence} · {item.detail}</small>)}</div></div>; })}</div>
      </section>
      <section className="detail-section"><div className="subsection-heading"><strong>最近请求</strong><span>已自动脱敏</span></div>{lastRequest ? <div className="last-request"><div><span className={`method method-${lastRequest.method.toLowerCase()}`}>{lastRequest.method}</span><code>{lastRequest.finalURL || lastRequest.url}</code><small>{lastRequest.status ?? '—'} · {lastRequest.durationMs ?? '—'}ms · {lastRequest.responseBytes != null ? `${Math.ceil(lastRequest.responseBytes / 1024)} KiB` : '—'}</small></div><pre>{lastRequest.errorMessage || JSON.stringify(lastRequest.responsePreview, null, 2)}</pre></div> : <div className="log-empty compact">暂无请求记录。</div>}</section>
      <section className="detail-section"><button className="section-toggle" onClick={() => setRawOpen(!rawOpen)}><Braces size={15} />原始元数据 <span>{rawOpen ? '收起' : '展开'}</span></button>{rawOpen && <pre className="raw-viewer">{JSON.stringify(model.rawMetadata, null, 2)}</pre>}</section>
      <section className="detail-section"><div className="subsection-heading"><strong>模型配置</strong><div className="segmented"><button className={format === 'json' ? 'active' : ''} onClick={() => setFormat('json')}><FileJson size={13} />JSON</button><button className={format === 'yaml' ? 'active' : ''} onClick={() => setFormat('yaml')}><Code2 size={13} />YAML</button></div></div><div className="snippet-wrap"><button className="copy-snippet" title="复制配置" onClick={copy}><Clipboard size={14} /></button><pre>{modelSnippet(model, format)}</pre></div></section>
    </aside>
  );
}
