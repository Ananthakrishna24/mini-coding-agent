// CLI shell. With a goal on the command line: run it once and exit with a real code (scriptable).
// With no args: an interactive chat loop — type a goal, watch it work, type the next one.
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { run } from "./agent";
import { MODEL } from "./llm";
import { createUI, banner, resultLine, echoUser, c } from "./ui";

const ui = createUI();

async function once(goal: string): Promise<boolean> {
  const t0 = Date.now();
  try {
    const r = await run(goal, ui);
    resultLine(r.success, r.summary, Date.now() - t0);
    return r.success;
  } catch (e: any) {
    ui.thinking(false); // kill the spinner before printing — retries are already exhausted in run()
    resultLine(false, `agent failed: ${e.message ?? e}`, Date.now() - t0);
    return false;
  }
}

const goal = process.argv.slice(2).join(" ").trim();

if (goal) {
  process.exit((await once(goal)) ? 0 : 1); // one-shot: structured result → a real exit code
}

// No goal → interactive chat. Top-level await keeps this flat; readline owns the prompt.
banner(MODEL);
const rl = createInterface({ input, output });
rl.on("SIGINT", () => process.exit(0)); // Ctrl-C exits; ui's exit handler restores the cursor

while (true) {
  let line: string;
  try {
    line = (await rl.question(c.cyan("› "))).trim();
  } catch {
    break; // readline closed (Ctrl-D / EOF) — leave the loop instead of crashing on the next question
  }
  if (!line) continue;
  if (line === "exit" || line === "quit") break;
  echoUser(line); // lock the message in as a styled chat line before the run starts
  await once(line);
}
rl.close();
