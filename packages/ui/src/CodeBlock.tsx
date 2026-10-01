import { CopyButton } from './CopyButton';
import { color } from './theme';

/** A labelled, copyable code snippet (onboarding setup steps). */
export function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-mono tracking-[.12em] uppercase" style={{ color: color.tx2 }}>{label}</p>
      <div className="flex items-center rounded-lg px-4 py-3" style={{ background: color.sunk, border: `1px solid ${color.line}` }}>
        <code className="text-sm font-mono flex-1 break-all whitespace-pre-wrap" style={{ color: color.brand }}>{code}</code>
        <CopyButton text={code} />
      </div>
    </div>
  );
}
