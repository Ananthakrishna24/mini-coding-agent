// /minions mode: a concurrent 3-tier agent team (gru → overseers → minions) that coordinates over a
// message bus instead of the blocking spawn_agent recursion. The Coordinator owns the Bus, the live
// agent registry, and the set of in-flight runs; it launches each agent as a *detached* run() so a
// supervisor and its units are all alive at once and can message each other (see SECRET-CONCEPT.md).
//
// Runtime dep is one-directional: this file imports run() from agent.ts; agent.ts imports only the
// `Coord`/`Role` *types* from here (erased at build), so the import graph stays acyclic.
import { readFileSync } from "node:fs";
import type OpenAI from "openai";
import type { UI } from "./ui";
import type { ModelPolicy } from "./model_policy";
import type { RunResult } from "./tools/final_answer";
import { Bus } from "./bus";
import { run } from "./agent";
import { read_file } from "./tools/read_file";
import { write_file } from "./tools/write_file";
import { edit_file } from "./tools/edit_file";
import { run_bash } from "./tools/run_bash";
import { update_plan } from "./tools/update_plan";
import { list_models } from "./tools/list_models";
import { read_skill } from "./tools/read_skill";
import { finalAnswerSchema } from "./tools/final_answer";
import { gruControlSchemas, minionControlSchemas, MINION_TOOLS } from "./tools/minion_tools";

export type Role = "gru" | "overseer" | "minion";

// What the agent loop needs from the coordinator. Kept to two methods so agent.ts's coupling is tiny.
export interface Coord {
  schemasForRole(role: Role): OpenAI.ChatCompletionTool[];
  // Run a minion-control tool by name; returns the tool result, or null if `name` isn't a minion tool
  // (so the loop falls through to its normal dispatch path).
  handle(name: string, argsJson: string, callerId: string): Promise<string | null>;
}

// Tree bounds — all env-overridable, 0 = unlimited. Defaults are UNLIMITED team size (no count cap) and
// a depth floor of 3 (gru → overseer → minion → helper) so recursion still terminates by default.
//   MINION_MAX_AGENTS   0 = unlimited (default); a positive N caps the team.
//   MINION_CAP_MODE     "lifetime" (default — counts every agent ever spawned) vs "concurrent" (counts
//                       only running agents, so a long run can churn through many). Only matters when a
//                       positive MINION_MAX_AGENTS is set.
//   MINION_MAX_DEPTH    delegation depth; 0 = unlimited, default 3.
// ponytail: unlimited count + no per-parent fanout cap means a confused model can fan out a runaway tree
// (each agent is still bounded by MAX_TURNS/STALL, but the team isn't). Set MINION_MAX_AGENTS to bound it
// if cost matters; the concurrent mode is the upgrade path for long-lived teams.
const MAX_DEPTH = Number(process.env.MINION_MAX_DEPTH) || 3; // 0 = unlimited
const MAX_AGENTS = Number(process.env.MINION_MAX_AGENTS) || 0; // 0 = unlimited (current default)
const CAP_MODE = process.env.MINION_CAP_MODE === "concurrent" ? "concurrent" : "lifetime";
const DEFAULT_WAIT_S = Number(process.env.MINION_WAIT_TIMEOUT_S) || 90;

// gru coordinates and reads but writes no code; overseers/minions get the full code toolset. update_plan
// is gru-only so the single shared footer isn't clobbered by every agent.
const gruTools = [read_file, list_models, update_plan].map((t) => t.schema);
const codeTools = [read_file, write_file, edit_file, run_bash, list_models, read_skill].map((t) => t.schema);

// Persona, loaded the dual inline/file way as the base rules in agent.ts (inlined string in the dist
// build, file read in dev/tsx). Placeholders filled per agent.
let MINION_TEMPLATE: string;
try {
  MINION_TEMPLATE = ((await import("./prompts/minion.md")) as { default: string }).default;
} catch {
  MINION_TEMPLATE = readFileSync(new URL("./prompts/minion.md", import.meta.url), "utf8");
}
const minionPrompt = (role: Role, id: string, parent: string): string =>
  MINION_TEMPLATE.replaceAll("{{ID}}", id).replaceAll("{{ROLE}}", role).replaceAll("{{PARENT}}", parent);

type AgentRec = { id: string; role: Role; depth: number; parent: string; status: "running" | "done"; summary?: string };

export class Coordinator implements Coord {
  readonly bus = new Bus();
  private agents = new Map<string, AgentRec>();
  private histories = new Map<string, OpenAI.ChatCompletionMessageParam[]>(); // each agent's live transcript, kept for resume
  private inflight = new Set<Promise<void>>();
  private counters: Record<"overseer" | "minion", number> = { overseer: 0, minion: 0 };
  constructor(private ui: UI) {}

  schemasForRole(role: Role): OpenAI.ChatCompletionTool[] {
    return role === "gru"
      ? [...gruTools, ...gruControlSchemas, finalAnswerSchema]
      : [...codeTools, ...minionControlSchemas, finalAnswerSchema];
  }

  // Run gru, then keep the process alive until every spawned agent settles. gru is prompted to wait for
  // its units before finishing; the drain is the backstop so a slow/straggling minion still completes.
  async start(goal: string): Promise<RunResult> {
    // First run builds gru's transcript; a resume reuses the kept one (the same array run() appended to
    // last time) so gru sees the whole prior run. Either way run() pushes `goal` as the next user turn.
    let history = this.histories.get("gru");
    if (!history) {
      this.agents.set("gru", { id: "gru", role: "gru", depth: 0, parent: "user", status: "running" });
      history = [{ role: "system", content: minionPrompt("gru", "gru", "user") }];
      this.histories.set("gru", history);
    } else {
      const resuming = this.agents.get("gru");
      if (resuming) resuming.status = "running";
    }
    let res: RunResult;
    try {
      res = await run(goal, labeledUI(this.ui, "gru"), 0, history, { agentId: "gru", role: "gru" }, this);
    } catch (e: any) {
      res = { success: false, summary: `gru crashed: ${e.message ?? e}` };
    }
    const g = this.agents.get("gru");
    if (g) {
      g.status = "done";
      g.summary = res.summary;
    }
    // Re-snapshot each pass so agents spawned *during* the drain are awaited too.
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
    return res;
  }

  async handle(name: string, argsJson: string, callerId: string): Promise<string | null> {
    if (!MINION_TOOLS.has(name)) return null;
    let args: any;
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      return "error: arguments were not valid JSON";
    }
    switch (name) {
      case "spawn_minion":
        return this.doSpawn(callerId, args);
      case "send_message": {
        const to = typeof args.to === "string" ? args.to.trim() : "";
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!to) return "error: 'to' must be an agent id (see list_agents)";
        if (!text) return "error: 'text' must be a non-empty string";
        if (!this.agents.has(to)) return `error: no agent '${to}' — call list_agents to see who's alive`;
        this.bus.send(to, callerId, text);
        return `sent to ${to}`;
      }
      case "wait_message": {
        const secs = typeof args.timeout_s === "number" && args.timeout_s > 0 ? Math.min(args.timeout_s, 600) : DEFAULT_WAIT_S;
        const m = await this.bus.recv(callerId, secs * 1000);
        return m ? `message from ${m.from}: ${m.text}` : `no message within ${secs}s — proceed, or call list_agents to check status`;
      }
      case "list_agents":
        return this.listAgents();
      case "claim_file": {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) return "error: 'path' must be a non-empty string";
        const r = this.bus.claim(path, callerId);
        return r === "ok" ? `claimed ${path}` : `error: ${path} is ${r} — send_message them to coordinate, don't write it`;
      }
      case "release_file": {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) return "error: 'path' must be a non-empty string";
        this.bus.release(path, callerId);
        return `released ${path}`;
      }
    }
    return null;
  }

  private doSpawn(callerId: string, args: any): string {
    const caller = this.agents.get(callerId);
    if (!caller) return "error: unknown caller";
    const goal = typeof args.goal === "string" ? args.goal.trim() : "";
    if (!goal) return "error: 'goal' must be a non-empty string";

    // Resume a cut-off child: relaunch it on its kept transcript with `goal` as the follow-up, same id —
    // so its prior work isn't thrown away. Mirrors spawn_agent's resume_id.
    if (typeof args.resume_id === "string" && args.resume_id.trim()) {
      const rid = args.resume_id.trim();
      const rec = this.agents.get(rid);
      const hist = this.histories.get(rid);
      if (!rec || !hist) return `error: no agent '${rid}' to resume (see list_agents)`;
      if (rec.status === "running") return `error: ${rid} is still running — wait_message for it instead of resuming`;
      this.launch(rid, rec.role, rec.depth, rec.parent, goal, hist);
      return `resumed ${rid} (${rec.role}) — it continues from where it left off and will message you`;
    }

    const role: Role = caller.role === "gru" ? "overseer" : "minion"; // role is derived, never invalid
    const depth = caller.depth + 1;
    if (MAX_DEPTH > 0 && depth > MAX_DEPTH) return `error: max delegation depth (${MAX_DEPTH}) reached — do this part yourself`;
    if (MAX_AGENTS > 0) {
      // lifetime = every agent ever spawned; concurrent = only those still running.
      const count = CAP_MODE === "concurrent" ? [...this.agents.values()].filter((a) => a.status === "running").length : this.agents.size;
      if (count >= MAX_AGENTS) return `error: too many agents (${CAP_MODE} limit ${MAX_AGENTS}) — wait for some to finish first`;
    }
    const id = `${role}-${++this.counters[role]}`;
    this.launch(id, role, depth, callerId, goal);
    return `spawned ${id} (${role}) — it runs concurrently and will message you; use wait_message to receive its updates`;
  }

  // Launch an agent as a detached run() (not awaited here — that's the whole point: it runs alongside
  // its supervisor). The promise is tracked so start()'s drain can wait for it to settle.
  private launch(id: string, role: Role, depth: number, parent: string, goal: string, resumeHistory?: OpenAI.ChatCompletionMessageParam[]): void {
    const rec = this.agents.get(id);
    if (rec) rec.status = "running"; // resuming an existing agent
    else this.agents.set(id, { id, role, depth, parent, status: "running" });
    const history: OpenAI.ChatCompletionMessageParam[] = resumeHistory ?? [{ role: "system", content: minionPrompt(role, id, parent) }];
    this.histories.set(id, history); // kept so a cut-off agent can be resumed by id
    const p = (async () => {
      let res: RunResult;
      try {
        res = await run(goal, labeledUI(this.ui, id), depth, history, { agentId: id, role }, this);
      } catch (e: any) {
        res = { success: false, summary: `crashed: ${e.message ?? e}` };
      }
      this.onExit(id, res);
    })();
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  // On exit: free this agent's claims and notify its supervisor it's done. The notify is also the
  // deadlock escape — a supervisor parked on wait_message wakes even if the child crashed.
  private onExit(id: string, res: RunResult): void {
    const a = this.agents.get(id);
    if (a) {
      a.status = "done";
      a.summary = res.summary;
    }
    this.bus.releaseAll(id);
    if (a && a.parent !== "user") {
      // A failure surfaces the resume_id so the supervisor can continue it instead of losing its work.
      const note = res.success
        ? `✓ done: ${res.summary}`
        : `✗ did not finish: ${res.summary} — call spawn_minion with resume_id "${id}" and a short 'continue…' goal to resume it`;
      this.bus.send(a.parent, id, note);
    }
  }

  private listAgents(): string {
    return [...this.agents.values()]
      .map((a) => `${a.id} (${a.role}, supervisor ${a.parent}) — ${a.status}${a.summary ? `: ${a.summary}` : ""}`)
      .join("\n");
  }
}

// Per-agent UI: concurrent agents share one console, so prefix each line with the agent id and stay off
// the single shared spinner/footer (which can't serve many agents at once). update_plan output is left
// unprefixed so the checklist parser still reads it.
function labeledUI(base: UI, label: string): UI {
  const tag = (s: string) => `[${label}] ${s}`;
  return {
    thinking: () => {},
    thought: () => {},
    enterSubagent: (g) => base.enterSubagent(tag(g)),
    exitSubagent: (r) => base.exitSubagent(tag(r)),
    tool: (n, a, r) => base.tool(n, a, n === "update_plan" ? r : tag(r)),
    warn: (m) => base.warn(tag(m)),
    debug: base.debug,
    startRun: () => {},
    endRun: () => {},
    setModelLabel: () => {},
    context: () => {},
    usage: () => {},
    requestModelPolicy: async (): Promise<ModelPolicy> => "parent",
  };
}

// The most recent team in this process, kept so `/minions continue` (or a bare "continue" after a
// minions run) resumes it instead of starting a fresh, contextless team. One process = one slot; a new
// `/minions <goal>` replaces it. (One-shot mode exits between runs, so resume only helps interactive/piped.)
let lastTeam: Coordinator | null = null;
export const hasResumableTeam = (): boolean => lastTeam !== null;

export async function runMinions(goal: string, ui: UI, resume = false): Promise<RunResult> {
  const coord = resume && lastTeam ? lastTeam : new Coordinator(ui);
  lastTeam = coord;
  return coord.start(goal);
}
