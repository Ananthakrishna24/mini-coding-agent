// First-run setup. Shown when the app starts interactively with no usable provider key: pick a
// provider, paste the key (never echoed in full), accept or override the starting model, then write
// a 0600 .env. Lives apart from the main App so it can run before ./llm is imported (which throws on
// a missing key). No model/network here — just key capture and the .env write.
import { createElement, useState, type FC } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import fs from "node:fs";
import path from "node:path";
import { c } from "./format";
import { PROVIDERS, resolveProvider, mergeEnv, type Provider } from "./provider";

const ENV_PATH = path.resolve(process.cwd(), ".env");

// True when no provider key is configured anywhere (env or an existing .env that --env-file loaded).
export function needsOnboarding(): boolean {
  return "error" in resolveProvider();
}

// Mask a key for display: keep a short head + tail, hide the middle. Never render the whole thing.
const maskKey = (k: string) => (k.length <= 8 ? "•".repeat(k.length) : `${k.slice(0, 4)}…${k.slice(-2)}`);

// Write/merge the chosen settings into .env with owner-only perms. Keeps unrelated lines intact.
function writeEnv(updates: Record<string, string>): void {
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  fs.writeFileSync(ENV_PATH, mergeEnv(existing, updates), { mode: 0o600 });
  fs.chmodSync(ENV_PATH, 0o600); // enforce perms even if the file already existed with looser ones
}

type Step = "provider" | "key" | "model" | "done";

// Runs two ways: standalone at first launch (runOnboarding renders it before the main App and it calls
// exit() when done), or as an in-app overlay for /setup (inApp: it calls onExit instead of tearing Ink
// down, and esc cancels). onExit reports whether a config was saved and the chosen model id.
export const Onboarding: FC<{ inApp?: boolean; onExit?: (saved: boolean, modelId?: string) => void }> = ({ inApp, onExit }) => {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("provider");
  const [provider, setProvider] = useState<Provider>("openrouter");
  const [sel, setSel] = useState(0);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");

  const providers: Provider[] = ["openrouter", "openai"];

  useInput((input, k) => {
    if (k.ctrl && input === "c") {
      if (inApp) onExit?.(false); // overlay: cancel without tearing the app down
      else exit();
      return;
    }
    if (k.escape && inApp) {
      onExit?.(false); // esc cancels the /setup overlay
      return;
    }
    if (step === "provider") {
      if (k.upArrow) setSel((s) => (s + providers.length - 1) % providers.length);
      else if (k.downArrow) setSel((s) => (s + 1) % providers.length);
      else if (k.return) {
        const p = providers[sel];
        setProvider(p);
        setModel(PROVIDERS[p].defaultModel);
        setStep("key");
        setError("");
      }
      return;
    }
    if (step === "key") {
      if (k.return) {
        if (!key.trim()) {
          setError("paste a key, or Ctrl-C to quit");
          return;
        }
        setStep("model");
        setError("");
      } else if (k.backspace || k.delete) setKey((v) => v.slice(0, -1));
      else if (input && !k.ctrl && !k.meta) setKey((v) => v + input);
      return;
    }
    if (step === "model") {
      if (k.return) {
        const chosen = model.trim() || PROVIDERS[provider].defaultModel;
        try {
          writeEnv({ PROVIDER: provider, [PROVIDERS[provider].keyVar]: key.trim(), AGENT_MODEL: chosen });
        } catch (e: any) {
          setError(`could not write .env: ${e.message ?? e}`);
          return;
        }
        setStep("done");
        if (inApp) onExit?.(true, chosen); // overlay: hand back to the store to reload + close
        else setTimeout(() => exit(), 600); // standalone: brief "saved" confirmation before tearing Ink down
      } else if (k.backspace || k.delete) setModel((v) => v.slice(0, -1));
      else if (input && !k.ctrl && !k.meta) setModel((v) => v + input);
      return;
    }
  });

  return createElement(
    Box,
    { flexDirection: "column", paddingX: 1, paddingY: 1 },
    createElement(Text, { key: "t" }, c.bold("Welcome — let's set up your model provider.")),
    createElement(Text, { key: "s", dimColor: true }, "Keys are written to .env (owner-only) and never printed."),
    createElement(Box, { key: "gap", marginTop: 1, flexDirection: "column" }, renderStep()),
    error ? createElement(Text, { key: "e", color: "yellow" }, `\n${error}`) : null,
  );

  function renderStep() {
    if (step === "provider") {
      return [
        createElement(Text, { key: "q" }, "Choose a provider  ", c.dim("(↑↓, ⏎ to select)")),
        ...providers.map((p, i) =>
          createElement(
            Text,
            { key: p, color: i === sel ? undefined : "gray" },
            `${i === sel ? c.primary("❯") : " "} ${PROVIDERS[p].label}  ${c.dim(PROVIDERS[p].keyVar)}`,
          ),
        ),
      ];
    }
    if (step === "key") {
      return [
        createElement(Text, { key: "q" }, `Paste your ${PROVIDERS[provider].label} API key  `, c.dim("(⏎ to continue)")),
        createElement(Text, { key: "v" }, "  ", key ? c.primary(maskKey(key)) : c.dim("waiting for input…")),
      ];
    }
    if (step === "model") {
      return [
        createElement(Text, { key: "q" }, "Starting model  ", c.dim("(⏎ to accept the default, or type an id)")),
        createElement(Text, { key: "v" }, "  ", c.primary(model || PROVIDERS[provider].defaultModel)),
      ];
    }
    return [createElement(Text, { key: "d", color: "green" }, `✔ Saved ${PROVIDERS[provider].label} config to .env`)];
  }
};

// Run onboarding if needed. Resolves true if it wrote a .env (caller should re-load env + continue),
// false if onboarding wasn't needed. On a non-TTY, prints instructions and exits the process so the
// app never hangs waiting on input that can't arrive.
export async function runOnboarding(): Promise<boolean> {
  applyEnvFile(); // load a project .env first (the dev launcher uses --env-file; the published binary has no such flag)
  if (!needsOnboarding()) return false;

  if (!process.stdin.isTTY) {
    const lines = [
      "No API key configured. Set one of these before running:",
      `  ${PROVIDERS.openrouter.keyVar}=...   (then PROVIDER=openrouter, optional)`,
      `  ${PROVIDERS.openai.keyVar}=...        (then PROVIDER=openai, optional)`,
      "Add it to .env (see .env.example), or export it in your shell.",
    ];
    process.stderr.write(lines.join("\n") + "\n");
    process.exit(1);
  }

  const app = render(createElement(Onboarding));
  await app.waitUntilExit(); // exit() is called once the .env is written (or on Ctrl-C), unblocking this

  // Surface the freshly written keys to this process (the app boots without restarting).
  applyEnvFile();
  return true;
}

// Load KEY=value pairs from the just-written .env into process.env so ./llm sees them this run
// (the original launch used --env-file, but that snapshot predates onboarding).
export function applyEnvFile(): void {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}
