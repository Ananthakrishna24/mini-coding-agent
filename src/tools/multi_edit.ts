// Tool for applying multiple exact-text replacements across one or more files atomically.
import path from "node:path";
import type { Tool } from "./types";
import { resolveInWorkspace, WORKSPACE } from "./workspace";
import { writeAtomic } from "./atomic";
import { readTextFile } from "./read-text";
import { forgetFileRead, requireFreshWholeFileRead } from "./file-state";
import { withPathLocks } from "./path-locks";

type EditArg = { path: string; old_string: string; new_string: string; replace_all?: boolean };

export const multi_edit: Tool = {
  schema: {
    type: "function",
    function: {
      name: "multi_edit",
      description:
        "Apply several exact-text edits in one call, across one or more workspace files, as a single " +
        "all-or-nothing batch. Each edit replaces an exact 'old_string' with 'new_string' in its file; " +
        "'old_string' must match exactly (including whitespace) and be unique unless 'replace_all' is " +
        "true. Edits apply in order, so a later edit sees an earlier one's result on the same file. If " +
        "any edit fails to apply, none are written — fix it and resend the batch. Prefer this over " +
        "multiple edit_file calls when changing several places at once. Read each file first.",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description: "The ordered list of edits to apply as one batch.",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path relative to the workspace root." },
                old_string: { type: "string", description: "Exact text to find. Include surrounding lines so it matches one place." },
                new_string: { type: "string", description: "Text to put in its place." },
                replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match. Default false." },
              },
              required: ["path", "old_string", "new_string"],
              additionalProperties: false,
            },
          },
        },
        required: ["edits"],
        additionalProperties: false,
      },
    },
  },
  async run({ edits }) {
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new Error("multi_edit: 'edits' must be a non-empty array");
    }

    const parsed: Array<EditArg & { abs: string }> = [];
    const lockPaths: string[] = [];
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] as EditArg;
      const at = `edit ${i + 1}`;
      if (!e || typeof e.path !== "string") throw new Error(`multi_edit: ${at} needs a 'path' string`);
      if (typeof e.old_string !== "string" || typeof e.new_string !== "string") {
        throw new Error(`multi_edit: ${at} (${e.path}): 'old_string' and 'new_string' must be strings`);
      }
      if (e.old_string === "") throw new Error(`multi_edit: ${at} (${e.path}): 'old_string' is empty — use write_file to create a file`);
      if (e.old_string === e.new_string) throw new Error(`multi_edit: ${at} (${e.path}): 'old_string' and 'new_string' are identical — nothing to change`);
      const abs = resolveInWorkspace(e.path);
      parsed.push({ ...e, abs });
      lockPaths.push(abs);
    }

    return await withPathLocks(lockPaths, async () => {
      // Tracks working copies, display paths, and replacement counts.
      const working = new Map<string, string>();
      const display = new Map<string, string>();
      const counts = new Map<string, number>();
      const order: string[] = [];

      for (let i = 0; i < parsed.length; i++) {
        const e = parsed[i];
        const at = `edit ${i + 1}`;

        const abs = e.abs;
        if (!working.has(abs)) {
          await requireFreshWholeFileRead(abs, "multi_edit"); // Ensure file is fresh
          working.set(abs, await readTextFile(abs));
          display.set(abs, e.path);
          counts.set(abs, 0);
          order.push(abs);
        }

        const text = working.get(abs)!;
        const matches = text.split(e.old_string).length - 1; // Literal match count
        if (matches === 0) throw new Error(`multi_edit: ${at} (${e.path}): 'old_string' not found in the file`);
        const all = e.replace_all === true;
        if (matches > 1 && !all) {
          throw new Error(`multi_edit: ${at} (${e.path}): 'old_string' matches ${matches} places — add surrounding context to make it unique, or set replace_all`);
        }

        // Use split/join or replacement function to avoid parsing replacement patterns.
        working.set(abs, all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string));
        counts.set(abs, counts.get(abs)! + (all ? matches : 1));
      }

      // Commit all changes atomically.
      for (const abs of order) {
        await writeAtomic(abs, working.get(abs)!);
        forgetFileRead(abs);
      }

      const parts = order.map((abs) => {
        const n = counts.get(abs)!;
        return `${display.get(abs) ?? path.relative(WORKSPACE, abs)} (${n} replacement${n === 1 ? "" : "s"})`;
      });
      return `edited ${order.length} file${order.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
    });
  },
};
