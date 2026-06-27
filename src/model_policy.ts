// Session policy for subagent model selection ("parent" or "auto").
export type ModelPolicy = "parent" | "auto";

let policy: ModelPolicy | null = null;

export const getModelPolicy = (): ModelPolicy | null => policy;
export const setModelPolicy = (p: ModelPolicy): void => void (policy = p);
export const resetModelPolicy = (): void => void (policy = null);
