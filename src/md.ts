// Tiny Markdown → terminal renderer for the agent's final answer. No dependency, no CommonMark
// ambition: headings, bold/italic/inline-code, bullet & numbered lists, blockquotes, fenced code,
// and GitHub pipe tables — the shapes a coding agent actually emits.
// ponytail: naive line/regex parser, not a real one. Nested emphasis or exotic Markdown may render
// imperfectly; reach for a parser lib only if this output is ever consumed as a real document.

export type Palette = {
  bold: (s: string) => string;
  italic: (s: string) => string;
  dim: (s: string) => string;
  heading: (s: string) => string;
  code: (s: string) => string;
};

// Inline spans. Code spans are stashed behind a placeholder before emphasis runs, so their contents
// (e.g. `a*b*c`) aren't re-parsed as bold/italic, then restored at the end. Bold before italic so
// `**` wins over `*`. Only `*italic*` (not `_italic_`) — underscores collide with snake_case names.
const STASH = String.fromCharCode(0xe000); // a private-use char that won't occur in real text

function inline(s: string, p: Palette): string {
  const code: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, x) => `${STASH}${code.push(p.code(x)) - 1}${STASH}`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, (_m, x) => p.bold(x))
    .replace(/__([^_]+)__/g, (_m, x) => p.bold(x))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, a, x) => a + p.italic(x))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, (_m, t) => p.italic(t));
  return s.replace(new RegExp(`${STASH}(\\d+)${STASH}`, "g"), (_m, i) => code[+i]);
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes("-");
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim());

// A pipe table → aligned columns: bold header, a dim rule, plain rows. No vertical bars, cleaner.
function renderTable(rows: string[][], p: Palette): string[] {
  const cols = Math.max(...rows.map((r) => r.length));
  const width = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const pad = (r: string[]) => width.map((w, i) => (r[i] ?? "").padEnd(w)).join("  ");
  const [head, ...body] = rows;
  return [p.bold(pad(head)), p.dim(width.map((w) => "─".repeat(w)).join("  ")), ...body.map((r) => inline(pad(r), p))];
}

export function renderMarkdown(src: string, p: Palette): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      inFence = !inFence; // drop the fence markers; show the code plainly
      continue;
    }
    if (inFence) {
      out.push(p.dim(line));
      continue;
    }

    // table: a header row immediately followed by a separator row
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const tbl = [cells(line)];
      i += 2; // skip header + separator
      while (i < lines.length && isRow(lines[i])) tbl.push(cells(lines[i++]));
      i--; // the for-loop will ++ back
      out.push(...renderTable(tbl, p));
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(p.heading(inline(h[2], p)));
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}  • ${inline(bullet[2], p)}`);
      continue;
    }

    const num = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (num) {
      out.push(`${num[1]}  ${num[2]}. ${inline(num[3], p)}`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(p.dim(`  ┃ ${inline(quote[1], p)}`));
      continue;
    }

    out.push(inline(line, p));
  }

  return out.join("\n");
}
