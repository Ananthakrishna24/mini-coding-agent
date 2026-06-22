// CLI shell. Three modes:
//  - goal on the command line → run once, print, exit with a real code (scriptable).
//  - interactive TTY → the Ink chat UI (app.tsx): chat scrollback, /commands, live status.
//  - interactive non-TTY (piped stdin) → a minimal readline loop that runs each line as a goal.
import { createElement } from "react";
import { render } from "ink";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { run } from "./agent";
import { getModel, setModel, modelInfo } from "./llm";
import { createUI, banner, resultLine, describeModel } from "./ui";

const goal = process.argv.slice(2).join(" ").trim();

if (goal) {
  // One-shot: plain console UI, structured result → a real exit code.
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
  const ui = createUI();
  banner(await modelInfo().catch(() => undefined), getModel());
  await setModel(getModel()).catch(() => undefined);
  const rl = createInterface({ input, output });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line || line === "exit" || line === "quit") break;
    const t0 = Date.now();
    try {
      const r = await run(line, ui);
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
