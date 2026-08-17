import { AlertTriangle, Check, ChevronRight, Circle, Clock3, LoaderCircle, X } from 'lucide-react';
import { useState } from 'react';
import type { DiscoveryRun, RequestRecord } from '../domain/types';

const StepIcon = ({ status }: { status: string }) => status === 'running' ? <LoaderCircle className="spin" size={15} /> : status === 'success' ? <Check size={15} /> : status === 'error' || status === 'cancelled' ? <X size={15} /> : status === 'warning' ? <AlertTriangle size={15} /> : <Circle size={12} />;

function RequestItem({ request }: { request: RequestRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="request-item">
      <button className="request-summary" onClick={() => setOpen(!open)}>
        <ChevronRight className={open ? 'rotated' : ''} size={15} /><span className={`method method-${request.method.toLowerCase()}`}>{request.method}</span><code>{request.finalURL || request.url}</code>
        <span className="request-metrics">{request.status ?? '—'} · {request.durationMs ?? '—'}ms · {request.responseBytes != null ? `${Math.ceil(request.responseBytes / 1024)} KiB` : '—'}{request.retryCount ? ` · 重试 ${request.retryCount}` : ''}</span>
      </button>
      {open && <div className="request-detail">
        <div><span>脱敏 Headers</span><pre>{JSON.stringify(request.requestHeaders, null, 2)}</pre></div>
        {request.requestBody != null && <div><span>请求体摘要</span><pre>{JSON.stringify(request.requestBody, null, 2)}</pre></div>}
        <div><span>响应预览</span><pre>{request.errorMessage || JSON.stringify(request.responsePreview, null, 2)}</pre></div>
      </div>}
    </div>
  );
}

export function ProbeLog({ run }: { run?: DiscoveryRun }) {
  if (!run) return <div className="log-empty">探测开始后，这里会显示步骤时间线和每个已脱敏请求。</div>;
  return (
    <div className="probe-log">
      <div className="timeline">
        {run.steps.map((step) => <div className={`timeline-step step-${step.status}`} key={step.id}><span className="step-icon"><StepIcon status={step.status} /></span><div><strong>{step.name}</strong><small>{step.summary || '等待执行'}</small></div><span className="step-duration"><Clock3 size={12} />{step.durationMs != null ? `${step.durationMs}ms` : '—'}</span></div>)}
      </div>
      <div className="request-list">
        <div className="subsection-heading"><strong>请求检查</strong><span>{run.requests.length} 个请求</span></div>
        {run.requests.map((request) => <RequestItem request={request} key={request.id} />)}
        {run.requests.length === 0 && <div className="log-empty compact">尚未发起网络请求。</div>}
      </div>
    </div>
  );
}
