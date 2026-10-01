import { ArrowDown, ArrowUp, AudioLines, Box, FileText, FlaskConical, Image, Search, Type, Video } from 'lucide-react';
import type { DiscoveredModel, InputModality } from '../domain/types';
import { CapabilityBadge } from './CapabilityBadge';

export type SortKey = 'displayName' | 'contextWindow' | 'maxOutputTokens' | 'confidence' | 'lastProbedAt';

interface Props {
  models: DiscoveredModel[];
  selectedId?: string;
  search: string;
  capabilityFilter: string;
  confidenceFilter: string;
  protocolFilter: string;
  statusFilter: string;
  sortKey: SortKey;
  sortDirection: 'asc' | 'desc';
  onSearch: (value: string) => void;
  onCapabilityFilter: (value: string) => void;
  onConfidenceFilter: (value: string) => void;
  onProtocolFilter: (value: string) => void;
  onStatusFilter: (value: string) => void;
  onSort: (key: SortKey) => void;
  onSelect: (model: DiscoveredModel) => void;
  /** 仅开发环境注入：载入演示模型，用于在没有真实端点与密钥时目测展示层 */
  onLoadSample?: () => void;
  /** 本轮未自动验证的模型数（免密跳过、认证失败或验证中断） */
  remainingCount?: number;
  onValidateRemaining?: () => void;
  /** 端点缺少可用凭据：显式继续验证也只会得到 401，按钮禁用并说明原因 */
  remainingBlocked?: boolean;
}

const modalityIcons: Record<InputModality, typeof Type> = { text: Type, image: Image, audio: AudioLines, video: Video, pdf: FileText };
const statusLabels = { discovered: '已发现', validating: '验证中', validated: '已验证', partial: '部分完成', error: '错误' };
const confidenceLabels = { high: '高', medium: '中', low: '低', unknown: '未知' };

export function ModelsTable(props: Props) {
  const SortHeader = ({ label, column }: { label: string; column: SortKey }) => {
    const active = props.sortKey === column;
    return <button className={`sort-header ${active ? 'active' : ''}`} onClick={() => props.onSort(column)}>{label}{active && (props.sortDirection === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button>;
  };
  return (
    <div className="models-area">
      <div className="table-toolbar">
        <div className="search-box"><Search size={15} /><input aria-label="搜索模型" placeholder="搜索名称或模型 ID" value={props.search} onChange={(event) => props.onSearch(event.target.value)} /></div>
        <select aria-label="能力筛选" value={props.capabilityFilter} onChange={(event) => props.onCapabilityFilter(event.target.value)}>
          <option value="">全部能力</option><option value="supportsTools">支持 Tools</option><option value="vision">支持 Vision</option><option value="supportsJsonMode">支持 JSON</option><option value="supportsReasoning">支持 Reasoning</option><option value="supportsStreaming">支持 Streaming</option>
        </select>
        <select aria-label="置信度筛选" value={props.confidenceFilter} onChange={(event) => props.onConfidenceFilter(event.target.value)}>
          <option value="">全部置信度</option><option value="high">高置信度</option><option value="medium">中置信度</option><option value="low">低置信度</option><option value="unknown">未知</option>
        </select>
        <select aria-label="协议筛选" value={props.protocolFilter} onChange={(event) => props.onProtocolFilter(event.target.value)}>
          <option value="">全部协议</option><option value="openai-compatible">OpenAI-compatible</option><option value="openai-chat">OpenAI Chat</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option><option value="cohere">Cohere</option><option value="ollama">Ollama</option><option value="manual">手工 / 未知</option>
        </select>
        <select aria-label="探测结果筛选" value={props.statusFilter} onChange={(event) => props.onStatusFilter(event.target.value)}>
          <option value="">全部结果</option><option value="discovered">已发现</option><option value="validated">已验证</option><option value="partial">部分完成</option><option value="error">错误</option>
        </select>
        {props.onLoadSample && <button className="section-toggle" onClick={props.onLoadSample} title="载入演示模型，不发送任何请求"><FlaskConical size={14} />载入示例模型</button>}
        {props.onValidateRemaining && <button className="section-toggle" onClick={props.onValidateRemaining} title={`为剩余 ${props.remainingCount ?? 0} 个模型补做能力验证`}>继续验证 {props.remainingCount} 个未验证模型</button>}
        {props.remainingBlocked && <button className="section-toggle" disabled title="端点没有可用凭据，生成接口不可用：主动验证只会得到 401，能力结论保持目录声明">继续验证 {props.remainingCount} 个未验证模型</button>}
        <span className="result-count">{props.models.length} 个模型</span>
      </div>
      <div className="table-scroll">
        <table className="models-table">
          <thead><tr>
            <th><SortHeader label="模型" column="displayName" /></th><th>来源</th><th><SortHeader label="上下文" column="contextWindow" /></th><th><SortHeader label="最大输出" column="maxOutputTokens" /></th><th>输入</th><th>Tools</th><th>Vision</th><th>JSON</th><th>Reasoning</th><th>Streaming</th><th>状态</th><th><SortHeader label="置信度" column="confidence" /></th><th><SortHeader label="最近探测" column="lastProbedAt" /></th>
          </tr></thead>
          <tbody>
            {props.models.map((model) => (
              <tr key={model.id} className={props.selectedId === model.id ? 'selected' : ''} onClick={() => props.onSelect(model)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && props.onSelect(model)}>
                <td><strong>{model.displayName}</strong><code>{model.id}</code></td>
                <td><span className="source-tag">{model.discoverySource}</span></td>
                <td className="number-cell">{model.contextWindow?.toLocaleString() ?? '未知'}</td>
                <td className="number-cell">{model.maxOutputTokens?.toLocaleString() ?? '未知'}</td>
                <td><div className="modality-list">{model.inputModalities.map((item) => { const Icon = modalityIcons[item]; return <span title={item} key={item}><Icon size={15} /><span className="sr-only">{item}</span></span>; })}</div></td>
                <td><CapabilityBadge compact status={model.capabilities.supportsTools} /></td>
                <td><CapabilityBadge compact status={model.inputModalities.includes('image') ? { value: model.confidence === 'low' ? 'inferred' : 'supported', evidence: [{ source: model.confidence === 'low' ? 'inferred' : 'endpoint', confidence: model.confidence, detail: '输入模态包含 image', timestamp: model.lastProbedAt }] } : { value: 'unknown', evidence: [] }} /></td>
                <td><CapabilityBadge compact status={model.capabilities.supportsJsonMode} /></td>
                <td><CapabilityBadge compact status={model.capabilities.supportsReasoning} /></td>
                <td><CapabilityBadge compact status={model.capabilities.supportsStreaming} /></td>
                <td><span className={`status-text status-${model.status}`}>{statusLabels[model.status]}</span></td>
                <td><span className={`confidence confidence-${model.confidence}`}><Box size={12} />{confidenceLabels[model.confidence]}</span></td>
                <td className="date-cell">{new Date(model.lastProbedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
              </tr>
            ))}
            {props.models.length === 0 && <tr><td className="empty-table" colSpan={13}>没有匹配的模型。配置端点后开始探测，或调整筛选条件。</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
