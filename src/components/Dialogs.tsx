import { Download, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { capabilityKeys, capabilityLabels } from '../domain/capabilities';
import type { CapabilityKey } from '../domain/types';

export function ValidationDialog({ modelName, onClose, onStart }: { modelName: string; onClose: () => void; onStart: (items: CapabilityKey[]) => void }) {
  const defaults: CapabilityKey[] = ['supportsTools', 'supportsJsonMode', 'supportsStructuredOutput', 'supportsTemperature', 'supportsStreaming'];
  const [selected, setSelected] = useState<CapabilityKey[]>(defaults);
  const toggle = (key: CapabilityKey) => setSelected((items) => items.includes(key) ? items.filter((item) => item !== key) : [...items, key]);
  return <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="validation-title">
    <div className="modal-heading"><div><span className="eyebrow">主动能力验证</span><h2 id="validation-title">{modelName}</h2></div><button className="icon-button" title="关闭" onClick={onClose}><X size={17} /></button></div>
    <div className="risk-callout"><ShieldAlert size={17} /><span>将发送真实生成请求。每项独立执行，最多 2 个并发；Tools 使用不会执行的本地虚拟定义。</span></div>
    <div className="validation-options">{capabilityKeys.map((key) => <label key={key}><input type="checkbox" checked={selected.includes(key)} onChange={() => toggle(key)} /><span>{capabilityLabels[key]}</span></label>)}</div>
    <div className="estimate-row"><span>预计请求数</span><strong>{selected.length}</strong><span>· 每次最大输出 8 tokens</span></div>
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!selected.length} onClick={() => onStart(selected)}>开始验证</button></div>
  </div></div>;
}

export type ExportFormat = 'report' | 'openai' | 'dsh';

export function ExportDialog({ onClose, onExport }: { onClose: () => void; onExport: (format: ExportFormat, includeSecret: boolean, includeInferred: boolean) => void }) {
  const [format, setFormat] = useState<ExportFormat>('report');
  const [includeSecret, setIncludeSecret] = useState(false);
  const [includeInferred, setIncludeInferred] = useState(false);
  return <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title">
    <div className="modal-heading"><div><span className="eyebrow">安全导出</span><h2 id="export-title">导出端点与探测结果</h2></div><button className="icon-button" title="关闭" onClick={onClose}><X size={17} /></button></div>
    <div className="format-options"><label><input type="radio" name="format" checked={format === 'report'} onChange={() => setFormat('report')} /><span><strong>通用 JSON 报告</strong><small>完整探测流程、日志与模型能力</small></span></label><label><input type="radio" name="format" checked={format === 'openai'} onChange={() => setFormat('openai')} /><span><strong>OpenAI-compatible</strong><small>端点及标准化模型配置片段</small></span></label><label><input type="radio" name="format" checked={format === 'dsh'} onChange={() => setFormat('dsh')} /><span><strong>DSH / pi-ai YAML</strong><small>providers 配置片段</small></span></label></div>
    <label className="toggle-row export-toggle"><input type="checkbox" checked={includeInferred} onChange={(event) => setIncludeInferred(event.target.checked)} /><span><strong>包含推测字段</strong><small>推测能力不会默认写成确定配置</small></span></label>
    <label className="toggle-row export-toggle danger-export"><input type="checkbox" checked={includeSecret} onChange={(event) => setIncludeSecret(event.target.checked)} /><span><strong>导出 API Key</strong><small>文件将包含明文密钥，请妥善保管</small></span></label>
    <div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => onExport(format, includeSecret, includeInferred)}><Download size={15} />导出</button></div>
  </div></div>;
}
