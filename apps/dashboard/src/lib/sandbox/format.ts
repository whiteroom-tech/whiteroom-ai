export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function assertionLabel(key: string): string {
  const labels: Record<string, string> = {
    basic_connect: 'Connection',
    watch_expiry: 'Watch & Handoff',
    handover_roundtrip: 'Resumption',
    context_compression: 'Compression',
    compliance_gate: 'Compliance',
    graceful_disconnect: 'Disconnect Recovery',
    multi_agent_relay: 'Multi-Agent Relay',
    policy_observed: 'Policy Observed',
    policy_enforced: 'Policy Enforced',
    policy_decision_audited: 'Policy Audited',
  };
  return labels[key] ?? key;
}

export function statusIcon(status: string): string {
  if (status === 'observed') return '✓';
  if (status === 'failed') return '✗';
  return '○';
}

export function statusColor(status: string): string {
  if (status === 'observed') return 'var(--ok)';
  if (status === 'failed') return 'var(--err, var(--bad))';
  return 'var(--tx3)';
}
