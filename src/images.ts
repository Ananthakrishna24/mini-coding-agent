import fs from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import type OpenAI from "openai";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const PATH_RE = /"([^"]+?\.(?:png|jpe?g|gif|webp))"|'([^']+?\.(?:png|jpe?g|gif|webp))'|((?:\\ |\S)+?\.(?:png|jpe?g|gif|webp))/gi;

function resolveCandidate(raw: string): string {
  let p = raw.replace(/\\ /g, " ");
  if (p === "~" || p.startsWith("~/")) p = path.join(homedir(), p.slice(1));
  return path.resolve(process.cwd(), p);
}

export type Attached = {
  content: string | OpenAI.ChatCompletionContentPart[];
  attached: string[];
  skipped: string[];
};

export function attachImages(text: string): Attached {
  const parts: OpenAI.ChatCompletionContentPart[] = [];
  const attached: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(PATH_RE)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw) continue;
    const abs = resolveCandidate(raw);
    if (seen.has(abs)) continue;
    seen.add(abs);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const mime = MIME[path.extname(abs).toLowerCase()];
    if (!mime) continue;
    if (stat.size > MAX_IMAGE_BYTES) {
      skipped.push(raw);
      continue;
    }

    const b64 = fs.readFileSync(abs).toString("base64");
    parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } });
    attached.push(raw);
  }

  if (parts.length === 0) return { content: text, attached, skipped };
  return { content: [{ type: "text", text }, ...parts], attached, skipped };
}

function capture(cmd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer: MAX_IMAGE_BYTES, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const buf = stdout as unknown as Buffer;
      resolve(buf && buf.length ? buf : null);
    });
  });
}

function execOk(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 8000 }, (err) => resolve(!err)));
}

async function linuxClip(): Promise<Buffer | null> {
  if (process.env.WAYLAND_DISPLAY) {
    const b = await capture("wl-paste", ["--type", "image/png"]);
    if (b) return b;
  }
  return capture("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
}

async function fileClip(cmd: string, args: (file: string) => string[]): Promise<Buffer | null> {
  const tmp = path.join(tmpdir(), `minicode-clip-${Date.now()}.png`);
  if (!(await execOk(cmd, args(tmp)))) return null;
  try {
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

async function macClip(): Promise<Buffer | null> {
  const b = await capture("pngpaste", ["-"]);
  if (b) return b;
  return fileClip("osascript", (f) => [
    "-e", "try",
    "-e", `set fh to open for access POSIX file ${JSON.stringify(f)} with write permission`,
    "-e", "write (the clipboard as «class PNGf») to fh",
    "-e", "close access fh",
    "-e", "end try",
  ]);
}

async function winClip(): Promise<Buffer | null> {
  return fileClip("powershell", (f) => [
    "-NoProfile", "-Command",
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Windows.Forms.Clipboard]::GetImage(); if($i){$i.Save(${JSON.stringify(f)},[System.Drawing.Imaging.ImageFormat]::Png)}`,
  ]);
}

export async function clipboardImageToTemp(): Promise<string | null> {
  let buf: Buffer | null = null;
  if (process.platform === "linux") buf = await linuxClip();
  else if (process.platform === "darwin") buf = await macClip();
  else if (process.platform === "win32") buf = await winClip();
  if (!buf || !buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  const file = path.join(tmpdir(), `minicode-paste-${Date.now()}.png`);
  fs.writeFileSync(file, buf);
  return file;
}
