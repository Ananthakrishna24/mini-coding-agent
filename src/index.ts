// Entry point: run a goal through the agent. Pass it on the command line.
import { run } from "./agent";

const goal =
  process.argv.slice(2).join(" ") ||
  "List the files here, read package.json, and tell me the project name.";

console.log(`> ${goal}\n`);
try {
  const result = await run(goal);
  console.log(`\n${result.success ? "✓" : "✗"} ${result.summary}`);
  process.exit(result.success ? 0 : 1); // structured result → a real exit code a script can read
} catch (e: any) {
  // Retries are exhausted by here — give the user one clean line, not a stack trace.
  console.error(`\nagent failed: ${e.message ?? e}`);
  process.exit(1);
}
