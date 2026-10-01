import { Eye, EyeOff, History, RefreshCw, RotateCcw, ShieldAlert, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EndpointProfile } from '../domain/types';
import type { EndpointHistoryItem } from '../services/proxy';

interface Props {
  profile: EndpointProfile;
  history: EndpointHistoryItem[];
  historyLoading: boolean;
  running: boolean;
  proxyStatus: 'checking' | 'online' | 'offline';
  proxyMessage: string;
  onChange: (profile: EndpointProfile) => void;
  onClose: () => void;
  onRestoreHistory: (id: string) => void;
  onClearHistory: () => void;
  onProbe: () => void;
  onCancel: () => void;
}

export function EndpointPanel(props: Props) {
  const [showKey, setShowKey] = useState(false);
  const [historyId, setHistoryId] = useState('');
  const patch = (change: Partial<EndpointProfile>) => props.onChange({ ...props.profile, ...change, updatedAt: new Date().toISOString() });
  useEffect(() => {
    if (!props.history.some((item) => item.id === historyId)) setHistoryId(props.history[0]?.id ?? '');
  }, [historyId, props.history]);
  return (
    <aside className="endpoint-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">端点探测</span><strong>连接参数</strong></div>
      </div>

      <div className="history-field">
        <div className="field-label-row"><span><History size={14} />会话探测历史</span><small>后端内存</small></div>
        <div className="history-select-row">
          <select aria-label="会话探测历史" disabled={props.historyLoading || !props.history.length} value={historyId} onChange={(event) => setHistoryId(event.target.value)}>
            {!props.history.length && <option value="">暂无探测记录</option>}
            {props.history.map((item) => <option value={item.id} key={item.id}>{item.name} · {new Date(item.lastUsedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}{item.hasApiKey ? ' · 含密钥' : ''}</option>)}
          </select>
          <button className="icon-button" disabled={!historyId || props.historyLoading} title="还原端点和 API Key" onClick={() => props.onRestoreHistory(historyId)}><RotateCcw size={16} /></button>
          <button className="icon-button danger" disabled={!props.history.length || props.historyLoading || props.running} title="清空后端探测历史" onClick={props.onClearHistory}><Trash2 size={16} /></button>
        </div>
        <small className="history-note">只保留在当前后端进程中；关闭后端或主动清空后无法恢复。</small>
      </div>

      {props.proxyStatus === 'offline' && <div className="proxy-guard-notice" role="alert"><ShieldAlert size={17} /><div><strong>本地代理未连接</strong><small>{props.proxyMessage}。页面可以继续编辑配置，但不会发送端点请求。</small></div></div>}

      <label className="field"><span>端点 URL</span><input placeholder="https://api.example.com/v1 或完整请求 URL" value={props.profile.baseURL} onChange={(event) => patch({ baseURL: event.target.value, protocol: 'auto', authMode: 'auto' })} /></label>
      <label className="field"><span>API Key</span><div className="input-with-action"><input type={showKey ? 'text' : 'password'} autoComplete="off" value={props.profile.apiKey} onChange={(event) => patch({ apiKey: event.target.value })} /><button className="icon-button subtle" title={showKey ? '隐藏密钥' : '显示密钥'} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>

      <label className="field"><span>请求超时（毫秒）</span><input type="number" min="1000" max="120000" step="1000" value={props.profile.timeoutMs} onChange={(event) => patch({ timeoutMs: Number(event.target.value) })} /></label>
      <p className="name-check-hint">探测会自动验证<b>全部</b>发现的模型（每项能力的最小请求 + 虚假模型名探测），模型之间顺序执行、可随时取消。目录匿名可读但生成接口需要凭据时（例如不带 Key 的 OpenRouter）跳过主动验证，能力结论只保留目录声明。</p>
      <label className="toggle-row warning-toggle"><input type="checkbox" checked={props.profile.allowLocalNetwork} onChange={(event) => patch({ allowLocalNetwork: event.target.checked })} /><span><strong>允许本地网络目标</strong><small>仅在信任目标时启用，存在 SSRF 风险</small></span></label>

      {props.running ? <button className="probe-button cancel" onClick={props.onCancel}><X size={17} />取消探测</button> : <button className={`probe-button ${props.proxyStatus === 'offline' ? 'retry' : ''}`} onClick={props.onProbe}><RefreshCw className={props.proxyStatus === 'checking' ? 'spin' : ''} size={16} />{props.proxyStatus === 'online' ? '开始分层探测' : props.proxyStatus === 'offline' ? '重试代理并开始探测' : '检查代理后开始探测'}</button>}
    </aside>
  );
}
