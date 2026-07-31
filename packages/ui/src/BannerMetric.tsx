import { FONT_DISPLAY } from './theme';

/** A single KPI in the fleet dashboard's metric banner. */
export function BannerMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10, letterSpacing: 1.5, marginBottom: 4, color: '#64748b' }}>{label}</div>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 22, fontWeight: 700, color, transition: 'all 0.3s' }}>{value}</div>
    </div>
  );
}
