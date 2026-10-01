import { Icon, type IconName } from './icons';

export type BannerVariant = 'warn' | 'info' | 'error';

const ICON: Record<BannerVariant, IconName> = { warn: 'alert', info: 'info', error: 'alertCircle' };

/**
 * Warn (warnBg fill), info (card) and error (card with a bad border). Error
 * banners are role="alert" and stay until the person acts on them.
 */
export function Banner({ variant = 'info', icon, children, actions }: {
  variant?: BannerVariant;
  icon?: IconName;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    // Errors interrupt (alert); everything else is announced politely
    // (status), so "Profile saved." reaches screen readers too.
    <div className={`wr-banner wr-banner--${variant}`} role={variant === 'error' ? 'alert' : 'status'}>
      <span className="wr-banner__icon"><Icon name={icon ?? ICON[variant]} size={18} /></span>
      <div className="wr-banner__body">{children}</div>
      {actions && <div className="wr-banner__actions">{actions}</div>}
    </div>
  );
}
