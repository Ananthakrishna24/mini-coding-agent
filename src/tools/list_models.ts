// list_models: hand the model the curated model catalog (prompts/models.md) — which models exist, what
// each is good at, and the reasoning effort to use. Kept out of the system prompt and fetched only when
// the agent asks, so the always-on context stays lean. Read fresh on each call so a manual edit to the
// catalog shows up without a restart.
import { readFileSync } from "node:fs";
import type { Tool } from "./types";

function load(): string {
  try {
    return readFileSync(new URL("../prompts/models.md", import.meta.url), "utf8").trim();
  } catch {
    return "";
  }
}

export const list_models: Tool = {
  schema: {
    type: "function",
    function: {
      name: "list_models",
      description:
        "Return the curated catalog of available models — each model's strengths, the reasoning effort " +
        "to use, and example tasks it's good at. Call this when deciding which model to assign to a " +
        "delegated subagent (spawn_agent's `model`/`effort`). Read-only, takes no arguments.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  run: async () => load() || "No model catalog is configured (prompts/models.md is missing or empty).",
};
