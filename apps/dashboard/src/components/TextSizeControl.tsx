'use client';

import { useEffect, useState } from 'react';
import { SegmentedControl } from '@whiteroom/ui';
import { TEXT_SIZES, chooseTextSize, storedTextSize, type TextSize } from '@/lib/text-size';

/** Default / Large / Larger. Takes effect at once and is remembered on this browser. */
export function TextSizeControl({ size = 26 }: { size?: 24 | 26 }) {
  const [value, setValue] = useState<TextSize>('md');
  useEffect(() => { setValue(storedTextSize()); }, []);
  return (
    <SegmentedControl<TextSize>
      label="Text size"
      value={value}
      onChange={(v) => { setValue(v); chooseTextSize(v); }}
      size={size}
      options={TEXT_SIZES}
    />
  );
}
