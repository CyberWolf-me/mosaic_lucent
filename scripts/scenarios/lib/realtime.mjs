/**
 * A scenario user's realtime connection, speaking the board room protocol
 * (packages/server/src/realtime.ts). Unlike the load harness's client it keeps
 * everything a convergence check needs: the welcome point, every logged entry
 * by seq, rejections attributed to their requestId, presence, spotlight,
 * summon, proposal frames, and eviction errors.
 */

export class Rejected extends Error {
  constructor(frame) {
    super(`op-rejected ${frame.error}: ${frame.detail ?? ""}`);
    this.error = frame.error;
    this.detail = frame.detail;
    this.head = frame.head;
  }
}

let reqCounter = 0;
export const newRequestId = (tag = "sc") =>
  `${tag}_${Date.now().toString(36)}_${(reqCounter++).toString(36)}`;

export class LiveClient {
  constructor(person, baseUrl, boardId, { record } = {}) {
    this.person = person;
    this.baseUrl = baseUrl;
    this.boardId = boardId;
    this.record = record ?? (() => {});
    this.entries = new Map(); // seq -> entry
    this.pending = new Map(); // requestId -> {resolve, reject, t0, timer}
    this.peers = new Map();
    this.events = []; // non-op frames, in arrival order
    this.waiters = new Set();
    this.joins = []; // {at, fromSeq, version, kind}
    this.role = null;
    this.version = 0;
    this.ws = null;
    this.open = false;
  }

  /** Highest seq such that every seq from the first join point up to it has arrived. */
  contiguousHead() {
    let seq = this.joins[0]?.version ?? 0;
    while (this.entries.has(seq + 1)) seq++;
    return seq;
  }

  async connect(fromSeq = 0, timeoutMs = 20_000) {
    const t0 = performance.now();
    const ticket = await this.person.post("/api/realtime/ticket", {});
    const url = `${this.baseUrl.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket.ticket)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${this.person.name}: join timed out`));
        try {
          ws.close();
        } catch {}
      }, timeoutMs);
      ws.onopen = () => {
        this.open = true;
        ws.send(JSON.stringify({ type: "join", boardId: this.boardId, fromSeq }));
      };
      ws.onerror = (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${this.person.name}: socket error ${err?.message ?? ""}`));
        }
      };
      ws.onclose = (ev) => {
        this.open = false;
        this.events.push({ type: "closed", code: ev.code, at: Date.now() });
        for (const [, p] of this.pending) p.reject(new Error("socket closed"));
        this.pending.clear();
        this.notify();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`${this.person.name}: socket closed before welcome (${ev.code})`));
        }
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "welcome" || msg.type === "resync") {
          this.role = msg.role;
          this.version = msg.version ?? 0;
          this.joins.push({
            at: Date.now(),
            fromSeq,
            version: msg.version ?? 0,
            kind: msg.type,
            catchup: (msg.catchup ?? []).length,
            workspace: msg.type === "resync" ? msg.workspace : undefined,
          });
          for (const e of msg.catchup ?? []) this.entries.set(e.seq, e);
          for (const p of msg.peers ?? []) this.peers.set(p.userId, p);
          this.record("ws_join_ms", performance.now() - t0);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(msg);
          }
        } else if (msg.type === "error" && !settled) {
          settled = true;
          clearTimeout(timer);
          this.events.push({ ...msg, at: Date.now() });
          reject(new Error(`${this.person.name}: join refused — ${msg.message}`));
          return;
        }
        this.handle(msg);
      };
    });
  }

  handle(msg) {
    const now = Date.now();
    switch (msg.type) {
      case "welcome":
      case "resync":
        break;
      case "op": {
        const e = msg.entry;
        this.entries.set(e.seq, e);
        this.version = Math.max(this.version, e.seq);
        if (typeof e.at === "number") this.record("ws_fanout_ms", Math.max(0, now - e.at));
        break;
      }
      case "op-ack": {
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          clearTimeout(p.timer);
          const ms = performance.now() - p.t0;
          this.record("ws_ack_ms", ms);
          p.resolve({ seq: msg.seq, operationId: msg.operationId, duplicate: !!msg.duplicate, ms });
        }
        break;
      }
      case "op-rejected": {
        const p = this.pending.get(msg.requestId);
        this.events.push({ ...msg, at: now });
        if (p) {
          this.pending.delete(msg.requestId);
          clearTimeout(p.timer);
          p.reject(new Rejected(msg));
        }
        break;
      }
      case "peer-joined":
      case "presence":
        if (msg.presence) this.peers.set(msg.presence.userId, msg.presence);
        this.events.push({ type: msg.type, userId: msg.presence?.userId, at: now });
        break;
      case "peer-left":
        this.peers.delete(msg.userId);
        this.events.push({ type: msg.type, userId: msg.userId, at: now });
        break;
      default:
        // spotlight, summon, proposal-created, proposal-decided, error, pong, integrations-inbound
        this.events.push({ ...msg, at: now });
    }
    this.notify();
  }

  notify() {
    for (const w of [...this.waiters]) {
      if (w.test()) {
        this.waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve();
      }
    }
  }

  /** Resolve when `test()` holds (re-checked on every frame). */
  until(test, timeoutMs = 30_000, label = "condition") {
    if (test()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      w.timer = setTimeout(() => {
        this.waiters.delete(w);
        reject(new Error(`${this.person.name}: timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.add(w);
    });
  }

  waitForSeq(seq, timeoutMs) {
    return this.until(() => this.contiguousHead() >= seq, timeoutMs, `seq ${seq}`);
  }

  waitForEvent(type, pred = () => true, timeoutMs = 30_000) {
    const found = () => this.events.find((e) => e.type === type && pred(e));
    return this.until(() => !!found(), timeoutMs, `event ${type}`).then(found);
  }

  /** Send a batch; resolves on op-ack, rejects with `Rejected` on op-rejected. */
  send(ops, { label = "scenario", requestId = newRequestId(), timeoutMs = 60_000, runId } = {}) {
    if (!this.open) return Promise.reject(new Error(`${this.person.name}: not connected`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${this.person.name}: no ack for ${requestId} in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, t0: performance.now(), timer });
      this.ws.send(JSON.stringify({ type: "op", ops, label, requestId, ...(runId ? { runId } : {}) }));
    }).then((ack) => ({ ...ack, requestId }));
  }

  presence(cursor, selection = [], viewport) {
    if (this.open)
      this.ws.send(JSON.stringify({ type: "presence", cursor, selection, ...(viewport ? { viewport } : {}) }));
  }
  spotlight(on) {
    if (this.open) this.ws.send(JSON.stringify({ type: "spotlight", on }));
  }
  summon(viewport) {
    if (this.open) this.ws.send(JSON.stringify({ type: "summon", viewport }));
  }

  close() {
    try {
      this.ws?.close();
    } catch {}
    this.open = false;
  }
}

/** Stable JSON for deep comparison (sorted keys). */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
