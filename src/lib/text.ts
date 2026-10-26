/** Reject lone UTF-16 surrogates without rejecting Persian, ZWNJ or emoji pairs. */
export function wellFormedText(value: string): boolean {
  return !Array.from(value).some((char) => {
    const n = char.codePointAt(0)!;
    return n >= 0xd800 && n <= 0xdfff;
  });
}

/** Bound display text in UTF-16 units without creating a lone high surrogate at the cut. */
export function clipText(value: string, max: number): string {
  const clipped = value.slice(0, max);
  return /[\ud800-\udbff]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}
