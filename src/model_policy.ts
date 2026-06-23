// Session-wide choice for how subagents get their model, decided by the user on the first delegation
// and held for the rest of the session: "parent" = every subagent runs on the current model (the
// agent's per-task model picks are ignored); "auto" = the agent may assign a model per subagent.
// Module-level so it survives across the turns of one session; reset on /clear.
export type ModelPolicy = "parent" | "auto";

let policy: ModelPolicy | null = null;

export const getModelPolicy = (): ModelPolicy | null => policy;
export const setModelPolicy = (p: ModelPolicy): void => void (policy = p);
export const resetModelPolicy = (): void => void (policy = null);
