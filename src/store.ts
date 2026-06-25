// The interactive session's state + controller. Holds the chat history and live status, implements
// the UI interface the agent loop reports through, drives runs, and handles slash commands. Plain TS
// (no React) so app.tsx can subscribe to it as an external store via useSyncExternalStore.
import type OpenAI from "openai";
import { run } from "./agent";
import { getModel, setModel, modelInfo, searchModels, getContextWindow, getEffort, setEffort, resetCatalog, type ModelInfo } from "./llm";
import { applyEnvFile } from "./onboarding";
import { attachImages } from "./images";
import { inputBudget } from "./context";
import { newSessionId, saveSession, listSessions, loadSession, type SessionMeta } from "./sessions";
import { resetModelPolicy, type ModelPolicy } from "./model_policy";
import type { UI } from "./ui";
import { homedir } from "node:os";
import { c, describeModel, fmtTokens, fmtPrice, bannerLines, getPrimaryColor, setPrimaryColor, COLOR_PRESETS } from "./format";

// One scrollback entry. Tool calls, warnings, the user's lines, slash-command output, and run results
// all land here and render in Ink's <Static> region so they persist as the log scrolls.
// `depth` is the subagent nesting level (0 = the top agent); the UI rails an item one gutter in per
// level so a subagent's activity reads as the subagent's, not the parent's.
export type Item = { id: number; depth?: number } & (
  | { kind: "user"; text: string }
  | { kind: "tool"; name: string; args: string; result: string }
  | { kind: "warn"; text: string }
  | { kind: "info"; lines: string[] } // slash-command output
  | { kind: "subagent"; goal: string } // a delegation header: opens the nested block
  | { kind: "result"; success: boolean; summary: string; ms: number }
);

// The /model picker overlay: a filterable, arrow-key list of tool-capable models. Null = closed.
export type Picker = { query: string; items: ModelInfo[]; sel: number; loading: boolean };

// The /resume picker overlay: an arrow-key list of past chat sessions. Null = closed.
export type ResumePicker = { items: SessionMeta[]; sel: number };

// The model-policy overlay, shown once on the first delegation: how should subagents pick a model?
export const POLICY_OPTIONS: { value: ModelPolicy; label: string }[] = [
  { value: "parent", label: "use the current model for all subagents" },
  { value: "auto", label: "let the agent pick the best model per task" },
];

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
  resumePicker: ResumePicker | null; // the /resume overlay: ↑↓ to move, ⏎ to reopen, esc to cancel
  policyPicker: { sel: number } | null; // the first-delegation model-policy overlay; pauses the run until answered
  colorPicker: { sel: number } | null; // the /colors overlay: ↑↓ to move, ⏎ to apply, esc to cancel
  effortPicker: { sel: number } | null; // the reasoning-effort overlay, opened after picking a reasoning model
  setup: boolean; // the /setup overlay: re-run onboarding (pick provider, add a key) without restarting
  gen: number; // bumped on /clear so <Static> remounts and reprints from scratch (see app.tsx)
};

// Effort levels offered after a reasoning model is picked. "default" sends no effort param (the model's
// own default); the rest map straight to the provider's low|medium|high.
export const EFFORT_LEVELS = ["default", "low", "medium", "high"] as const;

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
  resumePicker: null,
  policyPicker: null,
  colorPicker: null,
  effortPicker: null,
  setup: false,
  gen: 0,
};

// The live message array for this session, threaded through every top-level run so the model sees the
// whole conversation across turns (subagents get their own clean context). Reset by /clear.
let conversation: OpenAI.ChatCompletionMessageParam[] = [];
let sessionId = newSessionId(); // this chat's id on disk; a new one per /clear or resume
let sessionTitle = ""; // first user line, shown in the /resume list
let lastWasMinions = false; // last top-level run was a /minions team → a bare "continue" resumes it, not a fresh single agent

// Persist the current thread so /resume can reopen it. Called after every run; cheap and best-effort.
function persist() {
  saveSession({ id: sessionId, title: sessionTitle || "(untitled)", cwd: process.cwd(), updated: Date.now(), turns: state.session.turns, messages: conversation });
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

// Distributive Omit so each union member keeps its own fields (a plain Omit<Item,"id"> would collapse
// to only the keys common to every member — i.e. just `kind`). Distribution needs a naked type param.
type DistOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
type NewItem = DistOmit<Item, "id" | "depth">; // callers don't set id/depth — push stamps both

let nextId = 1;
let nest = 0; // subagent nesting level, set by enter/exitSubagent; stamped onto every pushed item
function push(item: NewItem) {
  set({ items: [...state.items, { id: nextId++, depth: nest, ...item } as Item] });
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
  // Open a delegation block (header at the parent level), then nest what the subagent does one level in.
  enterSubagent: (goal) => {
    push({ kind: "subagent", goal });
    nest++;
  },
  // Close the block: drop back a level, then print the subagent's ✓/✗ summary aligned with its header.
  exitSubagent: (result) => {
    nest = Math.max(0, nest - 1);
    push({ kind: "info", lines: [`${c.dim("⎿")} ${result}`] });
  },
  tool: (name, args, result) => {
    if (name === "update_plan") {
      const raw = result.split("\n").filter(Boolean);
      set({ plan: raw, planTotal: raw.length, planDone: raw.filter((l) => l.startsWith("[x]")).length });
    }
    push({ kind: "tool", name, args, result });
  },
  warn: (text) => push({ kind: "warn", text }),
  debug: (msg) => void (process.env.DEBUG && push({ kind: "warn", text: msg })),
  startRun: () => {
    nest = 0; // a prior run that died mid-delegation must not leave the next one indented
    set({ plan: [], planDone: 0, planTotal: 0, ctxPct: null });
  },
  endRun: () => set({ spinner: null }),
  setModelLabel: (modelLabel) => set({ modelLabel }),
  context: (used, budget) => set({ ctxUsed: used, ctxBudget: budget, ctxPct: Math.min(100, Math.round((used / budget) * 100)) }),
  usage: (prompt, completion) => {
    const cost =
      ((currentInfo?.promptPrice ?? 0) * prompt + (currentInfo?.completionPrice ?? 0) * completion) / 1e6;
    const s = state.session;
    set({ session: { prompt: s.prompt + prompt, completion: s.completion + completion, cost: s.cost + cost, turns: s.turns + 1 } });
  },
  // Open the overlay and block the run until the user chooses; policyPickerSelect resolves it.
  requestModelPolicy: () =>
    new Promise<ModelPolicy>((resolve) => {
      policyResolver = resolve;
      set({ policyPicker: { sel: 0 } });
    }),
};

// Resolver for the in-flight requestModelPolicy promise; the overlay's selection calls it.
let policyResolver: ((p: ModelPolicy) => void) | null = null;

// Sync the active model into state: catalog entry (for pricing), footer label, and context window.
async function syncModel() {
  currentInfo = await modelInfo().catch(() => undefined);
  const eff = getEffort();
  ui.setModelLabel(describeModel(currentInfo, getModel()) + (eff ? ` · ${eff}` : ""));
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
  conversation = []; // a cleared screen means a cleared thread — the next run starts the model fresh
  sessionId = newSessionId(); // a fresh thread is a new session on disk; the old one stays resumable
  sessionTitle = "";
  lastWasMinions = false; // a cleared session won't resume the old team via a bare "continue"
  resetModelPolicy(); // a fresh session asks the model-policy question again on its next delegation
  state = { ...state, items: [{ id: nextId++, ...bannerItem() } as Item], gen: state.gen + 1, session: { prompt: 0, completion: 0, cost: 0, turns: 0 } };
  emit();
}

// Refresh the banner after a color or model change: replace items[0] with a fresh banner, clear the
// screen, and bump gen so <Static> remounts and reprints. Past items re-render in the new color too.
function refreshBanner() {
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  const items = [...state.items];
  if (items.length) items[0] = { id: items[0].id, ...bannerItem() } as Item;
  state = { ...state, items, gen: state.gen + 1 };
  emit();
}

// Run a goal through the agent, streaming events into the store. One run at a time (busy guard).
async function runGoal(goal: string) {
  if (state.busy) return;
  lastWasMinions = false; // a normal single-agent run; a later bare "continue" should not hijack to /minions
  const { content, attached, skipped } = attachImages(goal);
  const tag = attached.length ? `  ${c.dim(`📎 ${attached.length} image${attached.length > 1 ? "s" : ""}`)}` : "";
  if (!sessionTitle) sessionTitle = goal.slice(0, 80);
  push({ kind: "user", text: `${goal}${tag}` });
  for (const s of skipped) push({ kind: "warn", text: `skipped ${s} — over 20MB image limit` });
  if (attached.length && currentInfo && !currentInfo.vision) {
    return push({ kind: "warn", text: `${getModel()} doesn't accept image input — switch to a vision model with /model, then resend` });
  }
  set({ busy: true });
  ui.startRun();
  const t0 = Date.now();
  try {
    const r = await run(content, ui, 0, conversation); // same array every turn = the model keeps the thread
    push({ kind: "result", success: r.success, summary: r.summary, ms: Date.now() - t0 });
  } catch (e: any) {
    push({ kind: "result", success: false, summary: `agent failed: ${e.message ?? e}`, ms: Date.now() - t0 });
  } finally {
    ui.endRun();
    set({ busy: false });
    persist();
  }
}

// The instruction handed to gru when resuming an interrupted team.
const RESUME_GOAL =
  "Continue where the team left off — call list_agents, resume any agent that reported it didn't finish (spawn_minion with its resume_id), and complete the original goal.";

// Run a goal through the concurrent /minions team (gru → overseers → minions). Like runGoal but in a
// fresh context (the team coordinates over its own message bus, not the session thread). `resume` reuses
// the last team in this process so its agents' transcripts (and resume_id) carry over.
async function runMinionsGoal(goal: string, resume = false) {
  if (state.busy) return;
  const { runMinions, hasResumableTeam } = await import("./minions");
  if (resume && !hasResumableTeam()) return push({ kind: "info", lines: [c.yellow("no minions run to resume — start one with /minions <goal>")] });
  if (!resume && !goal) return push({ kind: "info", lines: [c.yellow("usage: /minions <goal>  (or /minions continue to resume the last team)")] });
  lastWasMinions = true;
  if (!sessionTitle) sessionTitle = `/minions ${goal}`.slice(0, 80);
  push({ kind: "user", text: resume ? "/minions continue" : `/minions ${goal}` });
  set({ busy: true });
  ui.startRun();
  const t0 = Date.now();
  try {
    const r = await runMinions(goal, ui, resume);
    push({ kind: "result", success: r.success, summary: r.summary, ms: Date.now() - t0 });
  } catch (e: any) {
    push({ kind: "result", success: false, summary: `minions failed: ${e.message ?? e}`, ms: Date.now() - t0 });
  } finally {
    ui.endRun();
    set({ busy: false });
    persist();
  }
}

// --- slash commands ---

const HELP = [
  c.bold("commands"),
  `  ${c.primary("/model")}            open the model picker (↑↓ to choose, type to filter, ⏎ select, esc cancel)`,
  `  ${c.primary("/model <query>")}    open the picker pre-filtered`,
  `  ${c.primary("/model <id>")}       switch to an exact model id (e.g. an OpenRouter "a/b" id)`,
  `  ${c.primary("/colors")}           change the accent color (presets or #rrggbb)`,
  `  ${c.primary("/minions <goal>")}   run a concurrent team (gru → overseers → minions) on the goal`,
  `  ${c.primary("/minions continue")}  resume the last team where it left off (or just type "continue")`,
  `  ${c.primary("/setup")}            add/switch provider + API key (OpenRouter, OpenAI)`,
  `  ${c.primary("/status")}           model, context window, working dir`,
  `  ${c.primary("/usage")}            tokens + estimated cost this session`,
  `  ${c.primary("/context")}          context-window usage right now`,
  `  ${c.primary("/resume")}           reopen a past chat session (↑↓ choose, ⏎ resume, esc cancel)`,
  `  ${c.primary("/clear")}            clear the scrollback`,
  `  ${c.primary("/help")}             this list`,
  `  ${c.dim("exit · Ctrl-C")}     quit`,
  `  ${c.dim("tip: Ctrl-V pastes a copied image, or put an image path in your message (png/jpg/gif/webp)")}`,
];

async function activate(id: string) {
  const info = await setModel(id);
  currentInfo = info;
  await syncModel();
  refreshBanner();
  push({ kind: "info", lines: [c.green(`✔ model → ${describeModel(info, id)}`)] });
  if (info?.reasoning) openEffortPicker(); // a reasoning model: ask for the effort level next
}

// --- the /model picker (interactive list) ---

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

// --- the /resume picker (interactive list of past chat sessions, same keys as /model) ---

// Rebuild visible scrollback from a saved thread: the user's lines and the assistant's prose replies.
// Tool calls and internal turns are skipped — enough to read the past chat, while the full message
// array (loaded into `conversation`) still gives the model the complete context on the next run.
function replay(messages: OpenAI.ChatCompletionMessageParam[]): NewItem[] {
  const out: NewItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "(image / multimodal message)";
      out.push({ kind: "user", text });
    } else if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
      out.push({ kind: "info", lines: m.content.split("\n").map((l) => c.dim(l)) });
    }
  }
  return out;
}

export function openResumePicker() {
  const items = listSessions().filter((s) => s.id !== sessionId); // don't offer to resume the live one
  if (!items.length) return push({ kind: "info", lines: [c.dim("no saved sessions yet — they're recorded as you chat")] });
  set({ resumePicker: { items, sel: 0 } });
}
export const closeResumePicker = () => set({ resumePicker: null });
export function resumePickerMove(delta: number) {
  const rp = state.resumePicker;
  if (!rp || !rp.items.length) return;
  set({ resumePicker: { ...rp, sel: (rp.sel + delta + rp.items.length) % rp.items.length } });
}
export async function resumePickerSelect() {
  const rp = state.resumePicker;
  if (!rp) return;
  const chosen = rp.items[rp.sel];
  closeResumePicker();
  if (!chosen) return;
  const sess = loadSession(chosen.id);
  if (!sess) return push({ kind: "info", lines: [c.yellow(`couldn't load session ${chosen.id}`)] });
  conversation = sess.messages; // the model picks up the full thread; we show a readable subset
  sessionId = sess.id;
  sessionTitle = sess.title;
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  const head: Item = { id: nextId++, ...bannerItem() } as Item;
  const note: Item = { id: nextId++, kind: "info", lines: [c.green(`✔ resumed: ${sess.title}`)] };
  const items = replay(sess.messages).map((it) => ({ id: nextId++, depth: 0, ...it }) as Item);
  state = { ...state, items: [head, note, ...items], gen: state.gen + 1 };
  emit();
}

// --- the first-delegation model-policy overlay (resolves the requestModelPolicy promise) ---

export function policyPickerMove(delta: number) {
  const pp = state.policyPicker;
  if (!pp) return;
  const n = POLICY_OPTIONS.length;
  set({ policyPicker: { sel: (pp.sel + delta + n) % n } });
}
export function policyPickerSelect() {
  const pp = state.policyPicker;
  if (!pp) return;
  const opt = POLICY_OPTIONS[pp.sel];
  set({ policyPicker: null });
  push({ kind: "info", lines: [c.green(`✔ subagent models: ${opt.label}`)] });
  policyResolver?.(opt.value);
  policyResolver = null;
}
// esc can't leave the run hanging on the unanswered prompt — default to the current model for all.
export function policyPickerCancel() {
  if (!state.policyPicker) return;
  set({ policyPicker: null });
  push({ kind: "info", lines: [c.dim("using the current model for all subagents")] });
  policyResolver?.("parent");
  policyResolver = null;
}

// --- the /colors picker (interactive list, same keys as /model) ---

// Opens on the currently active preset so re-opening lands where you left off.
export function openColorPicker() {
  const idx = COLOR_PRESETS.findIndex((p) => p.hex === getPrimaryColor());
  set({ colorPicker: { sel: idx >= 0 ? idx : 0 } });
}
export const closeColorPicker = () => set({ colorPicker: null });
export function colorPickerMove(delta: number) {
  const cp = state.colorPicker;
  if (!cp) return;
  const n = COLOR_PRESETS.length;
  set({ colorPicker: { sel: (cp.sel + delta + n) % n } });
}
export async function colorPickerSelect() {
  const cp = state.colorPicker;
  if (!cp) return;
  const chosen = COLOR_PRESETS[cp.sel];
  closeColorPicker();
  if (chosen) {
    setPrimaryColor(chosen.hex);
    refreshBanner();
    push({ kind: "info", lines: [c.green(`✔ color → ${chosen.hex}`)] });
  }
}

// --- the reasoning-effort picker (opens after a reasoning model is chosen; same keys as /colors) ---

// Opens on the current effort so re-opening lands where you left off ("default" when none is set).
export function openEffortPicker() {
  const cur = getEffort();
  const idx = cur ? EFFORT_LEVELS.indexOf(cur as (typeof EFFORT_LEVELS)[number]) : 0;
  set({ effortPicker: { sel: idx >= 0 ? idx : 0 } });
}
export const closeEffortPicker = () => set({ effortPicker: null });
export function effortPickerMove(delta: number) {
  const ep = state.effortPicker;
  if (!ep) return;
  const n = EFFORT_LEVELS.length;
  set({ effortPicker: { sel: (ep.sel + delta + n) % n } });
}
export async function effortPickerSelect() {
  const ep = state.effortPicker;
  if (!ep) return;
  const chosen = EFFORT_LEVELS[ep.sel];
  closeEffortPicker();
  setEffort(chosen === "default" ? null : chosen); // "default" = no effort param, the model's own default
  await syncModel(); // fold the effort into the footer model label
  push({ kind: "info", lines: [c.green(`✔ effort → ${chosen}`)] });
}

// --- the /setup overlay: re-run onboarding in place (pick provider, add a key) without restarting ---
export const openSetup = () => set({ setup: true });

// Called by the overlay when it closes. On save: surface the freshly written key(s) to this process,
// drop the cached catalog so the (now possibly new) provider's models appear, switch to the chosen
// model, and refresh the banner. On cancel: just close. Once a second provider's key is added, /model
// lists every provider's models because the catalog spans all providers that have a key.
export async function finishSetup(saved: boolean, modelId?: string) {
  set({ setup: false });
  if (!saved) return;
  applyEnvFile(); // load the new .env values into process.env for this run
  resetCatalog(); // the next catalog fetch spans every provider with a key, including the one just added
  if (modelId) await activate(modelId);
  else {
    await syncModel();
    refreshBanner();
  }
  push({ kind: "info", lines: [c.green("✔ provider configured — /model lists every model you have a key for")] });
}

// Returns true if the input was a command (so the caller doesn't run it as a goal). onExit fires for
// /exit so the component can tear Ink down.
export async function submit(input: string, onExit: () => void): Promise<void> {
  const line = input.trim();
  if (!line) return;
  if (line === "exit" || line === "quit") return onExit();
  // After a /minions run, a bare "continue"/"resume" resumes the team (with its agents' context) rather
  // than starting a fresh, contextless single agent. Any other input falls through to a normal run.
  if (!line.startsWith("/")) {
    if (lastWasMinions && /^(continue|resume|keep going)$/i.test(line)) return runMinionsGoal(RESUME_GOAL, true);
    return runGoal(line);
  }

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
    case "/colors": {
      // No arg → open the interactive picker (↑↓ to move, ⏎ to apply, esc to cancel). An arg is a
      // preset name or #rrggbb applied directly — a shortcut past the picker.
      if (!arg) return openColorPicker();
      const hex = setPrimaryColor(arg);
      if (!hex) return push({ kind: "info", lines: [c.yellow(`unknown color "${arg}" — /colors for the list`)] });
      refreshBanner();
      return push({ kind: "info", lines: [c.green(`✔ color → ${hex}`)] });
    }
    case "/status": {
      const win = getContextWindow();
      return push({
        kind: "info",
        lines: [
          c.bold("status"),
          `  model    ${describeModel(currentInfo, getModel())}`,
          `  effort   ${getEffort() ?? c.dim("default")}${currentInfo && !currentInfo.reasoning ? c.dim("  (non-reasoning model)") : ""}`,
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
    case "/minions": {
      // No arg, or a leading "continue"/"resume", resumes the last team; trailing text becomes an extra
      // instruction. Anything else starts a fresh team on that goal.
      const m = arg.match(/^(continue|resume)\b[:,]?\s*(.*)$/is);
      if (!arg || m) {
        const extra = m?.[2]?.trim();
        return runMinionsGoal(extra ? `${RESUME_GOAL}\n\nAlso: ${extra}` : RESUME_GOAL, true);
      }
      return runMinionsGoal(arg, false);
    }
    case "/setup":
      return openSetup();
    case "/resume":
      return openResumePicker();
    case "/clear":
      return freshSession();
    default:
      return push({ kind: "info", lines: [c.yellow(`unknown command ${cmd} — /help for the list`)] });
  }
}

// Command names for the "/" autocomplete menu in the input.
export const COMMANDS = [
  { name: "/model", desc: "show or switch the model" },
  { name: "/minions", desc: "run a concurrent gru→overseers→minions team" },
  { name: "/colors", desc: "change the accent color" },
  { name: "/setup", desc: "add/switch provider + API key" },
  { name: "/status", desc: "model, window, working dir" },
  { name: "/usage", desc: "tokens + cost this session" },
  { name: "/context", desc: "context-window usage" },
  { name: "/resume", desc: "reopen a past chat session" },
  { name: "/clear", desc: "clear the scrollback" },
  { name: "/help", desc: "list commands" },
];
