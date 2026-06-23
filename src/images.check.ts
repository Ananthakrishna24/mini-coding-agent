import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { attachImages, clipboardImageToTemp } from "./images";

const plain = attachImages("just fix the bug in app.tsx please");
assert.equal(plain.content, "just fix the bug in app.tsx please");
assert.equal(plain.attached.length, 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-check-"));
const img = path.join(dir, "shot.png");
fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

const r = attachImages(`look at ${img} whats wrong`);
assert.ok(Array.isArray(r.content), "content should be a multimodal array when an image is present");
const content = r.content as any[];
assert.equal(content[0].type, "text");
assert.equal(content[0].text, `look at ${img} whats wrong`);
assert.equal(content[1].type, "image_url");
assert.match(content[1].image_url.url, /^data:image\/png;base64,iVBO/);
assert.equal(r.attached.length, 1);

const dup = attachImages(`${img} and again ${img}`);
assert.equal((dup.content as any[]).filter((p) => p.type === "image_url").length, 1);

const missing = attachImages("see ./does-not-exist.png");
assert.equal(missing.content, "see ./does-not-exist.png");

fs.rmSync(dir, { recursive: true, force: true });

const clip = await clipboardImageToTemp();
assert.ok(clip === null || typeof clip === "string", "clipboard read resolves to null or a path, never throws");

console.log("ok — images self-check passed");
