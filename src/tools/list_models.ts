// Returns the model catalog from prompts/models.md.
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
