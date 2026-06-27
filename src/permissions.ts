// Validates tool calls before execution to prevent destructive or unsafe actions.
export type Decision = { allow: true } | { allow: false; reason: string };

// Commands we never run. Each is irreversible (no undo) or escapes the workspace.
//
// A regex deny-list is an accident-fence, not a sandbox. It raises the cost of the model
// fat-fingering a destructive command; it does NOT stop a determined injected attacker.
// Real containment is an OS sandbox (bubblewrap/Landlock, Seatbelt) with no net / no writes outside the tree.
const DENY: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+-\w*r/i,                              reason: "recursive delete (rm -r)" },
  { pattern: /\bfind\b[^\n|;&]*\s-delete\b/i,               reason: "bulk delete (find -delete)" },
  { pattern: /\bsudo\b/i,                                  reason: "privilege escalation (sudo)" },
  { pattern: /\bgit\s+push\b/i,                            reason: "pushes to a remote — outside the workspace" },
  { pattern: /(curl|wget)[^\n|]*\|\s*(sudo\s+)?\w*sh\b/i,  reason: "pipes a download straight into a shell" },
  { pattern: /\b(mkfs|dd)\b[^|\n]*\/dev\//i,               reason: "writes to a raw disk device" },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i,              reason: "redirects output onto a disk device" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i,       reason: "halts or reboots the machine" },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/,            reason: "fork bomb" },
];

// Read-only tools can't break anything — gating them only trains the user to rubber-stamp.
const READ_ONLY = new Set(["read_file", "web_fetch", "web_search"]);

// deny → allow. (The interactive "ask" tier from real harnesses needs a human at a prompt;
// this loop runs autonomously, so there's nobody to ask — deferred with the OS sandbox.)
export function check(name: string, args: Record<string, unknown>): Decision {
  if (READ_ONLY.has(name)) return { allow: true };

  if (name === "run_bash") {
    const command = typeof args.command === "string" ? args.command : "";
    for (const { pattern, reason } of DENY) {
      if (pattern.test(command)) return { allow: false, reason: `${reason}` };
    }
  }

  // write_file / edit_file: workspace confinement (workspace.ts) is their fence, and in-tree
  // edits are reversible under git. A run_bash command that isn't on the deny-list runs.
  return { allow: true };
}
