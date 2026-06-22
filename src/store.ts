// The interactive session's state + controller. Holds the chat history and live status, implements
// the UI interface the agent loop reports through, drives runs, and handles slash commands. Plain TS
// (no React) so app.tsx can subscribe to it as an external store via useSyncExternalStore.
import { run } from "./agent";
import { getModel, setModel, modelInfo, searchModels, getContextWindow, type ModelInfo } from "./llm";
import { inputBudget } from "./context";
import type { UI } from "./ui";
import { homedir } from "node:os";
import { c, describeModel, fmtTokens, fmtPrice, bannerLines } from "./format";

// One scrollback entry. Tool calls, warnings, the user's lines, slash-command output, and run results
// all land here and render in Ink's <Static> region so they persist as the log scrolls.
export type Item =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "tool"; name: string; args: string; result: string }
  | { id: number; kind: "warn"; text: string }
  | { id: number; kind: "info"; lines: string[] } // slash-command output
  | { id: number; kind: "result"; success: boolean; summary: string; ms: number };

// The /model picker overlay: a filterable, arrow-key list of tool-capable models. Null = closed.
export type Picker = { query: string; items: ModelInfo[]; sel: number; loading: boolean };

export type State = {
  items: Item[];
  busy: boolean;
  spinner: string | null; // label while a model call / tool runs; null = idle
  plan: string[]; // colored checklist rows for the live footer; empty = no plan
  planDone: number;
  planTotal: number;
  modelLabel: string;
  ctxPct: number | null;
  ctxUsed: number;
  ctxBudget: number;
  session: { prompt: number; completion: number; cost: number; turns: number }; // cumulative, for /usage
  picker: Picker | null;
  gen: number; // bumped on /clear so <Static> remounts and reprints from scratch (see app.tsx)
};

let state: State = {
  items: [],
  busy: false,
  spinner: null,
  plan: [],
  planDone: 0,
  planTotal: 0,
  modelLabel: "",
  ctxPct: null,
  ctxUsed: 0,
  ctxBudget: 0,
  session: { prompt: 0, completion: 0, cost: 0, turns: 0 },
  picker: null,
  gen: 0,
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

// Distributive Omit so each union member keeps its own fields (a plain Omit<Item,"id"> would collapse
// to only the keys common to every member — i.e. just `kind`). Distribution needs a naked type param.
type DistOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
type NewItem = DistOmit<Item, "id">;

let nextId = 1;
function push(item: NewItem) {
  set({ items: [...state.items, { id: nextId++, ...item } as Item] });
}

export const store = {
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
  getSnapshot: () => state,
};

let currentInfo: ModelInfo | undefined; // active model's catalog entry, for pricing /usage + /status

// The agent reports through this. Each method mutates the store and re-renders the Ink tree.
export const ui: UI = {
  thinking: (on, label = "thinking") => set({ spinner: on ? label : null }),
  thought: (seconds) => push({ kind: "info", lines: [c.dim(`✦ thought for ${seconds}s`)] }),
  tool: (name, args, result) => {
    if (name === "update_plan") {
      const raw = result.split("\n").filter(Boolean);
      set({ plan: raw, planTotal: raw.length, planDone: raw.filter((l) => l.startsWith("[x]")).length });
    }
    push({ kind: "tool", name, args, result });
  },
  warn: (text) => push({ kind: "warn", text }),
  debug: (msg) => void (process.env.DEBUG && push({ kind: "warn", text: msg })),
  startRun: () => set({ plan: [], planDone: 0, planTotal: 0, ctxPct: null }),
  endRun: () => set({ spinner: null }),
  setModelLabel: (modelLabel) => set({ modelLabel }),
  context: (used, budget) => set({ ctxUsed: used, ctxBudget: budget, ctxPct: Math.min(100, Math.round((used / budget) * 100)) }),
  usage: (prompt, completion) => {
    const cost =
      ((currentInfo?.promptPrice ?? 0) * prompt + (currentInfo?.completionPrice ?? 0) * completion) / 1e6;
    const s = state.session;
    set({ session: { prompt: s.prompt + prompt, completion: s.completion + completion, cost: s.cost + cost, turns: s.turns + 1 } });
  },
};

// Sync the active model into state: catalog entry (for pricing), footer label, and context window.
async function syncModel() {
  currentInfo = await modelInfo().catch(() => undefined);
  ui.setModelLabel(describeModel(currentInfo, getModel()));
}

const bannerItem = (): NewItem => ({
  kind: "info",
  lines: bannerLines(currentInfo, getModel(), process.cwd().replace(homedir(), "~")),
});

export async function init() {
  await setModel(getModel()).catch(() => undefined); // load the real context window from the catalog up front
  await syncModel();
  push(bannerItem());
}

// /clear → a fresh session. Physically wipe the terminal (visible screen + scrollback) so the old log
// is gone, not just scrolled off, then reset to the banner and bump `gen` so <Static> remounts and
// reprints from scratch (a shrunk items array alone won't, since Static never re-renders past items).
function freshSession() {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback, cursor home
  state = { ...state, items: [{ id: nextId++, ...bannerItem() } as Item], gen: state.gen + 1, session: { prompt: 0, completion: 0, cost: 0, turns: 0 } };
  emit();
}

// Run a goal through the agent, streaming events into the store. One run at a time (busy guard).
async function runGoal(goal: string) {
  if (state.busy) return;
  push({ kind: "user", text: goal });
  set({ busy: true });
  ui.startRun();
  const t0 = Date.now();
  try {
    const r = await run(goal, ui);
    push({ kind: "result", success: r.success, summary: r.summary, ms: Date.now() - t0 });
  } catch (e: any) {
    push({ kind: "result", success: false, summary: `agent failed: ${e.message ?? e}`, ms: Date.now() - t0 });
  } finally {
    ui.endRun();
    set({ busy: false });
  }
}

// --- slash commands ---

const HELP = [
  c.bold("commands"),
  `  ${c.cyan("/model")}            open the model picker (↑↓ to choose, type to filter, ⏎ select, esc cancel)`,
  `  ${c.cyan("/model <query>")}    open the picker pre-filtered`,
  `  ${c.cyan("/model <id>")}       switch to an exact OpenRouter id`,
  `  ${c.cyan("/status")}           model, context window, working dir`,
  `  ${c.cyan("/usage")}            tokens + estimated cost this session`,
  `  ${c.cyan("/context")}          context-window usage right now`,
  `  ${c.cyan("/clear")}            clear the scrollback`,
  `  ${c.cyan("/help")}             this list`,
  `  ${c.dim("exit · Ctrl-C")}     quit`,
];

async function activate(id: string) {
  const info = await setModel(id);
  currentInfo = info;
  await syncModel();
  push({ kind: "info", lines: [c.green(`✔ model → ${describeModel(info, id)}`)] });
}

// --- the /model picker (interactive list, like claude-code's /model) ---

// Re-run the search for the picker's current query and reset the highlight. searchModels caches the
// catalog after the first fetch, so retyping the filter is effectively instant.
async function loadPicker(query: string) {
  const items = await searchModels(query).catch(() => [] as ModelInfo[]);
  set({ picker: { query, items, sel: 0, loading: false } });
}

export async function openModelPicker(query = "") {
  set({ picker: { query, items: [], sel: 0, loading: true } });
  await loadPicker(query);
}
export const closePicker = () => set({ picker: null });
export function pickerMove(delta: number) {
  const p = state.picker;
  if (!p || !p.items.length) return;
  set({ picker: { ...p, sel: (p.sel + delta + p.items.length) % p.items.length } });
}
export async function pickerFilter(query: string) {
  if (!state.picker) return;
  await loadPicker(query); // keeps loading flag false; the catalog is cached so this returns at once
}
export async function pickerSelect() {
  const p = state.picker;
  if (!p) return;
  const chosen = p.items[p.sel];
  closePicker();
  if (chosen) await activate(chosen.id);
}

// Returns true if the input was a command (so the caller doesn't run it as a goal). onExit fires for
// /exit so the component can tear Ink down.
export async function submit(input: string, onExit: () => void): Promise<void> {
  const line = input.trim();
  if (!line) return;
  if (line === "exit" || line === "quit") return onExit();
  if (!line.startsWith("/")) return runGoal(line);

  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/help":
      return push({ kind: "info", lines: HELP });
    case "/model":
    case "/models":
      // An exact OpenRouter id (has a "/") switches straight away; anything else opens the picker,
      // pre-filtered by the arg. No arg → the full tool-capable list.
      if (arg.includes("/")) return activate(arg);
      return openModelPicker(arg);
    case "/status": {
      const win = getContextWindow();
      return push({
        kind: "info",
        lines: [
          c.bold("status"),
          `  model    ${describeModel(currentInfo, getModel())}`,
          `  window   ${fmtTokens(win)} tokens (budget ${fmtTokens(inputBudget(win))})`,
          `  dir      ${process.cwd().replace(process.env.HOME ?? "~", "~")}`,
        ],
      });
    }
    case "/usage": {
      const s = state.session;
      return push({
        kind: "info",
        lines: [
          c.bold("session usage"),
          `  turns       ${s.turns}`,
          `  input       ${s.prompt.toLocaleString()} tokens`,
          `  output      ${s.completion.toLocaleString()} tokens`,
          `  est. cost   ${fmtPrice(s.cost)}${currentInfo ? "" : c.dim("  (no catalog price)")}`,
        ],
      });
    }
    case "/context": {
      const win = getContextWindow();
      const pct = state.ctxPct;
      return push({
        kind: "info",
        lines: [
          c.bold("context window"),
          `  window   ${fmtTokens(win)} tokens`,
          `  budget   ${fmtTokens(inputBudget(win))} tokens (window minus output + safety reserve)`,
          pct == null
            ? c.dim("  usage    — (run something first)")
            : `  usage    ${state.ctxUsed.toLocaleString()} / ${state.ctxBudget.toLocaleString()} tokens (${pct}%)`,
        ],
      });
    }
    case "/clear":
      return freshSession();
    default:
      return push({ kind: "info", lines: [c.yellow(`unknown command ${cmd} — /help for the list`)] });
  }
}

// Command names for the "/" autocomplete menu in the input.
export const COMMANDS = [
  { name: "/model", desc: "show or switch the model" },
  { name: "/status", desc: "model, window, working dir" },
  { name: "/usage", desc: "tokens + cost this session" },
  { name: "/context", desc: "context-window usage" },
  { name: "/clear", desc: "clear the scrollback" },
  { name: "/help", desc: "list commands" },
];
