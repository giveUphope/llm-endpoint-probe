import { Copy, Eye, EyeOff, FileDown, FileUp, Plus, Save, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { EndpointProfile, KeyValue } from '../domain/types';
import { emptyPair } from '../lib/profile';

const protocolOptions = [
  ['auto', '自动识别'], ['openai-chat', 'OpenAI Chat Completions'], ['openai-responses', 'OpenAI Responses'],
  ['anthropic', 'Anthropic Messages'], ['ollama', 'Ollama'], ['llamacpp', 'llama.cpp server'],
  ['openai-compatible', 'OpenAI-compatible gateway'], ['manual', '手工 / 未知'],
] as const;

interface Props {
  profile: EndpointProfile;
  profiles: EndpointProfile[];
  running: boolean;
  onChange: (profile: EndpointProfile) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onSave: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onImport: (file: File) => void;
  onExport: () => void;
  onProbe: () => void;
  onCancel: () => void;
}

function PairEditor({ label, items, onChange }: { label: string; items: KeyValue[]; onChange: (items: KeyValue[]) => void }) {
  const update = (id: string, patch: Partial<KeyValue>) => onChange(items.map((item) => item.id === id ? { ...item, ...patch } : item));
  return (
    <div className="field pair-field">
      <div className="field-label-row"><span>{label}</span><button className="icon-button subtle" title={`添加${label}`} onClick={() => onChange([...items, emptyPair()])}><Plus size={15} /></button></div>
      {items.length === 0 && <div className="pair-empty">未设置</div>}
      {items.map((item) => (
        <div className="pair-row" key={item.id}>
          <input aria-label={`${label}名称`} placeholder="Header" value={item.key} onChange={(event) => update(item.id, { key: event.target.value })} />
          <input aria-label={`${label}值`} placeholder="值" value={item.value} onChange={(event) => update(item.id, { value: event.target.value })} />
          <button className="icon-button subtle" title="删除此项" onClick={() => onChange(items.filter((value) => value.id !== item.id))}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

export function EndpointPanel(props: Props) {
  const [showKey, setShowKey] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const patch = (change: Partial<EndpointProfile>) => props.onChange({ ...props.profile, ...change, updatedAt: new Date().toISOString() });
  return (
    <aside className="endpoint-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">当前端点</span><strong>连接配置</strong></div>
        <button className="icon-button" title="新建端点" onClick={props.onNew}><Plus size={17} /></button>
      </div>

      <div className="profile-select-row">
        <select aria-label="已保存端点" value={props.profile.id} onChange={(event) => props.onSelect(event.target.value)}>
          {props.profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
        </select>
        <button className="icon-button" title="复制端点" onClick={props.onDuplicate}><Copy size={16} /></button>
        <button className="icon-button danger" title="删除端点" onClick={props.onDelete}><Trash2 size={16} /></button>
      </div>

      <label className="field"><span>端点名称</span><input value={props.profile.name} onChange={(event) => patch({ name: event.target.value })} /></label>
      <label className="field"><span>baseURL</span><input placeholder="https://api.example.com/v1" value={props.profile.baseURL} onChange={(event) => patch({ baseURL: event.target.value })} /></label>
      <label className="field"><span>API 协议</span><select value={props.profile.protocol} onChange={(event) => patch({ protocol: event.target.value as EndpointProfile['protocol'] })}>{protocolOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="field"><span>认证方式</span><select value={props.profile.authMode} onChange={(event) => patch({ authMode: event.target.value as EndpointProfile['authMode'] })}>
        <option value="bearer">Authorization: Bearer</option><option value="api-key">api-key Header</option><option value="custom">自定义 Header</option><option value="none">无认证</option>
      </select></label>
      {props.profile.authMode === 'custom' && <div className="split-fields"><label className="field"><span>Header 名</span><input value={props.profile.customHeaderName} onChange={(event) => patch({ customHeaderName: event.target.value })} /></label><label className="field"><span>值模板</span><input value={props.profile.customHeaderTemplate} onChange={(event) => patch({ customHeaderTemplate: event.target.value })} /></label></div>}
      {props.profile.authMode !== 'none' && <label className="field"><span>API Key</span><div className="input-with-action"><input type={showKey ? 'text' : 'password'} autoComplete="off" value={props.profile.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} /><button className="icon-button subtle" title={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>}

      <PairEditor label="附加 Headers" items={props.profile.headers} onChange={(headers) => patch({ headers })} />
      <PairEditor label="查询参数" items={props.profile.queryParams} onChange={(queryParams) => patch({ queryParams })} />
      <label className="field"><span>请求超时（毫秒）</span><input type="number" min="1000" max="120000" step="1000" value={props.profile.timeoutMs} onChange={(event) => patch({ timeoutMs: Number(event.target.value) })} /></label>
      <label className="toggle-row"><input type="checkbox" checked={props.profile.allowValidation} onChange={(event) => patch({ allowValidation: event.target.checked })} /><span><strong>允许主动验证</strong><small>会向所选模型发送最小生成请求</small></span></label>
      <label className="toggle-row warning-toggle"><input type="checkbox" checked={props.profile.allowLocalNetwork} onChange={(event) => patch({ allowLocalNetwork: event.target.checked })} /><span><strong>允许本地网络目标</strong><small>仅在信任目标时启用，存在 SSRF 风险</small></span></label>

      <div className="storage-note">保存后配置存入此浏览器的 localStorage；密钥不会加密。共享设备上请勿保存密钥。</div>
      <div className="panel-actions">
        <button className="secondary-button" onClick={props.onSave}><Save size={15} />保存</button>
        <button className="icon-button" title="导入配置" onClick={() => inputRef.current?.click()}><FileUp size={16} /></button>
        <button className="icon-button" title="导出配置" onClick={props.onExport}><FileDown size={16} /></button>
        <input ref={inputRef} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && props.onImport(event.target.files[0])} />
      </div>
      {props.running ? <button className="probe-button cancel" onClick={props.onCancel}><X size={17} />取消探测</button> : <button className="probe-button" onClick={props.onProbe}>开始分层探测</button>}
    </aside>
  );
}
