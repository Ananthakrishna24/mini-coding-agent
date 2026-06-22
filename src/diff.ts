// Minimal line-level diff for the CLI's per-edit view — no dependency. Classic LCS table, then
// walk it into "-" (removed) / "+" (added) / " " (kept) lines, unified-diff style.
// ponytail: O(n*m) time and memory — fine for an edit-sized block, not for diffing whole files.
export type DiffLine = { tag: " " | "-" | "+"; text: string };

export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ tag: "-", text: a[i++] });
    } else {
      out.push({ tag: "+", text: b[j++] });
    }
  }
  while (i < n) out.push({ tag: "-", text: a[i++] });
  while (j < m) out.push({ tag: "+", text: b[j++] });
  return out;
}
