import { appendFileSync } from "node:fs";

const RESULT_CLIP = 2_000;

export function logEvent(event: Record<string, unknown>): void {
  const file = process.env.AGENT_TRAJECTORY;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {}
}

export function clipForLog(s: string): string {
  return s.length <= RESULT_CLIP ? s : `${s.slice(0, RESULT_CLIP)}…[+${s.length - RESULT_CLIP} chars]`;
}
