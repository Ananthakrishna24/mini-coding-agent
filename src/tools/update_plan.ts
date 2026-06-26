// update_plan: the agent's working memory for a multi-step job. The model calls this to write or
// revise its todo list; the rendered checklist comes straight back as the result, so the plan
// re-enters the conversation and the model re-reads its own latest plan every turn. That's what
// keeps it on-rails over a long run and across compaction (Module 3) — the plan is restated near
// the bottom of the history instead of buried at the top.
//
// It's a real dispatch tool, not a terminal signal like final_answer: it runs, validates, and
// returns. Its only effect is on the *conversation*, not the world. The model sends the whole list
// every call (replace, not diff) — simpler contract, less for the model to get wrong. An optional
// one-line `explanation` rides along to record *why* a revision happened (what was learned, why the
// shape changed); it's prepended to the rendered plan so the rationale re-enters context too.
import type { Tool } from "./types";

const STATUSES = ["pending", "in_progress", "completed"] as const;
type Status = (typeof STATUSES)[number];
type Step = { step: string; status: Status };

const MARK: Record<Status, string> = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };

// Pure renderer — a checkbox list, compact and readable in the run log. Exported so the offline
// self-check can hit it directly.
export function renderPlan(plan: Step[]): string {
  return plan.map((s) => `${MARK[s.status]} ${s.step}`).join("\n");
}

export const update_plan: Tool = {
  schema: {
    type: "function",
    function: {
      name: "update_plan",
      description:
        "Track a genuinely multi-step task as a todo list. Call this first to lay out the steps, then " +
        "call it again to update statuses as you finish each one. Send the whole list every time. Keep " +
        "exactly one step 'in_progress', and set a step 'in_progress' before marking it 'completed'. " +
        "Each step names concrete, verifiable work — no filler or obvious steps. Skip this for trivial " +
        "or single-step work. Optionally pass a one-line 'explanation' for why a revision happened.",
      parameters: {
        type: "object",
        properties: {
          explanation: {
            type: "string",
            description: "Optional one-line note on why the plan changed — what you learned or why the shape shifted.",
          },
          plan: {
            type: "array",
            description: "The full ordered list of steps. Replaces the previous list.",
            items: {
              type: "object",
              properties: {
                step: { type: "string", description: "What this step does, in a few words." },
                status: { type: "string", enum: [...STATUSES], description: "pending, in_progress, or completed." },
              },
              required: ["step", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["plan"],
        additionalProperties: false,
      },
    },
  },
  // Validate at the boundary like every tool. Throws on bad input; dispatch turns the throw into an
  // `error: …` result the model can correct (Task 4.1) — never a crash.
  async run({ plan, explanation }) {
    if (!Array.isArray(plan) || plan.length === 0) {
      throw new Error("update_plan: 'plan' must be a non-empty array of steps");
    }
    if (explanation != null && typeof explanation !== "string") {
      throw new Error("update_plan: 'explanation' must be a string when provided");
    }
    const steps: Step[] = plan.map((s: any, i) => {
      if (!s || typeof s.step !== "string" || s.step.trim() === "") {
        throw new Error(`update_plan: step ${i + 1} needs a non-empty 'step' string`);
      }
      if (!STATUSES.includes(s.status)) {
        throw new Error(`update_plan: step ${i + 1} has invalid status '${s.status}' (use ${STATUSES.join(", ")})`);
      }
      return { step: s.step.trim(), status: s.status };
    });

    // Soft invariant from real harnesses: one step in flight at a time keeps the model focused and
    // "where are we?" answerable at a glance.
    const inProgress = steps.filter((s) => s.status === "in_progress").length;
    if (inProgress > 1) {
      throw new Error(`update_plan: only one step may be 'in_progress' at a time (got ${inProgress})`);
    }

    // Bare checklist when there's no note, so the common path stays clean; prepend the one-liner
    // when given so the rationale rides back into context alongside the plan.
    const note = typeof explanation === "string" ? explanation.trim() : "";
    return note ? `${note}\n\n${renderPlan(steps)}` : renderPlan(steps);
  },
};
