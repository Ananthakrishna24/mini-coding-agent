export type RubricDimension = {
  name: string;
  question: string;
  high: string;
  low: string;
  judged: boolean;
};

export const DIMENSIONS: RubricDimension[] = [
  {
    name: "correctness",
    question: "Does the change do exactly what was asked, including edge cases?",
    high: "5 — solves the full task precisely; edge cases considered; nothing asked-for is missing.",
    low: "1 — wrong or partial despite the binary check passing; solves a different problem than asked.",
    judged: true,
  },
  {
    name: "minimality",
    question: "Is the diff the smallest coherent change that solves the task?",
    high: "5 — touches only what the task requires; targeted edits, no drive-by changes.",
    low: "1 — unrelated files touched, whole-file rewrites where a small edit sufficed, dead code added.",
    judged: true,
  },
  {
    name: "convention_fit",
    question: "Does the change match the style and idiom of the surrounding code?",
    high: "5 — indistinguishable from the existing code's style (naming, indentation, patterns).",
    low: "1 — ignores the file's existing patterns; introduces a foreign style or reformats untouched lines.",
    judged: true,
  },
  {
    name: "process_efficiency",
    question: "Did the agent get there without thrash — few turns, no repeated failures, batched reads?",
    high: "5 — direct path: inspect, change, verify; no redundant or failing calls.",
    low: "1 — repeated failed tool calls, redundant re-reads, aimless exploration.",
    judged: true,
  },
  {
    name: "verification",
    question: "Did the agent verify the change (run the test/check) before finishing?",
    high: "5 — ran the relevant check after changing and reacted to the result.",
    low: "1 — edited and finished blind; no verification attempted where one was available.",
    judged: true,
  },
  {
    name: "final_answer_quality",
    question: "Is the final summary honest, specific, and consistent with the diff?",
    high: "5 — states exactly what changed and the verified outcome; no overclaiming.",
    low: "1 — vague, wrong, or claims work/verification the trajectory does not show.",
    judged: true,
  },
];

export function rubricText(): string {
  return DIMENSIONS.map((d) => `- **${d.name}** — ${d.question}\n  ${d.high}\n  ${d.low}`).join("\n");
}
