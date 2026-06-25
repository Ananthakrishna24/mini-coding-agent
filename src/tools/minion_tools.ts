// Schemas for the six /minions coordination tools. Like spawn_agent/final_answer these are NOT
// dispatch-registry tools: running them needs the live coordinator and the caller's own agent id,
// which live in the loop — so the loop intercepts them by name (via coord.handle) and this file stays
// a pure schema leaf. Gru (the PM) gets the control tools but no claim_file (it writes no code).
import type OpenAI from "openai";

const spawn_minion: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "spawn_minion",
    description:
      "Delegate a self-contained slice of work to a new agent below you, which runs concurrently and " +
      "reports back by messaging you. gru spawns overseers (unit heads); overseers and minions spawn " +
      "minions (developers). Give a complete, standalone brief — say which files/area it owns so claims " +
      "don't collide. It can't ask you questions until it messages you. Returns the new agent's id. If an " +
      "agent you spawned reported it didn't finish, call this again with its `resume_id` and a short " +
      "'continue…' goal to pick up where it left off instead of starting it over.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "A complete, standalone brief for the new agent — what to build and what to report back." },
        resume_id: {
          type: "string",
          description: "Resume a cut-off agent you previously spawned, by its id (see list_agents). Its prior work and context are restored and `goal` becomes the follow-up instruction. Omit to spawn a fresh agent.",
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
};

const send_message: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "send_message",
    description:
      "Send a note to any live agent by id (e.g. 'gru', 'overseer-1', 'minion-2'). Use it to hand off " +
      "work, ask a question, divide up files, or report status. The recipient receives it on their next " +
      "wait_message (or immediately if they're already waiting).",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "The recipient agent's id (see list_agents)." },
        text: { type: "string", description: "The message body." },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
};

const wait_message: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "wait_message",
    description:
      "Block until another agent messages you, or until the timeout elapses. This is how you wait for a " +
      "teammate's signal before continuing. A supervisor uses it to collect progress and 'done' reports " +
      "from the agents it spawned before finishing. Returns the message, or a timeout note if none arrived.",
    parameters: {
      type: "object",
      properties: {
        timeout_s: { type: "number", description: "Seconds to wait before giving up (default 90, max 600)." },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const list_agents: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "list_agents",
    description: "List every agent in the team right now — id, role, supervisor, and whether it's still running or done.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

const claim_file: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "claim_file",
    description:
      "Claim a file BEFORE you write or edit it, so two agents never touch the same file at once. If it's " +
      "already held by someone else, do NOT write it — send_message them to coordinate, or work elsewhere. " +
      "Returns 'claimed' or an error naming the holder.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "The file path to claim (relative to the workspace)." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

const release_file: OpenAI.ChatCompletionTool = {
  type: "function",
  function: {
    name: "release_file",
    description: "Release a file you claimed once you're done editing it, so a teammate can take it.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "The file path to release." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

// gru coordinates but writes no code → no claim/release. Overseers and minions get the full set.
export const gruControlSchemas: OpenAI.ChatCompletionTool[] = [spawn_minion, send_message, wait_message, list_agents];
export const minionControlSchemas: OpenAI.ChatCompletionTool[] = [...gruControlSchemas, claim_file, release_file];

// Names the loop must route to coord.handle instead of the normal dispatch path.
export const MINION_TOOLS = new Set([
  "spawn_minion",
  "send_message",
  "wait_message",
  "list_agents",
  "claim_file",
  "release_file",
]);
