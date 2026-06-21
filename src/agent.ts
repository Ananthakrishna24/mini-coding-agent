// The agent loop: call the model with tools, run any tool calls, feed results back, repeat
// until the model stops calling tools or we hit the turn limit.
import type OpenAI from "openai";
import { chat } from "./llm";
import { toolSchemas, dispatch } from "./tools";

const MAX_TURNS = 12;

const SYSTEM =
  "You are a coding agent working inside a project directory. Use the tools to read, " +
  "write, and run code to accomplish the task. When the task is complete, reply with a " +
  "short summary and stop calling tools.";

export async function run(goal: string): Promise<string> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: goal },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await chat(messages, toolSchemas);
    const msg = res.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) return msg.content ?? "(no output)";

    for (const call of msg.tool_calls) {
      if (call.type !== "function") continue;
      const result = await dispatch(call.function.name, call.function.arguments);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
      const preview = result.slice(0, 100).replace(/\s+/g, " ");
      console.log(`  · ${call.function.name}(${call.function.arguments}) -> ${preview}`);
    }
  }

  return `stopped: hit ${MAX_TURNS}-turn limit`;
}
