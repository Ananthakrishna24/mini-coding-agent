import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

let PROMPT_PACK = "";
try {
  PROMPT_PACK = ((await import("./prompts/debug.md")) as { default: string }).default.trim();
} catch {
  try {
    PROMPT_PACK = readFileSync(new URL("./prompts/debug.md", import.meta.url), "utf8").trim();
  } catch {
    PROMPT_PACK = "";
  }
}

let active = false;
let server: http.Server | null = null;
let endpoint = "";
let logPath = "";

export function isDebugMode(): boolean {
  return active;
}

export async function enableDebugMode(): Promise<{ endpoint: string; logPath: string }> {
  if (active) return { endpoint, logPath };
  logPath = path.join(process.cwd(), ".mini-agent", `debug-${Date.now().toString(36)}.log`);
  mkdirSync(path.dirname(logPath), { recursive: true });
  const srv = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/ingest") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          appendFileSync(logPath, JSON.stringify(parsed) + "\n");
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end("invalid json");
        }
      });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address() as AddressInfo;
  server = srv;
  endpoint = `http://127.0.0.1:${port}/ingest`;
  active = true;
  return { endpoint, logPath };
}

export async function disableDebugMode(): Promise<void> {
  if (!active || !server) return;
  const srv = server;
  await new Promise<void>((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
  server = null;
  active = false;
  endpoint = "";
  logPath = "";
}

export function debugPromptBlock(): string {
  if (!active) return "";
  if (!PROMPT_PACK) {
    try {
      PROMPT_PACK = readFileSync(new URL("./prompts/debug.md", import.meta.url), "utf8").trim();
    } catch {}
  }
  const relLog = path.relative(process.cwd(), logPath);
  const body = PROMPT_PACK.replaceAll("{{ENDPOINT}}", endpoint).replaceAll("{{LOG_PATH}}", relLog);
  return `<debug-mode>\n${body}\n</debug-mode>`;
}
