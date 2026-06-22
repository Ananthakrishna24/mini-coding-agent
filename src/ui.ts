// Terminal UI: color, a spinner, and the run-log rendering the agent reports through.
// Native only — util.styleText for color (Node ≥20), no chalk/ora. Everything degrades to plain
// text when stdout isn't a TTY (piped, CI, NO_COLOR), so the output stays readable and grep-able.
import { styleText } from "node:util";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
type Style = Parameters<typeof styleText>[0];
const paint = (style: Style, s: string) => (useColor ? styleText(style, s) : s);

export const c = {
  dim: (s: string) => paint("dim", s),
  cyan: (s: string) => paint("cyan", s),
  green: (s: string) => paint("green", s),
  red: (s: string) => paint("red", s),
  yellow: (s: string) => paint("yellow", s),
};

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

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

  // ⏺ tool(args) / ⎿ result preview — the Claude-Code-style two-line entry, trimmed to one line each.
  function tool(name: string, args: string, result: string) {
    const failed = result.startsWith("error:") || /^exit [1-9]/.test(result);
    const dot = failed ? c.red("⏺") : c.cyan("⏺");
    console.log(`  ${dot} ${name}${c.dim("(" + clip(oneLine(args), 56) + ")")}`);
    console.log(`    ${c.dim("⎿ " + clip(oneLine(result), 80))}`);
  }

  const warn = (m: string) => console.log(c.yellow(`  ! ${m}`));
  const debug = (m: string) => void (process.env.DEBUG && console.log(c.dim(`  ~ ${m}`)));

  return { thinking, tool, warn, debug };
}

// Restore the cursor on any exit — Ctrl-C kills the spinner mid-frame with the cursor still hidden.
process.on("exit", () => useColor && process.stdout.write(SHOW));

// --- top-level render helpers, used by the CLI shell (index.ts), not the agent loop ---

export function banner() {
  console.log(`\n  ${paint(["bold", "cyan"], "◆ mini-coding-agent")}  ${c.dim("· type a goal, 'exit' to quit")}`);
}

export function resultLine(success: boolean, summary: string) {
  console.log(`\n  ${success ? c.green("✓") : c.red("✗")} ${summary}`);
}
