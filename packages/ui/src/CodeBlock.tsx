import { CopyButton } from './CopyButton';

/** A labelled, copyable code snippet (onboarding setup steps). */
export function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-mono tracking-[.12em] uppercase" style={{ color: '#6B7C9E' }}>{label}</p>
      <div className="flex items-center rounded-lg px-4 py-3" style={{ background: '#070B14', border: '1px solid #15203A' }}>
        <code className="text-sm font-mono flex-1 break-all" style={{ color: '#38E1FF' }}>{code}</code>
        <CopyButton text={code} />
      </div>
    </div>
  );
}
