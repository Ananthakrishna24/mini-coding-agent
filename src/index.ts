#!/usr/bin/env node
// CLI shell. Three modes:
//  - goal on the command line → run once, print, exit with a real code (scriptable).
//  - interactive TTY → the Ink chat UI (app.tsx): chat scrollback, /commands, live status.
//  - interactive non-TTY (piped stdin) → a minimal readline loop that runs each line as a goal.
// ./llm throws at import if no provider key is set, so anything importing it is loaded dynamically
// AFTER the first-run onboarding step has had a chance to write one.
import { createElement } from "react";
import { render } from "ink";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const goal = process.argv.slice(2).join(" ").trim();

// First run with no usable key: an interactive TTY gets the onboarding screen (writes .env, then we
// continue); a non-TTY prints which env vars to set and exits (never hangs on input it can't get).
// When a key is already present this is a no-op and we fall through to the normal startup.
{
  const { runOnboarding } = await import("./onboarding");
  await runOnboarding();
}

if (goal) {
  // One-shot: plain console UI, structured result → a real exit code.
  // `/minions <goal>` runs the concurrent team (gru → overseers → minions) instead of a single agent.
  const minions = goal.startsWith("/minions");
  const realGoal = minions ? goal.slice("/minions".length).trim() : goal;
  const { run } = await import("./agent");
  const { runMinions } = await import("./minions");
  const { getModel, setModel } = await import("./llm");
  const { createUI, resultLine, describeModel } = await import("./ui");
  const ui = createUI();
  const info = await setModel(getModel()).catch(() => undefined);
  ui.setModelLabel(describeModel(info, getModel()));
  const t0 = Date.now();
  try {
    const r = minions ? await runMinions(realGoal, ui) : await run(realGoal, ui);
    ui.endRun();
    resultLine(r.success, r.summary, Date.now() - t0);
    process.exit(r.success ? 0 : 1);
  } catch (e: any) {
    ui.thinking(false);
    ui.endRun();
    resultLine(false, `agent failed: ${e.message ?? e}`, Date.now() - t0);
    process.exit(1);
  }
}

if (process.stdin.isTTY) {
  // Interactive TTY → Ink. store.init loads the model catalog + banner before the first render.
  const { App } = await import("./app");
  const { init } = await import("./store");
  await init();
  const app = render(createElement(App));
  await app.waitUntilExit();
} else {
  // Piped stdin (no TTY) → no Ink (it needs raw mode). Run each line as a goal with the plain UI.
  const { run } = await import("./agent");
  const { runMinions } = await import("./minions");
  const { getModel, setModel, modelInfo } = await import("./llm");
  const { createUI, banner, resultLine } = await import("./ui");
  const ui = createUI();
  banner(await modelInfo().catch(() => undefined), getModel());
  await setModel(getModel()).catch(() => undefined);
  const rl = createInterface({ input, output });
  const conversation: import("openai").default.ChatCompletionMessageParam[] = []; // session thread across piped lines
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line === "exit" || line === "quit") break;
    const minions = line.startsWith("/minions");
    const mArg = minions ? line.slice("/minions".length).trim() : "";
    const resume = minions && (!mArg || /^(continue|resume)\b/i.test(mArg)); // resume the last team in this process
    const t0 = Date.now();
    try {
      // `/minions` runs the concurrent team in a fresh context (no shared conversation thread); `/minions
      // continue` resumes the previous team with its agents' transcripts intact.
      const r = minions
        ? await runMinions(resume ? "Continue where the team left off — call list_agents and resume any agent that didn't finish (spawn_minion with its resume_id)." : mArg, ui, resume)
        : await run(line, ui, 0, conversation);
      ui.endRun();
      resultLine(r.success, r.summary, Date.now() - t0);
    } catch (e: any) {
      ui.thinking(false);
      ui.endRun();
      resultLine(false, `agent failed: ${e.message ?? e}`, Date.now() - t0);
    }
  }
  rl.close();
}
