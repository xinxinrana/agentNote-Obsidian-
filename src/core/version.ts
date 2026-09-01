/**
 * Version comparison for self-updates from GitHub Releases.
 * Pure and dependency-free so the e2e bundle can cover it.
 */

/** True when `latest` is strictly newer than `current`.
 *  Accepts "0.2.0", "v0.10.1", "0.1"; numeric segments only. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value.trim().replace(/^v/i, "").split(/[.-]/).map((part) => parseInt(part, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
