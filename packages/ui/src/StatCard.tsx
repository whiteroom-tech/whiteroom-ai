import { color } from './theme';

/** Labelled figure tile used in the onboarding fleet-status panel. */
export function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg p-4" style={{ background: color.sunk, border: `1px solid ${color.line}` }}>
      <p className="text-[11px] font-mono tracking-[.12em] uppercase" style={{ color: color.tx2 }}>{label}</p>
      <p className="text-2xl font-display font-bold mt-1" style={{ color: color.tx }}>{value}</p>
    </div>
  );
}
