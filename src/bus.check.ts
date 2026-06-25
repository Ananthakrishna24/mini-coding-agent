// Offline self-check for the /minions message bus — no model/network. Run: npm run check
// Covers the coordination primitives that the live team relies on: queued vs. parked delivery, the
// timeout escape (so a stuck agent can't hang forever), and the file-claim guard that prevents two
// agents writing the same file. Real concurrent agents need the model, so the full run is a manual check.
import assert from "node:assert/strict";
import { Bus } from "./bus";

// send-before-recv: messages queue and drain in order.
const bus = new Bus();
bus.send("a", "b", "hello");
bus.send("a", "b", "world");
assert.equal((await bus.recv("a", 50))?.text, "hello", "queued message 1 drains first");
assert.equal((await bus.recv("a", 50))?.text, "world", "queued message 2 drains next");

// recv-before-send: the receiver parks, then the send wakes it. This is the yield point that lets a
// waiting supervisor's siblings run.
const parked = bus.recv("a", 1000);
bus.send("a", "c", "late");
const got = await parked;
assert.equal(got?.from, "c", "parked recv learns the sender");
assert.equal(got?.text, "late", "parked recv resolved by the send");

// timeout returns null — the deadlock escape: a stuck agent re-plans instead of hanging.
assert.equal(await bus.recv("a", 20), null, "recv times out to null");

// file claims: a double-claim is rejected (naming the holder), the holder may re-claim, release frees it,
// and releaseAll frees everything an exiting agent held.
assert.equal(bus.claim("x.ts", "a"), "ok", "first claim succeeds");
assert.equal(bus.claim("x.ts", "b"), "held by a", "a second agent's claim is rejected, holder named");
assert.equal(bus.claim("x.ts", "a"), "ok", "the holder may re-claim its own file");
assert.equal(bus.release("x.ts", "a"), "ok", "release frees the claim");
assert.equal(bus.claim("x.ts", "b"), "ok", "a freed file can be claimed by another agent");
bus.releaseAll("b");
assert.equal(bus.claim("x.ts", "a"), "ok", "releaseAll frees an exiting agent's claims");

console.log("ok — bus self-check passed");
