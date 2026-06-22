// Terminal UI: color, a spinner, and the run-log rendering the agent reports through.
// Native only — util.styleText for color (Node ≥20), no chalk/ora. Everything degrades to plain
// text when stdout isn't a TTY (piped, CI, NO_COLOR), so the output stays readable and grep-able.
import { styleText } from "node:util";
import { homedir } from "node:os";
import { diffLines } from "./diff";
import { renderMarkdown, type Palette } from "./md";

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
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const termWidth = () => process.stdout.columns || 80;

// Visible width ignoring ANSI color codes, and a word-wrapper that respects it — long output folds
// at the window edge instead of running off it. ponytail: soft-wraps on spaces; a single token wider
// than the window (a long URL or path) still overflows — fine for the prose this wraps.
const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLen = (s: string) => s.replace(ANSI, "").length;
function wrap(s: string, width: number): string[] {
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
const md: Palette = {
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

// Print rows under the tool header with the ⎿ connector on the first line only — the rest align.
function block(rows: string[]): void {
  rows.forEach((row, i) => console.log(`    ${c.dim(i === 0 ? "⎿" : " ")} ${row}`));
}

const MAX_ROWS = 16;
const rowWidth = () => termWidth() - 8; // diff/write content width, leaving room for the gutter

// Red/green +/- diff of an edit, the way a real diff viewer shows it, capped so a huge edit can't
// flood the log. Counts go in a trailing summary line.
function diffBlock(oldStr: string, newStr: string): void {
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
  block(rows);
}

// A whole-file write shows its content as additions (we don't have the prior content here to diff).
function writeBlock(content: string): void {
  const lines = content.split("\n");
  const rows = lines.slice(0, MAX_ROWS).map((l) => c.green(`+ ${clip(l, rowWidth())}`));
  if (lines.length > MAX_ROWS) rows.push(c.dim(`… +${lines.length - MAX_ROWS} more lines`));
  block(rows);
}

// A plan/todo list → a checklist with status icons, the way a task tracker shows it. update_plan
// returns lines like "[x] step"; map each marker to an icon + color.
function planBlock(result: string): void {
  const rows = result.split("\n").map((l) => {
    if (l.startsWith("[x]")) return c.green(`✔ ${l.slice(4)}`);
    if (l.startsWith("[~]")) return c.cyan(`▶ ${l.slice(4)}`);
    if (l.startsWith("[ ]")) return c.dim(`☐ ${l.slice(4)}`);
    return l;
  });
  block(rows);
}

// What the agent loop reports through. Implemented by createUI; required by run() so a run is
// never silently chatty via console.* — all output goes through one place we can restyle.
export type UI = {
  thinking: (on: boolean, label?: string) => void;
  tool: (name: string, args: string, result: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
};

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR = "\r\x1b[K"; // carriage return + clear-to-end-of-line

export function createUI(): UI {
  let timer: ReturnType<typeof setInterval> | null = null;
  let i = 0;

  // One spinner, reused for both the model call and slow tools (pass the tool name as label).
  function thinking(on: boolean, label = "thinking") {
    if (!useColor) return; // no spinner when piped; the result lines below still print
    if (on) {
      if (timer) return;
      process.stdout.write(HIDE);
      timer = setInterval(() => {
        process.stdout.write(`${CLEAR}  ${c.cyan(SPIN[(i = (i + 1) % SPIN.length)])} ${c.dim(label + "…")}`);
      }, 80);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
      process.stdout.write(CLEAR + SHOW);
    }
  }

  // ⏺ Verb(arg), then a body: a diff for edits, added lines for writes, the error or a one-line
  // preview otherwise — the Claude-Code-style entry.
  function tool(name: string, argsJson: string, result: string) {
    let args: any = {};
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      /* keep {}; the header still renders */
    }
    const failed = result.startsWith("error:") || /^exit [1-9]/.test(result);
    const dot = failed ? c.red("⏺") : c.cyan("⏺");
    console.log(`  ${dot} ${c.bold(VERB[name] ?? name)}${c.dim(`(${displayArg(name, args)})`)}`);

    if (failed) return block([c.red(clip(oneLine(result), termWidth() - 6))]);
    if (name === "update_plan") return planBlock(result);
    if (name === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string") {
      return diffBlock(args.old_string, args.new_string);
    }
    if (name === "write_file" && typeof args.content === "string") return writeBlock(args.content);
    block([c.dim(clip(oneLine(result), termWidth() - 6))]);
  }

  const warn = (m: string) => console.log(c.yellow(`  ! ${m}`));
  const debug = (m: string) => void (process.env.DEBUG && console.log(c.dim(`  ~ ${m}`)));

  return { thinking, tool, warn, debug };
}

// Restore the cursor on any exit — Ctrl-C kills the spinner mid-frame with the cursor still hidden.
process.on("exit", () => useColor && process.stdout.write(SHOW));

// --- top-level render helpers, used by the CLI shell (index.ts), not the agent loop ---

const shortCwd = () => process.cwd().replace(homedir(), "~");

// A bordered welcome card, drawn with box characters — no TUI library. Padding is computed on the
// plain text (before color) so the right border stays aligned. ponytail: a static card, not a live
// framed input — readline can't border text as you type without raw-mode keypress rendering.
export function banner(model: string) {
  const rows: { t: string; s?: (x: string) => string }[] = [
    { t: "◆ mini-coding-agent", s: (x) => paint(["bold", "cyan"], x) },
    { t: "" },
    { t: `model   ${model}` },
    { t: `dir     ${clip(shortCwd(), 48)}` },
    { t: "" },
    { t: "type a goal  ·  'exit' or Ctrl-C to quit" },
  ];
  const w = Math.max(...rows.map((r) => r.t.length));
  const rule = (l: string, r: string) => c.cyan(l + "─".repeat(w + 2) + r);
  console.log("\n" + rule("╭", "╮"));
  for (const row of rows) {
    const padded = row.t.padEnd(w);
    console.log(`${c.cyan("│")} ${row.s ? row.s(padded) : c.dim(padded)} ${c.cyan("│")}`);
  }
  console.log(rule("╰", "╯") + "\n");
}

export function resultLine(success: boolean, summary: string, ms?: number) {
  const took = ms !== undefined ? c.dim(`(${(ms / 1000).toFixed(1)}s)`) : "";
  const mark = success ? c.green("✓") : c.red("✗");
  const body = renderMarkdown(summary.trim(), md).split("\n");
  const width = termWidth() - 2;
  // A short one-liner stays on the mark line; anything longer or multi-line drops below it, wrapped.
  if (body.length === 1 && visibleLen(body[0]) <= width - 6) {
    console.log(`\n  ${mark} ${body[0]}  ${took}`);
    return;
  }
  console.log(`\n  ${mark} ${took}`);
  for (const line of body) {
    if (!line) {
      console.log();
      continue;
    }
    for (const w of wrap(line, width)) console.log(`  ${w}`);
  }
}

// Print the user's message as a clean chat line. Replaces readline's raw echo (one row up) with a
// styled, word-wrapped version, so it persists as a chat line and the spinner can't overwrite it.
// ponytail: assumes the echo took one screen row; a very long wrapped input may leave a fragment of
// the raw echo above — cosmetic and rare.
export function echoUser(text: string) {
  if (process.stdout.isTTY) process.stdout.write("\x1b[1A\x1b[2K\r");
  console.log();
  for (const line of wrap(`${c.cyan("›")} ${c.bold(text)}`, termWidth() - 2)) console.log(line);
}
