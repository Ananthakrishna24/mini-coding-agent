// First-run setup. Shown when the app starts interactively with no usable provider key: pick a
// provider, paste the key (never echoed in full), accept or override the starting model, then write
// a 0600 .env. Lives apart from the main App so it can run before ./llm is imported (which throws on
// a missing key). No model/network here — just key capture and the .env write.
import { createElement, useState, type FC } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { c } from "./format";
import { PROVIDERS, resolveProvider, mergeEnv, type Provider } from "./provider";

// Where API keys are stored. The local .env (project dir) takes priority when it contains at least
// one provider key; otherwise we fall back to a global config dir (~/.config/minicode/.env) that
// survives `cd`-ing around when the package is installed globally.
const LOCAL_ENV = path.resolve(process.cwd(), ".env");
const GLOBAL_ENV = path.join(homedir(), ".config", "minicode", ".env");

// True when no provider key is configured anywhere (env or an existing .env that --env-file loaded).
export function needsOnboarding(): boolean {
  return "error" in resolveProvider();
}

// Mask a key for display: keep a short head + tail, hide the middle. Never render the whole thing.
const maskKey = (k: string) => (k.length <= 8 ? "•".repeat(k.length) : `${k.slice(0, 4)}…${k.slice(-2)}`);

// Write/merge the chosen settings into the global .env with owner-only perms. The global path
// (~/.config/minicode/.env) persists across directories — important when installed with npm -g.
// Keeps unrelated lines intact.
function writeEnv(updates: Record<string, string>): void {
  const dir = path.dirname(GLOBAL_ENV);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(GLOBAL_ENV) ? fs.readFileSync(GLOBAL_ENV, "utf8") : "";
  fs.writeFileSync(GLOBAL_ENV, mergeEnv(existing, updates), { mode: 0o600 });
  fs.chmodSync(GLOBAL_ENV, 0o600); // enforce perms even if the file already existed with looser ones
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

  const providers: Provider[] = ["openrouter", "openai", "mistral"];

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
          writeEnv({ [PROVIDERS[provider].keyVar]: key.trim(), AGENT_MODEL: chosen });
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
    createElement(Text, { key: "s", dimColor: true }, "Keys are saved to ~/.config/minicode/.env (owner-only) and never printed."),
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
    return [createElement(Text, { key: "d", color: "green" }, `✔ Saved ${PROVIDERS[provider].label} config to ~/.config/minicode/.env`)];
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
      `  ${PROVIDERS.mistral.keyVar}=...      (then PROVIDER=mistral, optional)`,
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

// Load KEY=value pairs from .env files into process.env so ./llm sees them this run. Loads the
// global config first (~/.config/minicode/.env), then the local project .env — local values win
// so a project can override the global default provider/model.
function loadEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

export function applyEnvFile(): void {
  loadEnv(GLOBAL_ENV);
  loadEnv(LOCAL_ENV);
}
