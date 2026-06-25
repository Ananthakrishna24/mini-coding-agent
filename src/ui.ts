// Plain console UI: color, a spinner, and the run-log the agent reports through. Used for one-shot
// (scriptable) mode and any non-TTY pipe; the interactive TTY uses the Ink UI (app.tsx) instead.
// Everything degrades to plain text when stdout isn't a TTY, so piped/CI output stays grep-able.
import { homedir } from "node:os";
import { setFooter, clearFooter, cleanup as screenCleanup } from "./screen";
import type { ModelInfo } from "./llm";
import type { ModelPolicy } from "./model_policy";
import { c, wrap, visibleLen, termWidth, iconize, toolEntry, resultBody, bannerLines, subHeader, rail, paintHex, getShimmerColor, progressBar } from "./format";

export { describeModel } from "./format";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

// What the agent loop reports through. Implemented by the console UI here and the Ink UI (app.tsx);
// required by run() so a run is never silently chatty via console.* — all output goes through one place.
export type UI = {
  thinking: (on: boolean, label?: string) => void;
  thought: (seconds: number) => void; // "thought for Ns" — only emitted when the model returned reasoning
  enterSubagent: (goal: string) => void; // a delegation begins: open the block and nest what follows under it
  exitSubagent: (result: string) => void; // the subagent finished: close the block with its ✓/✗ summary
  tool: (name: string, args: string, result: string) => void;
  warn: (msg: string) => void;
  debug: (msg: string) => void;
  startRun: () => void; // reset per-run state (plan, context %)
  endRun: () => void; // tear the live status down before the result line prints
  setModelLabel: (label: string) => void; // the model line shown in the status
  context: (used: number, budget: number) => void; // live context-usage %
  usage: (promptTokens: number, completionTokens: number) => void; // per-turn token usage, for /usage
  requestModelPolicy: () => Promise<ModelPolicy>; // ask the user, once per session, how subagents pick a model
};

// Print rows under the tool header with the ⎿ connector on the first line only — the rest align.
// `depth` nests the block under a subagent's rail so its output reads as the subagent's, not the parent's.
function block(rows: string[], depth = 0): void {
  const r = rail(depth);
  rows.forEach((row, i) => console.log(`    ${r}${c.dim(i === 0 ? "⎿" : " ")} ${row}`));
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR = "\r\x1b[K"; // carriage return + clear-to-end-of-line

export function createUI(): UI {
  let timer: ReturnType<typeof setInterval> | null = null;
  let i = 0;
  let nest = 0; // subagent nesting level; everything the agent reports while > 0 is railed in one level

  // Pinned-footer state for the current run: the plan checklist, its progress, the model label, and
  // live context usage. The footer redraws whenever any of these change (see screen.ts for the pin).
  let plan: string[] = [];
  let planDone = 0;
  let planTotal = 0;
  let modelLabel = "";
  let ctxPct: number | null = null;

  function redrawFooter(): boolean {
    if (!plan.length) {
      clearFooter();
      return false;
    }
    const width = Math.min(termWidth(), 100);
    const ctxBar = ctxPct != null ? ` ${c.primary(progressBar(ctxPct / 100, 20))} ctx ${ctxPct}%` : "";
    const status = `${modelLabel}${ctxBar}`.trim();
    const MAX_STEPS = 8;
    const shown = plan.slice(0, MAX_STEPS).map((r) => ` ${r}`);
    const more = plan.length > MAX_STEPS ? [c.dim(`   … +${plan.length - MAX_STEPS} more`)] : [];
    const lines = [c.dim("─".repeat(width)), status ? c.dim(` ${status}`) : "", c.dim(` Plan ▸ ${planDone}/${planTotal}`), ...shown, ...more];
    return setFooter(lines.filter((l) => l !== ""));
  }

  function setPlan(result: string) {
    const raw = result.split("\n").filter(Boolean);
    planTotal = raw.length;
    planDone = raw.filter((l) => l.startsWith("[x]")).length;
    plan = raw.map(iconize);
    if (!redrawFooter()) block(raw.map(iconize)); // no TTY to pin to → print the checklist inline
  }

  function thinking(on: boolean, label = "thinking") {
    if (!useColor) return; // no spinner when piped; the result lines below still print
    if (on) {
      if (timer) return;
      process.stdout.write(HIDE);
      timer = setInterval(() => {
        i = (i + 1) % SPIN.length;
        const shimmer = Math.floor(i / 4) % 2 === 0;
        const paint = shimmer ? (s: string) => paintHex(getShimmerColor(), s) : c.primary;
        process.stdout.write(`${CLEAR}  ${rail(nest)}${paint(SPIN[i])} ${c.dim(label + "…")}`);
      }, 80);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
      process.stdout.write(CLEAR + SHOW);
    }
  }

  const thought = (seconds: number) => console.log(c.dim(`  ${rail(nest)}✦ thought for ${seconds}s`));

  // Open a delegation block: a header with the AGENT badge + goal, then bump the nest so everything the
  // subagent reports is railed one level in. Close it with the subagent's ✓/✗ summary under the rail.
  const enterSubagent = (goal: string) => {
    console.log(`\n  ${rail(nest)}${subHeader(goal)}`);
    nest++;
  };
  const exitSubagent = (result: string) => {
    nest = Math.max(0, nest - 1);
    console.log(`  ${rail(nest)}${c.dim("⎿")} ${result}`);
  };

  function tool(name: string, argsJson: string, result: string) {
    const { header, rows } = toolEntry(name, argsJson, result);
    console.log(); // a blank line before each entry — breathing room between tool calls
    console.log(`  ${rail(nest)}${header}`);
    if (name === "update_plan" && useColor) return setPlan(result); // checklist lives in the pinned footer
    block(rows, nest);
  }

  const warn = (m: string) => console.log(c.yellow(`  ${rail(nest)}! ${m}`));
  const debug = (m: string) => void (process.env.DEBUG && console.log(c.dim(`  ~ ${m}`)));

  const startRun = () => {
    plan = [];
    planDone = planTotal = 0;
    ctxPct = null;
    nest = 0; // a prior run that died mid-delegation must not leave the next one indented
  };
  const endRun = () => {
    plan = [];
    clearFooter();
  };
  const setModelLabel = (label: string) => {
    modelLabel = label;
    redrawFooter();
  };
  const context = (used: number, budget: number) => {
    ctxPct = Math.min(100, Math.round((used / budget) * 100));
    redrawFooter();
  };
  const usage = () => {}; // session usage tracking is an interactive (Ink) feature; no-op when scripted
  const requestModelPolicy = async (): Promise<ModelPolicy> => "parent"; // no overlay when scripted — use the current model

  return { thinking, thought, enterSubagent, exitSubagent, tool, warn, debug, startRun, endRun, setModelLabel, context, usage, requestModelPolicy };
}

// On any exit reset the scroll region (so a Ctrl-C mid-run never leaves the terminal with a stuck
// pinned area) and restore the cursor the spinner may have hidden.
process.on("exit", () => {
  screenCleanup();
  if (useColor) process.stdout.write(SHOW);
});

// --- top-level render helpers, used by the CLI shell (index.ts) in one-shot mode ---

const shortCwd = () => process.cwd().replace(homedir(), "~");

// A bordered welcome card (one-shot mode); the Ink UI renders the same lines as its first history item.
export function banner(info: ModelInfo | undefined, id: string) {
  console.log();
  for (const line of bannerLines(info, id, shortCwd())) console.log(line);
  console.log();
}

export function resultLine(success: boolean, summary: string, ms?: number) {
  const took = ms !== undefined ? c.dim(`(${(ms / 1000).toFixed(1)}s)`) : "";
  const mark = success ? c.green("✓") : c.red("✗");
  const body = resultBody(summary);
  const width = termWidth() - 2;
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
