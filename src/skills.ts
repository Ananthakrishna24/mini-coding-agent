// Bundled skills: curated capability playbooks the agent loads on demand. The system prompt lists each
// skill's name + description (progressive disclosure — cheap to keep in context every turn); the model
// pulls a full body only when it's relevant, via the read_skill tool. Skills ship as files beside the
// build (see package.json "files"), so the dir is resolved relative to this module — same in dev (src/)
// and in the published dist (dist/), since `../skills` lands at the package root either way.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Skill = { name: string; description: string };

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
// Skill id = its directory name. Lowercase + hyphens only: this is both the on-disk shape and the guard
// that keeps an untrusted read_skill name from escaping SKILLS_DIR via "../" or an absolute path.
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Pull `description` out of a SKILL.md "--- key: value ---" frontmatter block. Tiny on purpose: we own
// these files and the format is fixed, so a full YAML parser is overkill (ponytail: stdlib regex does it).
function frontmatterDescription(md: string): string {
  const block = md.match(/^---\n([\s\S]*?)\n---/);
  if (!block) return "";
  const line = block[1].split("\n").find((l) => /^description:/i.test(l));
  return line ? line.replace(/^description:\s*/i, "").trim() : "";
}

let cache: Skill[] | null = null;

// Every skills/<name>/SKILL.md that has a description, scanned once per session and keyed by dir name.
// A skill missing its file/description is skipped, not fatal — one bad dir can't hide the rest.
export function listSkills(): Skill[] {
  if (cache) return cache;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return (cache = []); // no skills dir → no skills
  }
  const out: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
    try {
      const description = frontmatterDescription(fs.readFileSync(path.join(SKILLS_DIR, e.name, "SKILL.md"), "utf8"));
      if (description) out.push({ name: e.name, description });
    } catch {
      // no SKILL.md or unreadable — skip
    }
  }
  return (cache = out.sort((a, b) => a.name.localeCompare(b.name)));
}

// The "## Skills" block for the system prompt: name → description + how to load one. Empty string when
// there are no skills, so a fresh checkout carries no dangling section.
export function skillsPromptBlock(): string {
  const skills = listSkills();
  if (!skills.length) return "";
  const rows = skills.map((s) => `- **${s.name}** — ${s.description}`).join("\n");
  return `## Skills

Curated playbooks for specific kinds of work. When a task matches one (UI/visual work, UX/product
decisions, …), load it with \`read_skill\` first and follow it — just the relevant one. Skip this for
tasks no skill covers.

${rows}`;
}

// Body of skills/<name>/SKILL.md for read_skill. `name` is untrusted model input: validate against the
// dir charset and the known set so it can't read outside SKILLS_DIR.
export function readSkill(name: unknown): string {
  const names = () => listSkills().map((s) => s.name).join(", ") || "(none)";
  if (typeof name !== "string" || !NAME_RE.test(name) || !listSkills().some((s) => s.name === name)) {
    throw new Error(`read_skill: no skill '${name}' — available: ${names()}`);
  }
  return fs.readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8").trim();
}
