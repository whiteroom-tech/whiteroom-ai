'use client';

import { useEffect, useState } from 'react';
import { SegmentedControl } from '@whiteroom/ui';
import { TEXT_SIZES, TEXT_SIZE_CHANGED, TEXT_SIZE_SHORT, chooseTextSize, parseTextSize, type TextSize } from '@/lib/text-size';

/**
 * Default / Large / Larger (compact: A / A+ / A++, in the sidebar). Takes
 * effect at once, is remembered on this browser, and every copy on the page
 * follows a change made in another.
 */
export function TextSizeControl({ size = 26, compact = false }: { size?: 24 | 26; compact?: boolean }) {
  const [value, setValue] = useState<TextSize>('md');
  useEffect(() => {
    // What the page shows (<html data-wr-text>), not storage: with storage
    // blocked a choice still applies for this visit, and the control keeps it.
    const read = () => setValue(parseTextSize(document.documentElement.getAttribute('data-wr-text')));
    read();
    window.addEventListener(TEXT_SIZE_CHANGED, read);
    return () => window.removeEventListener(TEXT_SIZE_CHANGED, read);
  }, []);
  return (
    <SegmentedControl<TextSize>
      label="Text size"
      value={value}
      onChange={(v) => { setValue(v); chooseTextSize(v); }}
      size={size}
      options={compact
        ? TEXT_SIZES.map((o) => ({ value: o.value, label: TEXT_SIZE_SHORT[o.value], ariaLabel: `${o.label} text size` }))
        : TEXT_SIZES}
    />
  );
}
