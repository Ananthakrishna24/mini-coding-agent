// Offline self-check for the run_bash sandbox wrapper — no model/network needed.
import assert from "node:assert/strict";
import { macSeatbeltProfile, prepareBashCommand } from "./tools/sandbox";

const profile = macSeatbeltProfile("/tmp/demo-workspace");
assert.match(profile, /\(deny network\*\)/, "macOS profile denies network by default");
assert.match(profile, /\(require-not \(subpath "\/tmp\/demo-workspace"\)\)/, "macOS profile allows writes under the workspace");
assert.match(profile, /\(deny file-write\*/, "macOS profile constrains file writes");

const oldMode = process.env.AGENT_SANDBOX;
try {
  process.env.AGENT_SANDBOX = "danger-full-access";
  const prepared = await prepareBashCommand("echo hi", "/tmp/demo-workspace");
  assert.equal(prepared.program, "bash", "explicit opt-out uses the direct shell");
  assert.deepEqual(prepared.args, ["-c", "echo hi"], "direct shell preserves the command");
  assert.match(prepared.env.TMPDIR ?? "", /demo-workspace/, "direct shell still uses a workspace-local temp dir");
} finally {
  if (oldMode === undefined) delete process.env.AGENT_SANDBOX;
  else process.env.AGENT_SANDBOX = oldMode;
}

console.log("ok — sandbox self-check passed");
