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
  const { run } = await import("./agent");
  const { getModel, setModel } = await import("./llm");
  const { createUI, resultLine, describeModel } = await import("./ui");
  const ui = createUI();
  const info = await setModel(getModel()).catch(() => undefined);
  ui.setModelLabel(describeModel(info, getModel()));
  const t0 = Date.now();
  try {
    const r = await run(goal, ui);
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
    const t0 = Date.now();
    try {
      const r = await run(line, ui, 0, conversation);
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
