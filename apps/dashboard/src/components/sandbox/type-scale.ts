// The Sandbox's type floor, in one place: no text is smaller than MIN_TEXT_PX.
// Sizes now come from the shared --fs-* rem tokens in globals.css (smallest is
// 14px), so no class needs an exception; add one here only if that changes.

export const MIN_TEXT_PX = 12;

/** guided.module.css classes allowed below MIN_TEXT_PX. */
export const SMALL_LABEL_CLASSES: readonly string[] = [];
