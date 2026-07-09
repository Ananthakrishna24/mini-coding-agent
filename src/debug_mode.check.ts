import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { isDebugMode, enableDebugMode, disableDebugMode, debugPromptBlock } from "./debug_mode";

assert.equal(isDebugMode(), false, "inactive at import");
assert.equal(debugPromptBlock(), "", "empty prompt block when inactive");

const { endpoint, logPath } = await enableDebugMode();
assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/ingest$/, "endpoint shape");
assert.ok(logPath.includes(`${path_sep()}.mini-agent${path_sep()}`), "log lives under .mini-agent/");
assert.equal(isDebugMode(), true, "active after enable");
const again = await enableDebugMode();
assert.equal(again.endpoint, endpoint, "enable is idempotent");
assert.equal(again.logPath, logPath, "same log path on second enable");

const event = { hypothesisId: "H1", message: "t", data: { x: 1 } };
let res = await fetch(endpoint, { method: "POST", body: JSON.stringify(event) });
assert.equal(res.status, 204, "valid JSON POST accepted");
let lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
assert.equal(lines.length, 1, "one NDJSON line after first POST");
assert.deepEqual(JSON.parse(lines[0]!), event, "event roundtrips through the log");

const event2 = { hypothesisId: "H2", message: "u", data: { y: 2 } };
res = await fetch(endpoint, { method: "POST", body: JSON.stringify(event2) });
assert.equal(res.status, 204, "second POST accepted");
lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
assert.equal(lines.length, 2, "second POST appended a line");
assert.deepEqual(JSON.parse(lines[1]!), event2, "second event roundtrips");

res = await fetch(endpoint, { method: "POST", body: "not json {{{" });
assert.equal(res.status, 400, "invalid JSON rejected");
assert.equal(await res.text(), "invalid json");

res = await fetch(endpoint.replace("/ingest", "/health"));
assert.equal(res.status, 200, "health check responds");
assert.equal(await res.text(), "ok");

res = await fetch(endpoint.replace("/ingest", "/nope"));
assert.equal(res.status, 404, "unknown route is 404");

if (existsSync(new URL("./prompts/debug.md", import.meta.url))) {
  const block = debugPromptBlock();
  assert.ok(block.startsWith("<debug-mode>\n") && block.endsWith("\n</debug-mode>"), "wrapped in debug-mode tags");
  assert.ok(block.includes(endpoint), "endpoint substituted into prompt");
  assert.ok(!block.includes("{{ENDPOINT}}"), "no leftover endpoint placeholder");
  assert.ok(!block.includes("{{LOG_PATH}}"), "no leftover log path placeholder");
}

await disableDebugMode();
assert.equal(isDebugMode(), false, "inactive after disable");
assert.equal(debugPromptBlock(), "", "empty prompt block after disable");
await assert.rejects(fetch(endpoint), "old endpoint unreachable after disable");
await disableDebugMode();

await fs.rm(logPath);

function path_sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

console.log("ok — debug_mode self-check passed");
