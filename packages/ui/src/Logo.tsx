// The WhiteRoom mark. Rendered in the onboarding, sign-in, and fleet-login
// headers. Size and gradient id are configurable so each placement keeps its
// own dimensions and a document-unique gradient id.
export function Logo({
  width = 30,
  height = 42,
  gradientId = 'wr-lit',
  className = 'shrink-0',
}: {
  width?: number;
  height?: number;
  gradientId?: string;
  className?: string;
}) {
  return (
    <svg className={className} width={width} height={height} viewBox="0 0 22 30" fill="none">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7AECFF" />
          <stop offset="1" stopColor="#22C8EC" />
        </linearGradient>
      </defs>
      <rect x=".5" y=".5" width="21" height="29" rx="3" fill="#EAF1FF" />
      <rect x="3" y="3" width="7" height="11" fill="#0B1018" />
      <rect x="12" y="3" width="7" height="11" fill={`url(#${gradientId})`} />
      <rect x="3" y="16" width="7" height="11" fill="#0B1018" />
      <rect x="12" y="16" width="7" height="11" fill="#0B1018" />
    </svg>
  );
}
