import { Check, CircleHelp, Sparkles, X } from 'lucide-react';
import { capabilityValueLabels } from '../domain/capabilities';
import type { CapabilityStatus } from '../domain/types';

export function CapabilityBadge({ status, compact = false }: { status: CapabilityStatus; compact?: boolean }) {
  const Icon = status.value === 'supported' ? Check : status.value === 'unsupported' ? X : status.value === 'inferred' ? Sparkles : CircleHelp;
  return (
    <span className={`cap-badge cap-${status.value}`} title={status.evidence[0]?.detail}>
      <Icon size={13} aria-hidden="true" />
      {!compact && capabilityValueLabels[status.value]}
      {compact && <span className="sr-only">{capabilityValueLabels[status.value]}</span>}
    </span>
  );
}
