import { Check, CircleHelp, Sparkles, X } from 'lucide-react';
import type { CapabilityStatus } from '../domain/types';

const labels = { supported: '支持', unsupported: '不支持', unknown: '未知', inferred: '推测' } as const;

export function CapabilityBadge({ status, compact = false }: { status: CapabilityStatus; compact?: boolean }) {
  const Icon = status.value === 'supported' ? Check : status.value === 'unsupported' ? X : status.value === 'inferred' ? Sparkles : CircleHelp;
  return (
    <span className={`cap-badge cap-${status.value}`} title={status.evidence[0]?.detail}>
      <Icon size={13} aria-hidden="true" />
      {!compact && labels[status.value]}
      {compact && <span className="sr-only">{labels[status.value]}</span>}
    </span>
  );
}
