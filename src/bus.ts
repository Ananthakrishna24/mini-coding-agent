// In-process coordination for /minions mode: a mailbox-per-agent message bus and a file-claim
// registry. Everything runs on one Node event loop, so "concurrent" agents are really cooperative:
// an agent parked in `recv` yields control until someone `send`s to it, letting its siblings run.
// Pure leaf — no agent/coordinator imports, so the import graph stays acyclic (same rule as
// spawn_agent.ts). The coordinator (minions.ts) owns one Bus and wires it to the agent loop.

export type Msg = { from: string; text: string };

export class Bus {
  private mailboxes = new Map<string, Msg[]>(); // agentId -> queued messages waiting to be received
  private waiters = new Map<string, { resolve: (m: Msg | null) => void; timer: ReturnType<typeof setTimeout> }>();
  private claims = new Map<string, string>(); // file path -> the agent id that holds it

  // Deliver a message. If the target is parked in `recv`, hand it over immediately and wake it;
  // otherwise queue it so the next `recv` drains it. A message is never lost to timing.
  send(to: string, from: string, text: string): void {
    const w = this.waiters.get(to);
    if (w) {
      this.waiters.delete(to);
      clearTimeout(w.timer);
      w.resolve({ from, text });
      return;
    }
    const box = this.mailboxes.get(to) ?? [];
    box.push({ from, text });
    this.mailboxes.set(to, box);
  }

  // Block until a message arrives or `timeoutMs` elapses (null on timeout, so a stuck agent re-plans
  // instead of hanging forever). The returned promise's await is the yield point that lets siblings run.
  // ponytail: one waiter per agent — the loop processes an agent's tool calls serially, so an agent
  // only ever awaits one wait_message at a time. Two concurrent recvs for one id would drop the first;
  // not reachable from the single-threaded loop. Upgrade to a waiter queue if that ever changes.
  recv(agentId: string, timeoutMs: number): Promise<Msg | null> {
    const box = this.mailboxes.get(agentId);
    if (box && box.length) return Promise.resolve(box.shift()!);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(agentId);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(agentId, { resolve, timer });
    });
  }

  // Claim a file before writing it. "ok" if free (or already yours); otherwise the holder's id so the
  // caller coordinates instead of clobbering. This is the merge-conflict guard for v1.
  claim(path: string, agentId: string): "ok" | string {
    const holder = this.claims.get(path);
    if (holder && holder !== agentId) return `held by ${holder}`;
    this.claims.set(path, agentId);
    return "ok";
  }
  release(path: string, agentId: string): "ok" | string {
    if (this.claims.get(path) === agentId) {
      this.claims.delete(path);
      return "ok";
    }
    return `not held by ${agentId}`;
  }
  // Free everything an agent held — called when it exits so a crashed agent never strands a claim.
  releaseAll(agentId: string): void {
    for (const [p, h] of this.claims) if (h === agentId) this.claims.delete(p);
  }
}
