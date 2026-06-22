// Pure rendering: turn agent events (tool calls, diffs, plans, results) into colored text rows.
// No console, no Ink, no React — just strings — so both the plain console UI (ui.ts, one-shot mode)
// and the Ink UI (app.tsx, interactive) render identically. Color is util.styleText (Node ≥20),
// gated on a TTY so piped/CI/NO_COLOR output stays plain and grep-able.
import { styleText } from "node:util";
import { diffLines } from "./diff";
import { renderMarkdown, type Palette } from "./md";
import type { ModelInfo } from "./llm";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
type Style = Parameters<typeof styleText>[0];
const paint = (style: Style, s: string) => (useColor ? styleText(style, s) : s);

export const c = {
  dim: (s: string) => paint("dim", s),
  bold: (s: string) => paint("bold", s),
  cyan: (s: string) => paint("cyan", s),
  green: (s: string) => paint("green", s),
  red: (s: string) => paint("red", s),
  yellow: (s: string) => paint("yellow", s),
};

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const termWidth = () => process.stdout.columns || 80;

// Human sizes: 131072 → "131K", 1048576 → "1.0M"; prices as plain dollars.
export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${n}`);
export const fmtPrice = (p: number) => `$${p.toFixed(2)}`;

// Visible width ignoring ANSI color codes, and a word-wrapper that respects it — long output folds
// at the window edge instead of running off it. Soft-wraps on spaces; a single token wider than the
// window (a long URL or path) still overflows — fine for the prose this wraps.
const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleLen = (s: string) => s.replace(ANSI, "").length;
export function wrap(s: string, width: number): string[] {
  if (width < 8 || visibleLen(s) <= width) return [s];
  const out: string[] = [];
  let cur = "";
  for (const word of s.split(/(\s+)/)) {
    if (cur && visibleLen(cur) + visibleLen(word) > width) {
      out.push(cur.replace(/\s+$/, ""));
      cur = word.replace(/^\s+/, "");
    } else {
      cur += word;
    }
  }
  out.push(cur.replace(/\s+$/, ""));
  return out;
}

// How the Markdown renderer paints spans — bold, italic, dim, cyan headings, yellow inline code.
export const md: Palette = {
  bold: c.bold,
  italic: (s) => paint("italic", s),
  dim: c.dim,
  heading: (s) => paint(["bold", "cyan"], s),
  code: (s) => paint("yellow", s),
};

// A friendlier name + the one argument worth showing, so the log reads "Update(src/foo.ts)" rather
// than dumping raw JSON. Unknown tools fall back to their real name and stringified args.
const VERB: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Update",
  run_bash: "Bash",
  update_plan: "Plan",
};

function displayArg(name: string, args: any): string {
  if (name === "run_bash") return clip(oneLine(String(args.command ?? "")), 56);
  if (typeof args.path === "string") return args.path;
  if (name === "update_plan") return Array.isArray(args.plan) ? `${args.plan.length} steps` : "";
  return clip(oneLine(JSON.stringify(args ?? {})), 56);
}

const MAX_ROWS = 16;
const rowWidth = () => termWidth() - 8; // diff/write content width, leaving room for the gutter

// Red/green +/- diff of an edit, capped so a huge edit can't flood the log. Counts in a trailing line.
function diffRows(oldStr: string, newStr: string): string[] {
  const d = diffLines(oldStr.split("\n"), newStr.split("\n"));
  const adds = d.filter((l) => l.tag === "+").length;
  const dels = d.filter((l) => l.tag === "-").length;
  const rows = d.slice(0, MAX_ROWS).map((l) => {
    const t = clip(l.text, rowWidth());
    if (l.tag === "+") return c.green(`+ ${t}`);
    if (l.tag === "-") return c.red(`- ${t}`);
    return c.dim(`  ${t}`);
  });
  if (d.length > MAX_ROWS) rows.push(c.dim(`… ${d.length - MAX_ROWS} more lines`));
  rows.push(c.dim(`+${adds} -${dels}`));
  return rows;
}

// A whole-file write shows its content as additions (no prior content here to diff against).
function writeRows(content: string): string[] {
  const lines = content.split("\n");
  const rows = lines.slice(0, MAX_ROWS).map((l) => c.green(`+ ${clip(l, rowWidth())}`));
  if (lines.length > MAX_ROWS) rows.push(c.dim(`… +${lines.length - MAX_ROWS} more lines`));
  return rows;
}

// update_plan returns lines like "[x] step"; map each marker to a colored status icon.
export const iconize = (l: string): string =>
  l.startsWith("[x]") ? c.green(`✔ ${l.slice(4)}`)
  : l.startsWith("[~]") ? c.cyan(`▶ ${l.slice(4)}`)
  : l.startsWith("[ ]") ? c.dim(`☐ ${l.slice(4)}`)
  : l;

// A short, word-wrapped preview of a tool result — a few lines, the rest summarized — so a noisy bash
// dump or whole-file read can't run off the right edge or flood the log. read_file is special-cased
// to a line count (echoing the file back is pure noise). `paint` colors the rows.
const PREVIEW_ROWS = 4;
function previewRows(result: string, paintRow: (s: string) => string, name?: string): string[] {
  if (name === "read_file") {
    const m = result.match(/^# lines \d+-(\d+) of (\d+)/);
    const total = m ? Number(m[2]) : result.replace(/\n+$/, "").split("\n").length;
    return [paintRow(`Read ${total} line${total === 1 ? "" : "s"}`)];
  }
  const src = result.replace(/\n+$/, "").split("\n");
  const rows: string[] = [];
  let used = 0;
  for (; used < src.length && rows.length < PREVIEW_ROWS; used++) {
    for (const w of wrap(src[used], rowWidth())) {
      if (rows.length >= PREVIEW_ROWS) break;
      rows.push(paintRow(w));
    }
  }
  const left = src.length - used;
  if (left > 0) rows.push(c.dim(`… +${left} line${left === 1 ? "" : "s"}`));
  return rows;
}

// One tool entry, fully formatted: the ⏺ Verb(arg) header and the body rows (diff / write / preview).
// Shared by the console log and the Ink history so an entry looks the same in both.
export type ToolEntry = { failed: boolean; header: string; rows: string[] };
export function toolEntry(name: string, argsJson: string, result: string): ToolEntry {
  let args: any = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    /* keep {}; the header still renders */
  }
  const failed = result.startsWith("error:") || /^exit [1-9]/.test(result);
  const dot = failed ? c.red("⏺") : c.cyan("⏺");
  const header = `${dot} ${c.bold(VERB[name] ?? name)}${c.dim(`(${displayArg(name, args)})`)}`;

  let rows: string[];
  if (failed) rows = previewRows(result, c.red);
  else if (name === "update_plan") rows = result.split("\n").filter(Boolean).map(iconize);
  else if (name === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string")
    rows = diffRows(args.old_string, args.new_string);
  else if (name === "write_file" && typeof args.content === "string") rows = writeRows(args.content);
  else rows = previewRows(result, c.dim, name);

  return { failed, header, rows };
}

// A one-line model summary — "deepseek-v4-flash · 131K · $0.50/$1.50 per 1M" — for the footer status,
// /model, and /status. Falls back to the bare id when the catalog couldn't be reached.
export function describeModel(info: ModelInfo | undefined, id: string): string {
  if (!info) return id;
  const short = info.id.split("/").pop() ?? info.id;
  return `${short} · ${fmtTokens(info.context)} · ${fmtPrice(info.promptPrice)}/${fmtPrice(info.completionPrice)} per 1M`;
}

// The final result, rendered as markdown rows (the mark/timing is added by the caller per surface).
export function resultBody(summary: string): string[] {
  return renderMarkdown(summary.trim(), md).split("\n");
}

// The bordered welcome card as colored rows — shared by the console banner (ui.ts) and the Ink
// scrollback (the first history item). Box characters, no TUI library; padding is on the plain text.
export function bannerLines(info: ModelInfo | undefined, id: string, cwd: string): string[] {
  const minion = (x: string) => c.bold(c.yellow(x)); // minions are yellow — the brand mark wears it
  const rows: { t: string; s?: (x: string) => string }[] = [
    // a goggled minion: capsule body, two goggle eyes joined by a strap, a smile, and two little feet.
    { t: "╭─────────╮", s: minion },
    { t: "│ ◉  ─  ◉ │  minion code", s: minion },
    { t: "│         │", s: minion },
    { t: "│  ╲___╱  │", s: minion },
    { t: "╰──┬───┬──╯", s: minion },
    { t: "   ╹   ╹", s: minion },
    { t: "" },
    { t: `model    ${info?.id ?? id}` },
    ...(info
      ? [
          { t: `context  ${fmtTokens(info.context)} tokens` },
          { t: `price    ${fmtPrice(info.promptPrice)} in · ${fmtPrice(info.completionPrice)} out / 1M` },
        ]
      : []),
    { t: `dir      ${clip(cwd, 48)}` },
    { t: "" },
    { t: "type a goal  ·  /help for commands  ·  'exit' to quit" },
  ];
  const w = Math.max(...rows.map((r) => r.t.length));
  const rule = (l: string, r: string) => c.cyan(l + "─".repeat(w + 2) + r);
  return [
    rule("╭", "╮"),
    ...rows.map((row) => {
      const padded = row.t.padEnd(w);
      return `${c.cyan("│")} ${row.s ? row.s(padded) : c.dim(padded)} ${c.cyan("│")}`;
    }),
    rule("╰", "╯"),
  ];
}
