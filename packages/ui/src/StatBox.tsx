import { FONT_MONO } from './theme';

/** Compact stat tile (mono value) used in the fleet agent cards. */
export function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ borderRadius: 4, textAlign: 'center', padding: '4px 6px', background: '#050810', border: '1px solid #0f172a' }}>
      <div style={{ fontSize: 9, letterSpacing: 0.5, marginBottom: 2, color: '#475569' }}>{label}</div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}
