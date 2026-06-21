// Entry point: run a goal through the agent. Pass it on the command line.
import { run } from "./agent";

const goal =
  process.argv.slice(2).join(" ") ||
  "List the files here, read package.json, and tell me the project name.";

console.log(`> ${goal}\n`);
const summary = await run(goal);
console.log(`\n${summary}`);
