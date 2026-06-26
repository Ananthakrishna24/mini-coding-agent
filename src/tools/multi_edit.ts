// multi_edit: apply several exact-text replacements in one call, across one or more workspace files,
// as a single all-or-nothing batch. This is the leverage tool for a refactor: instead of one
// edit_file round-trip per change, the model sends the whole set and the harness applies them
// transactionally. Every edit is validated and applied to an in-memory working copy first; nothing is
// written until all of them succeed, so a failing edit can never leave a half-applied change on disk.
//
// Edits run in array order. Two edits on the same file stack — a later one sees the earlier one's
// result — which is what lets the model rename a symbol and then touch the renamed line in one batch.
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "./types";
import { resolveInWorkspace, WORKSPACE } from "./workspace";
import { writeAtomic } from "./atomic";
import { readTextFile } from "./read-text";
import { noteFileRead, requireFreshWholeFileRead } from "./file-state";

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

    // Working copies keyed by absolute path; original first-seen display path and a running
    // replacement count travel alongside for the summary. Loaded lazily so each file is read (and
    // freshness-checked) exactly once, no matter how many edits target it.
    const working = new Map<string, string>();
    const display = new Map<string, string>();
    const counts = new Map<string, number>();
    const order: string[] = [];

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
      if (!working.has(abs)) {
        await requireFreshWholeFileRead(abs, "multi_edit"); // throws before any write — batch stays atomic
        working.set(abs, await readTextFile(abs));
        display.set(abs, e.path);
        counts.set(abs, 0);
        order.push(abs);
      }

      const text = working.get(abs)!;
      const matches = text.split(e.old_string).length - 1; // literal count, no regex
      if (matches === 0) throw new Error(`multi_edit: ${at} (${e.path}): 'old_string' not found in the file`);
      const all = e.replace_all === true;
      if (matches > 1 && !all) {
        throw new Error(`multi_edit: ${at} (${e.path}): 'old_string' matches ${matches} places — add surrounding context to make it unique, or set replace_all`);
      }

      // split/join (replace_all) and a function replacement (single) both insert new_string literally —
      // a string replacement would treat $&, $1, etc. in new_string as backreferences.
      working.set(abs, all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string));
      counts.set(abs, counts.get(abs)! + (all ? matches : 1));
    }

    // Every edit validated and applied in memory — commit now. Nothing above touched disk, so a throw
    // anywhere in the loop leaves the tree exactly as it was.
    for (const abs of order) {
      await writeAtomic(abs, working.get(abs)!);
      const stat = await fs.stat(abs);
      noteFileRead(abs, stat.mtimeMs, false); // keep the file editable later this run without a re-read
    }

    const parts = order.map((abs) => {
      const n = counts.get(abs)!;
      return `${display.get(abs) ?? path.relative(WORKSPACE, abs)} (${n} replacement${n === 1 ? "" : "s"})`;
    });
    return `edited ${order.length} file${order.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
  },
};
