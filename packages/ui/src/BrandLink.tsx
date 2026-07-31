import { Logo } from './Logo';

// WhiteRoom logo + wordmark linking to the marketing site. Shared by the
// onboarding and sign-in headers, which used identical markup.
export function BrandLink() {
  return (
    <a href="https://whiteroom.tech" className="flex items-center gap-2.5" style={{ textDecoration: 'none' }}>
      <Logo width={30} height={42} gradientId="wr-lit" />
      <span className="font-sans font-black text-[32px] leading-none" style={{ letterSpacing: '-.02em' }}>
        <span style={{ color: '#EAF1FF' }}>White</span>
        <span style={{ color: '#38E1FF' }}>Room</span>
      </span>
    </a>
  );
}
