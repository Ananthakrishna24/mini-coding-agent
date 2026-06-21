// Entry point. For now: verify the model connection. Grows into the agent loop.
import { chat } from "./llm";

const res = await chat([{ role: "user", content: "Say hello in one sentence." }]);

console.log(res.choices[0].message.content);
console.log("usage:", res.usage);
