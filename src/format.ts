// Pure rendering: turn agent events (tool calls, diffs, plans, results) into colored text rows.
// No console, no Ink, no React — just strings — so both the plain console UI (ui.ts, one-shot mode)
// and the Ink UI (app.tsx, interactive) render identically. Color is util.styleText (Node ≥20),
// gated on a TTY so piped/CI/NO_COLOR output stays plain and grep-able.
import { styleText } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { diffLines } from "./diff";
import { renderMarkdown, type Palette } from "./md";
import type { ModelInfo } from "./llm";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
type Style = Parameters<typeof styleText>[0];
type Color = Extract<Style, string>; // a single styleText color name (Style also allows an array of them)
const paint = (style: Style, s: string) => (useColor ? styleText(style, s) : s);

// --- primary accent color (configurable via /colors, persisted to ~/.minicode/color.txt) ---
// Stored as a hex string and rendered with 24-bit truecolor so any shade works — named terminal
// colors can't hit "dark orange". Falls back to plain text under NO_COLOR / non-TTY like every paint.
const COLOR_FILE = join(homedir(), ".minicode", "color.txt");
const DEFAULT_COLOR = "#ff8c00"; // dark orange

export const COLOR_PRESETS: { name: string; hex: string }[] = [
  { name: "orange", hex: "#ff8c00" },
  { name: "cyan", hex: "#22d3ee" },
  { name: "blue", hex: "#3b82f6" },
  { name: "green", hex: "#22c55e" },
  { name: "magenta", hex: "#d946ef" },
  { name: "purple", hex: "#a855f7" },
  { name: "red", hex: "#ef4444" },
  { name: "yellow", hex: "#eab308" },
];

const loadColor = (): string => {
  try {
    const v = readFileSync(COLOR_FILE, "utf8").trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : DEFAULT_COLOR;
  } catch {
    return DEFAULT_COLOR;
  }
};

let primaryHex = loadColor();
export const getPrimaryColor = () => primaryHex;

// Accepts a preset name or #rrggbb; resolves, applies for the session, and persists. Returns the hex
// or null when the input matches neither a preset nor a valid hex.
export function setPrimaryColor(input: string): string | null {
  const s = input.trim().toLowerCase();
  const hex = /^#[0-9a-f]{6}$/.test(s) ? s : COLOR_PRESETS.find((p) => p.name === s)?.hex;
  if (!hex) return null;
  primaryHex = hex;
  try {
    mkdirSync(join(homedir(), ".minicode"), { recursive: true });
    writeFileSync(COLOR_FILE, hex);
  } catch {
    /* best-effort persist; the session still uses the new color */
  }
  return hex;
}

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
// Paint a string in an arbitrary hex (used for /colors swatches); the accent itself uses c.primary.
export const paintHex = (hex: string, s: string) =>
  useColor ? `\x1b[38;2;${hexToRgb(hex).join(";")}m${s}\x1b[39m` : s;
const primaryPaint = (s: string) => paintHex(primaryHex, s);

export const c = {
  dim: (s: string) => paint("dim", s),
  bold: (s: string) => paint("bold", s),
  primary: (s: string) => primaryPaint(s),
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

// How the Markdown renderer paints spans — bold, italic, dim, primary headings, yellow inline code.
export const md: Palette = {
  bold: c.bold,
  italic: (s) => paint("italic", s),
  dim: c.dim,
  heading: (s) => primaryPaint(paint("bold", s)),
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
  spawn_agent: "Agent",
};

function displayArg(name: string, args: any): string {
  if (name === "run_bash") return clip(oneLine(String(args.command ?? "")), 56);
  if (typeof args.path === "string") return args.path;
  if (name === "update_plan") return Array.isArray(args.plan) ? `${args.plan.length} steps` : "";
  return clip(oneLine(JSON.stringify(args ?? {})), 56);
}

// Tool badge: an uppercase, background-filled chip ("READ" on color) — claude-code style, so the log
// scans by colored shape. Per-tool hue; failures go red, unknown tools fall back to gray. Black text on
// a bright fill reads on any terminal theme.
const BADGE_BG: Record<string, Color> = {
  read_file: "bgBlueBright",
  write_file: "bgGreenBright",
  edit_file: "bgGreenBright",
  run_bash: "bgYellowBright",
  update_plan: "bgMagentaBright",
  spawn_agent: "bgCyanBright",
};
const badge = (name: string, failed: boolean) => {
  const style: Color[] = [failed ? "bgRedBright" : BADGE_BG[name] ?? "bgGray", "black", "bold"];
  return paint(style, ` ${(VERB[name] ?? name).toUpperCase()} `);
};

// Delegation rendering, shared by the console log (ui.ts) and the Ink history (app.tsx) so a subagent
// reads the same in both. The header opens the block ( AGENT  goal); `rail` is the left gutter that
// nests everything the subagent does one level in, so its tool calls don't look like the parent's.
export const subHeader = (goal: string) => `${badge("spawn_agent", false)} ${c.dim(clip(oneLine(goal), 64))}`;
export const rail = (depth: number) => (depth > 0 ? c.dim("│ ".repeat(depth)) : "");

// Live-spinner words. The model phase gets a random gerund each turn so a wait reads like real work,
// not a frozen "thinking…"; tool calls get a present-tense action ("Reading…") instead of the raw name.
const THINKING_VERBS = [
  "Cogitating", "Pondering", "Ruminating", "Musing", "Noodling", "Conjuring",
  "Percolating", "Brewing", "Simmering", "Tinkering", "Wrangling", "Finagling",
  "Scheming", "Plotting", "Computing", "Synthesizing", "Deliberating", "Contemplating",
];
export const thinkingVerb = () => THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)];

const TOOL_GERUND: Record<string, string> = {
  read_file: "Reading",
  write_file: "Writing",
  edit_file: "Editing",
  run_bash: "Running",
  update_plan: "Planning",
};
export const toolVerb = (name: string) => TOOL_GERUND[name] ?? name;

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
  l.startsWith("[x]") ? c.green(`✓ ${l.slice(4)}`)
  : l.startsWith("[~]") ? c.primary(`▶ ${l.slice(4)}`)
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
    return [paintRow(`${total} line${total === 1 ? "" : "s"}`)]; // verb lives in the badge now
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

// One tool entry, fully formatted: a " READ " badge + arg header and the body rows (diff / write /
// preview). Shared by the console log and the Ink history so an entry looks the same in both.
export type ToolEntry = { failed: boolean; header: string; rows: string[] };
export function toolEntry(name: string, argsJson: string, result: string): ToolEntry {
  let args: any = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    /* keep {}; the header still renders */
  }
  const failed = result.startsWith("error:") || /^exit [1-9]/.test(result);
  let header = `${badge(name, failed)} ${c.dim(displayArg(name, args))}`;

  let rows: string[];
  if (failed) rows = previewRows(result, c.red);
  else if (name === "update_plan") rows = result.split("\n").filter(Boolean).map(iconize);
  else if (name === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string")
    rows = diffRows(args.old_string, args.new_string);
  else if (name === "write_file" && typeof args.content === "string") rows = writeRows(args.content);
  else rows = previewRows(result, c.dim, name);

  // A single-line body rides on the header (" READ  src/format.ts  15 lines"); multi-line bodies
  // (diffs, writes, long output) still drop into the ⎿ block below.
  if (rows.length === 1) {
    header = `${header}  ${rows[0]}`;
    rows = [];
  }

  return { failed, header, rows };
}

// A one-line model summary — "deepseek-v4-flash · 131K · $0.50/$1.50 per 1M" — for the footer status,
// /model, and /status. Falls back to the bare id when the catalog couldn't be reached.
export function describeModel(info: ModelInfo | undefined, id: string): string {
  if (!info) return id;
  const short = info.id.split("/").pop() ?? info.id;
  // Skip fields the provider didn't give us (OpenAI's /models lists ids only — no context/price).
  const parts = [short];
  if (info.context) parts.push(fmtTokens(info.context));
  if (info.promptPrice || info.completionPrice) parts.push(`${fmtPrice(info.promptPrice)}/${fmtPrice(info.completionPrice)} per 1M`);
  parts.push(c.dim(info.provider));
  return parts.join(" · ");
}

// The final result, rendered as markdown rows (the mark/timing is added by the caller per surface).
export function resultBody(summary: string): string[] {
  return renderMarkdown(summary.trim(), md).split("\n");
}

// The minion mascot, loaded from ascii-art.txt at the project root (edit that file to change it). Kept
// small by hand — a banner mascot wants a few crisp rows; a detailed photo decimated to this size just
// turns to noise. A missing/unreadable file falls back to a one-liner so a deleted asset can't crash startup.
const minionArt = ((): string[] => {
  try {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ascii-art.txt"), "utf8").replace(/\n+$/, "").split("\n");
  } catch {
    return ["(•◡•)"];
  }
})();

// An art line may lead with a 1-char colour key + "|" so one mascot is multi-coloured even though each
// line is painted as a whole (w hat · y body · b overalls · k outline/feet · o clipboard). The body (y)
// and overalls (b) wear the primary accent so the mascot blends with the chosen color; the rest keep
// fixed hues (white hat, gray goggles, red clipboard) so it still reads as a minion.
const ART_COLOR: Record<string, Style> = {
  w: ["whiteBright", "bold"],
  k: "gray",
  o: ["redBright", "bold"],
};
function artRow(line: string): { t: string; s: (x: string) => string } {
  if (line[1] !== "|") return { t: line, s: (x) => paintHex(primaryHex, paint("bold", x)) };
  const key = line[0];
  const t = line.slice(2);
  if (key === "y") return { t, s: (x) => paintHex(primaryHex, paint("bold", x)) };
  if (key === "b") return { t, s: (x) => paint("dim", paintHex(primaryHex, x)) };
  const style = ART_COLOR[key] ?? "dim";
  return { t, s: (x) => paint(style, x) };
}

// The bordered welcome card as colored rows — shared by the console banner (ui.ts) and the Ink
// scrollback (the first history item). Box characters, no TUI library; padding is on the plain text.
export function bannerLines(info: ModelInfo | undefined, id: string, cwd: string): string[] {
  const title = "MiniCode";
  const art = minionArt.map(artRow);
  const artW = Math.max(...art.map((a) => a.t.length));

  // The welcome text, set beside the mascot (claude-code style) rather than stacked under it.
  const text: { t: string; s?: (x: string) => string }[] = [
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

  // Pair the columns row-by-row, vertically centering the shorter (text) block against the taller (art).
  const height = Math.max(art.length, text.length);
  const top = Math.floor((height - text.length) / 2);
  const body = Array.from({ length: height }, (_, i) => {
    const a = art[i];
    const left = a ? a.s(a.t.padEnd(artW)) : " ".repeat(artW);
    const r = text[i - top];
    const right = r ? (r.s ? r.s(r.t) : c.dim(r.t)) : "";
    return `${left}    ${right}`;
  });

  // Blank padding rows top and bottom so the art breathes evenly inside the frame.
  const lines = ["", ...body, ""];

  // Full-width box: the frame extends end to end (claude-code style), content left-aligned inside.
  // Measure *visible* width so ANSI colour codes don't throw the right border off. -6 accounts for
  // the 2-space indent in the Ink UI + the "│ " / " │" borders on each side.
  const contentW = Math.max(...lines.map(visibleLen));
  const w = Math.max(contentW, termWidth() - 6);
  const pad = (s: string) => s + " ".repeat(w - visibleLen(s));

  // Top border with the title embedded top-left: ╭─ MiniCode ──…──╮. The title wears the primary
  // accent; the dashes fill the rest so the rule matches the bottom border's visible width (w + 4).
  const titleStr = c.bold(c.primary(title));
  const titleW = visibleLen(titleStr);
  const topRule = c.primary("╭─ ") + titleStr + c.primary(" " + "─".repeat(Math.max(0, w - titleW - 1)) + "╮");
  const bottomRule = c.primary("╰" + "─".repeat(w + 2) + "╯");
  return [topRule, ...lines.map((s) => `${c.primary("│")} ${pad(s)} ${c.primary("│")}`), bottomRule];
}
