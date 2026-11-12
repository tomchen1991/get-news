/** Narrow structural exclusions, not a news-quality classifier or score cutoff. */
export function isNonNewsPage(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return /(^|\.)ign\.com$/i.test(url.hostname) && /^\/playlist(?:\/|$)/i.test(url.pathname);
  } catch { return true; }
}
/** Overlap even after a successful search: search results are never exhaustive.
 * Low-frequency/missed runs retain coverage, bounded to fourteen days.
 */
export function collectionSince(now: number, gapDays: number, lastSuccess?: number): number {
  return Math.max(now - 14 * 86400000, Math.min(now - (gapDays + 1) * 86400000, lastSuccess ?? now));
}
