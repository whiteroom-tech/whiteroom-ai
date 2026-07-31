/** Labelled figure tile used in the onboarding fleet-status panel. */
export function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg p-4" style={{ background: '#070B14', border: '1px solid #15203A' }}>
      <p className="text-[11px] font-mono tracking-[.12em] uppercase" style={{ color: '#6B7C9E' }}>{label}</p>
      <p className="text-2xl font-display font-bold mt-1" style={{ color: '#EAF1FF' }}>{value}</p>
    </div>
  );
}
