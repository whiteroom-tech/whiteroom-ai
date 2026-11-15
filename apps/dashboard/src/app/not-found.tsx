import Link from 'next/link';
import { BrandLink } from '@whiteroom/ui';
import { ROUTES } from '@/lib/routes';

/** Any address the dashboard doesn't have. */
export default function NotFound() {
  return (
    <main className="wr-shell wr-stop">
      <BrandLink />
      <h1 className="wr-stop__title">Page not found</h1>
      <p className="wr-stop__text">This address doesn’t match a page. It may have moved.</p>
      <Link href={ROUTES.home} className="wr-btn wr-btn--primary wr-btn--h32">Go to Home</Link>
    </main>
  );
}
