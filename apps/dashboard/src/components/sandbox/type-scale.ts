// The Sandbox's type floor, in one place: detail text is never smaller than
// MIN_TEXT_PX. Only the classes below may be: mono uppercase labels (eyebrows,
// the "What the test checks" header), the mode badge and the checklist dots'
// icon size. They are labels, not text anyone has to read for details.

export const MIN_TEXT_PX = 12;

/** guided.module.css classes allowed below MIN_TEXT_PX. */
export const SMALL_LABEL_CLASSES: readonly string[] = ['badgeMode', 'diagDot', 'eyebrow', 'previewHeader'];
