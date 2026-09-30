import { Braces, Clipboard, Code2, FileJson, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { interfaceLabel, sameModelName } from '../adapters/shared';
import { capabilityKeys, capabilityLabels } from '../domain/capabilities';
import type { DiscoveredModel, RequestRecord } from '../domain/types';
import { modelSnippet } from '../lib/exporters';
import type { ReferenceState } from '../services/reference';
import { CapabilityBadge } from './CapabilityBadge';
import { ReferenceCompare } from './ReferenceCompare';
import { ResponsePreview } from './ResponsePreview';

interface Props {
  model: DiscoveredModel;
  requests: RequestRecord[];
  onClose: () => void;
  onValidate: () => void;
  canValidate: boolean;
  reference: ReferenceState;
  onRetryReference: () => void;
}

export function ModelDetail({ model, requests, onClose, onValidate, canValidate, reference, onRetryReference }: Props) {
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
      <div className="detail-meta"><div><span>协议</span><strong>{model.protocol}</strong></div><div><span>置信度</span><strong>{model.confidence}</strong></div><div><span>上下文</span><strong>{model.contextWindow?.toLocaleString() ?? '未知'}</strong></div><div><span>最大输出</span><strong>{model.maxOutputTokens?.toLocaleString() ?? '未知'}</strong></div>{model.vendor && <div><span>上游厂商</span><strong>{model.vendor}</strong></div>}<div><span>声明接口</span><strong>{model.endpointTypes?.length ? model.endpointTypes.map(interfaceLabel).join(' / ') : '未声明'}</strong></div></div>
      <button className="validate-button" disabled={!canValidate || model.status === 'validating'} onClick={onValidate}><RefreshCw className={model.status === 'validating' ? 'spin' : ''} size={15} />{canValidate ? '选择能力并重新验证' : '端点未允许主动验证'}</button>
      {canValidate && <small className="name-check-hint">验证会额外发送虚假模型名请求，比对端点回显以排查名称真实性（多接口模型将逐接口执行）。</small>}
      {model.nameCheck && <section className="detail-section">
        <div className="subsection-heading"><strong>模型名真实性</strong><span>回显比对 · 未知名探测</span></div>
        <div className="name-check">
          <div className="name-check-row"><span>请求模型名</span><code>{model.id}</code></div>
          <div className="name-check-row"><span>端点回显型号</span><code>{model.nameCheck.echoedModelId ?? '无回显（该协议可能不回显）'}</code></div>
          <div className="name-check-row"><span>回显一致性</span><strong className={model.nameCheck.aliased === true ? 'name-check-bad' : model.nameCheck.aliased === false ? 'name-check-good' : ''}>{model.nameCheck.aliased === true ? '不一致（疑似别名）' : model.nameCheck.aliased === false ? '一致（真实有效）' : '未确认'}</strong></div>
          <div className="name-check-row"><span>未知模型名放行</span><strong className={model.nameCheck.acceptsUnknownNames === true ? 'name-check-bad' : model.nameCheck.acceptsUnknownNames === false ? 'name-check-good' : ''}>{model.nameCheck.acceptsUnknownNames === true ? '是（静默放行）' : model.nameCheck.acceptsUnknownNames === false ? '否（校验严格）' : '未确认'}</strong></div>
          {model.nameCheck.interfaces && model.nameCheck.interfaces.length > 0 && <div className="name-check-row"><span>已测接口</span><code>{model.nameCheck.interfaces.map(interfaceLabel).join(' / ')}</code></div>}
          {model.nameCheck.generationCheck && <>
            <div className="name-check-row"><span>生成接口</span><code>{model.nameCheck.generationCheck.interfaces.map(interfaceLabel).join(' / ')}</code></div>
            {model.nameCheck.generationCheck.details.map((detail) => (
              <div className="name-check-row" key={detail.interface}>
                <span>{interfaceLabel(detail.interface)}</span>
                <div className="name-check-cell">
                  <strong className={detail.realAccepted ? 'name-check-good' : detail.rejection ? 'name-check-bad' : ''}>
                    {detail.realAccepted ? '真实名可用' : detail.rejection ? `真实名被拒（${detail.rejection}）` : '真实名未确认'} · {detail.fakeAccepted ? '虚假名放行' : '虚假名未放行'}
                  </strong>
                  {detail.realShape && <div className="name-check-sub">真实名结构：{detail.realShape}{detail.fakeShape ? `；虚假名结构：${detail.fakeShape}` : ''}{detail.shapeConsistent === false ? '（不一致）' : detail.shapeConsistent === true ? '（一致）' : ''}</div>}
                  {detail.contentMatch === true ? <div className="name-check-sub">响应内容一致：真实名与虚假名返回完全相同的输出，强烈指向同一上游</div> : detail.contentMatch === false ? <div className="name-check-sub">响应内容不同：真实名与虚假名返回了不同的输出，名称可能生效</div> : null}
                  {detail.interface === 'image-generation' && (detail.nHonored === false || detail.sizeHonored === false) && <div className="name-check-sub">未尊重最小参数（{detail.nHonored === false ? '返回多图' : ''}{detail.nHonored === false && detail.sizeHonored === false ? '、' : ''}{detail.sizeHonored === false ? '疑似大尺寸图' : ''}）</div>}
                  {detail.echo && <div className="name-check-sub">回显型号：{detail.echo}</div>}
                </div>
              </div>
            ))}
            {model.nameCheck.generationCheck.nameServed
              ? <div className="name-check-note good">该模型名在声明的生成接口上均被接受，接口声明与名称一致。</div>
              : <div className="name-check-note warn">该模型名在部分声明的生成接口上被拒绝或未能确认：目录声明与实际可能不一致，名称可能为虚假或接口未开通。</div>}
            {model.nameCheck.generationCheck.permissive && <div className="name-check-note warn">生成接口对虚假模型名静默放行：结果可能来自默认模型。</div>}
            {model.nameCheck.generationCheck.details.some((d) => d.interface === 'image-generation' && d.shapeConsistent === false && d.fakeAccepted) && <div className="name-check-note good">绘图接口上虚假名与真实名返回不同结构：真实名由独立上游服务，名称真实。</div>}
            {model.nameCheck.generationCheck.details.some((d) => d.interface === 'image-generation' && d.shapeConsistent === true && d.fakeAccepted) && <div className="name-check-note warn">绘图接口上虚假名与真实名返回相同结构：请求可能都被路由到同一默认上游，名称真实性存疑。</div>}
            {model.nameCheck.generationCheck.details.some((d) => d.interface === 'image-generation' && d.echo && !sameModelName(d.echo, model.id)) && <div className="name-check-note warn">绘图接口回显型号与请求名不一致：名称疑似别名，真实型号可能为回显值。</div>}
          </>}
          {model.nameCheck.aliased === true && model.nameCheck.echoedModelId && <div className="name-check-note warn">端点用回显型号响应了「{model.id}」的请求：该名称可能是别名或占位名，真实对应型号很可能是「{model.nameCheck.echoedModelId}」。</div>}
          {model.nameCheck.aliased === false && model.nameCheck.echoedModelId && <div className="name-check-note good">端点回显与请求名一致（或仅版本号差异），该模型名称真实有效，能力验证结果针对该具体型号。</div>}
          {model.nameCheck.acceptsUnknownNames === true && <div className="name-check-note warn">端点对未知模型名「{model.nameCheck.probeModelId}」也返回成功：能力验证可能实际来自默认模型，不特定于该名称。</div>}
          {model.nameCheck.acceptsUnknownNames === false && <div className="name-check-note good">虚假模型名「{model.nameCheck.probeModelId}」被网关拒绝{model.nameCheck.probeRejection ? `（${model.nameCheck.probeRejection}）` : ''}：名称校验严格，能力验证结果针对该具体型号。</div>}
        </div>
      </section>}
      <section className="detail-section"><div className="subsection-heading"><strong>标准化能力</strong><span>状态与证据</span></div>
        <div className="capability-matrix">{capabilityKeys.map((key) => { const status = model.capabilities[key]; return <div className="capability-row" key={key}><span>{capabilityLabels[key]}</span><CapabilityBadge status={status} /><div className="evidence-list">{status.evidence.map((item, index) => <small key={`${item.timestamp}-${index}`}><b>{item.source}</b> · {item.confidence} · {item.detail}</small>)}{key === 'supportsReasoning' && model.reasoningLevels.length > 0 && <small><b>levels</b> · {model.reasoningLevels.join(', ')}</small>}</div></div>; })}</div>
      </section>
      <section className="detail-section"><div className="subsection-heading"><strong>OpenRouter 参照比对</strong><span>第三方目录只读比对</span></div>
        <ReferenceCompare model={model} reference={reference} onRetry={onRetryReference} />
      </section>
      <section className="detail-section"><div className="subsection-heading"><strong>最近请求</strong><span>已自动脱敏</span></div>{lastRequest ? <div className="last-request"><div><span className={`method method-${lastRequest.method.toLowerCase()}`}>{lastRequest.method}</span><code>{lastRequest.finalURL || lastRequest.url}</code><small>{lastRequest.status ?? '—'} · {lastRequest.durationMs ?? '—'}ms · {lastRequest.responseBytes != null ? `${Math.ceil(lastRequest.responseBytes / 1024)} KiB` : '—'}</small></div>{lastRequest.errorMessage ? <pre>{lastRequest.errorMessage}</pre> : <ResponsePreview value={lastRequest.responsePreview} />}</div> : <div className="log-empty compact">暂无请求记录。</div>}</section>
      <section className="detail-section"><button className="section-toggle" onClick={() => setRawOpen(!rawOpen)}><Braces size={15} />原始元数据 <span>{rawOpen ? '收起' : '展开'}</span></button>{rawOpen && <pre className="raw-viewer">{JSON.stringify(model.rawMetadata, null, 2)}</pre>}</section>
      <section className="detail-section"><div className="subsection-heading"><strong>模型配置</strong><div className="segmented"><button className={format === 'json' ? 'active' : ''} onClick={() => setFormat('json')}><FileJson size={13} />JSON</button><button className={format === 'yaml' ? 'active' : ''} onClick={() => setFormat('yaml')}><Code2 size={13} />YAML</button></div></div><div className="snippet-wrap"><button className="copy-snippet" title="复制配置" onClick={copy}><Clipboard size={14} /></button><pre>{modelSnippet(model, format)}</pre></div></section>
    </aside>
  );
}
