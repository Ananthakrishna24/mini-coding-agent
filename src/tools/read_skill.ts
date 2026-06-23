// read_skill: load a bundled skill's full playbook by name. The system prompt lists what's available
// (name + description under "## Skills"); this returns the body of the one the model picks, on demand —
// progressive disclosure, so the full instructions only enter context when they're actually needed.
import type { Tool } from "./types";
import { readSkill } from "../skills";

export const read_skill: Tool = {
  schema: {
    type: "function",
    function: {
      name: "read_skill",
      description:
        "Load a curated skill's full instructions by name. Available skills are listed under '## Skills' " +
        "in the system prompt — call this with one of those names before doing work that skill covers.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The skill name, exactly as listed under '## Skills'." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  async run({ name }) {
    return readSkill(name);
  },
};
