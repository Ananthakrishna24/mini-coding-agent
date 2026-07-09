export type TrajectoryEvent = { type: string } & Record<string, any>;

export type Metrics = {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  toolErrors: number;
  editFailures: number;
  bareResponses: number;
  compactions: number;
};

export function parseTrajectory(text: string): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.type === "string") events.push(e);
    } catch {}
  }
  return events;
}

export function computeMetrics(events: TrajectoryEvent[]): Metrics {
  const m: Metrics = { turns: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, toolErrors: 0, editFailures: 0, bareResponses: 0, compactions: 0 };
  for (const e of events) {
    if (e.type === "assistant" && e.depth === 0) {
      m.turns++;
      if (!e.tool_calls?.length) m.bareResponses++;
    } else if (e.type === "usage") {
      m.promptTokens += e.prompt_tokens ?? 0;
      m.completionTokens += e.completion_tokens ?? 0;
    } else if (e.type === "tool_result") {
      m.toolCalls++;
      const result = typeof e.result === "string" ? e.result : "";
      if (result.startsWith("error:")) {
        m.toolErrors++;
        if (e.name === "edit_file" || e.name === "multi_edit") m.editFailures++;
      }
    } else if (e.type === "compaction") {
      m.compactions++;
    }
  }
  return m;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function formatMetrics(m: Metrics): string {
  return [
    `turns ${m.turns}`,
    `tokens ${k(m.promptTokens)}/${k(m.completionTokens)}`,
    `tools ${m.toolCalls} (${m.toolErrors} err, ${m.editFailures} edit-miss)`,
    `bare ${m.bareResponses}`,
    `compact ${m.compactions}`,
  ].join(" · ");
}
