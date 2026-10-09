/**
 * High-Concurrency HTTP & WebSocket Client for Lucent Load Testing
 */
import { WebSocket } from "ws";

export async function fetchJson(url, options = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return { status: res.status, headers: res.headers, data, ok: res.ok };
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

export function extractSessionCookie(headers) {
  const setCookie =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
  for (const raw of setCookie) {
    const match = raw.match(/lucent_session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

export async function pMap(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function waitFor(fn, timeout = 15000, every = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const res = await fn();
      if (res) return res;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

/**
 * Provision a test user on the Lucent instance
 */
export async function createTestUser(baseUrl, idx, runId, password = "LoadTestPass123!#") {
  const t0 = Date.now();
  const email = `LT_${runId}_U${String(idx).padStart(3, "0")}_${Math.floor(Math.random() * 10000)}@lucent.test`;
  const name = `LT-User-${idx}`;

  const csrf = await fetchJson(`${baseUrl}/api/auth/csrf`);
  const csrfToken = csrf.data?.token || "";

  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ email, password, name }),
  });

  if (res.status !== 201) {
    const errBody = await res.text();
    console.error(`[SIGNUP FAILURE] Status: ${res.status}, Body: ${errBody}`);
    throw new Error(`Failed to create account ${email}: status ${res.status} (${errBody})`);
  }

  const sessionCookie = extractSessionCookie(res.headers);
  const data = await res.json();

  return {
    idx,
    id: data.user?.id || data.id,
    email,
    name,
    token: data.token,
    sessionCookie,
    csrfToken,
    durationMs: Date.now() - t0,
  };
}

/**
 * Board lifecycle operations
 */
export async function createBoard(baseUrl, token, name, initialWorkspace = null) {
  const t0 = Date.now();
  const workspace = initialWorkspace || {
    id: `ws_${Date.now()}`,
    name,
    diagramKind: "flowchart",
    nodes: {},
    edges: {},
    groups: {},
    shapes: {},
    wireframes: {},
  };

  const res = await fetchJson(`${baseUrl}/api/boards`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name, workspace }),
  });

  const boardId = res.data?.board?.id || res.data?.id;
  return { boardId, durationMs: Date.now() - t0, ok: res.ok, status: res.status, data: res.data };
}

export async function shareBoard(baseUrl, token, boardId, role = "editor") {
  const t0 = Date.now();
  const res = await fetchJson(`${baseUrl}/api/boards/${boardId}/share`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ role }),
  });
  return { token: res.data?.token, durationMs: Date.now() - t0, ok: res.ok, status: res.status };
}

export async function joinBoard(baseUrl, token, boardId, inviteToken, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t0 = Date.now();
    const res = await fetchJson(`${baseUrl}/api/boards/${boardId}/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ token: inviteToken }),
    });
    if (res.ok) {
      return { durationMs: Date.now() - t0, ok: true, status: res.status };
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } else {
      throw new Error(
        `Failed to join board ${boardId}: status ${res.status} (${JSON.stringify(res.data)})`,
      );
    }
  }
}

export async function getBoard(baseUrl, token, boardId) {
  const t0 = Date.now();
  const res = await fetchJson(`${baseUrl}/api/boards/${boardId}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  return {
    board: res.data?.board || res.data,
    workspace: res.data?.board?.workspace || res.data?.workspace,
    durationMs: Date.now() - t0,
    ok: res.ok,
    status: res.status,
  };
}

export async function getBoardMembers(baseUrl, token, boardId) {
  const res = await fetchJson(`${baseUrl}/api/boards/${boardId}/members`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.data?.members || [];
}

export async function updateMemberRole(baseUrl, token, boardId, targetUserId, newRole) {
  const res = await fetchJson(`${baseUrl}/api/boards/${boardId}/members/${targetUserId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ role: newRole }),
  });
  return { ok: res.ok, status: res.status, data: res.data };
}

export async function postBoardOps(
  baseUrl,
  token,
  boardId,
  ops,
  label = "REST Batch",
  requestId = null,
) {
  const t0 = Date.now();
  const res = await fetchJson(`${baseUrl}/api/boards/${boardId}/ops`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      label,
      ops,
      ...(requestId ? { requestId } : {}),
    }),
  });
  return {
    seq: res.data?.seq,
    durationMs: Date.now() - t0,
    ok: res.ok,
    status: res.status,
    data: res.data,
  };
}

export async function listBoards(baseUrl, token, orgId = "") {
  const t0 = Date.now();
  const url = orgId
    ? `${baseUrl}/api/boards?orgId=${encodeURIComponent(orgId)}`
    : `${baseUrl}/api/boards`;
  const res = await fetchJson(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  return {
    durationMs: Date.now() - t0,
    ok: res.ok,
    status: res.status,
    boards: res.data?.boards || res.data || [],
  };
}

export async function exportBoard(baseUrl, token, boardId, format = "json", csrfToken = "") {
  const t0 = Date.now();
  const res = await fetchJson(`${baseUrl}/api/boards/${boardId}/export`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    },
    body: JSON.stringify({ format }),
  });
  return { durationMs: Date.now() - t0, ok: res.ok, status: res.status, data: res.data };
}

export async function uploadAsset(
  baseUrl,
  token,
  boardId,
  bytes,
  mime = "image/png",
  csrfToken = "",
) {
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/api/assets`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-lucent-asset-mime": mime,
      "x-lucent-board-id": boardId,
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    },
    body: bytes,
  });
  const data = await res.json().catch(() => null);
  return { durationMs: Date.now() - t0, ok: res.ok, status: res.status, data };
}

export async function deleteBoard(baseUrl, token, boardId) {
  const res = await fetchJson(`${baseUrl}/api/boards/${boardId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  return res.ok;
}

/**
 * WebSocket Realtime Client for Lucent Room protocol
 */
export class RealtimeClient {
  constructor({ baseUrl, token, boardId, user, metrics = null }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.boardId = boardId;
    this.user = user;
    this.metrics = metrics;

    this.ws = null;
    this.connected = false;
    this.joined = false;
    this.version = 0;
    this.role = null;
    this.peers = new Map();

    this.receivedOps = new Map(); // seq -> { entry, arrivalTimestamp }
    this.pendingAcks = new Map(); // requestId -> { resolve, reject, tStart }
    this.listeners = new Set();
  }

  async connect(fromSeq = 0, timeoutMs = 12000) {
    const t0 = Date.now();

    // 1. Mint ticket
    const ticketRes = await fetchJson(`${this.baseUrl}/api/realtime/ticket`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
    });

    const ticket = ticketRes.data?.ticket;
    if (!ticket) {
      throw new Error(`Failed to mint realtime ticket: status ${ticketRes.status}`);
    }

    const wsProto = this.baseUrl.startsWith("https") ? "wss:" : "ws:";
    const wsHost = new URL(this.baseUrl).host;
    const wsUrl = `${wsProto}//${wsHost}/ws?ticket=${encodeURIComponent(ticket)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WebSocket connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err) {
        clearTimeout(timer);
        return reject(err);
      }

      this.ws.onopen = () => {
        this.connected = true;
        // Send join frame
        this.ws.send(JSON.stringify({ type: "join", boardId: this.boardId, fromSeq }));
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          this._handleMessage(msg, resolve, timer, t0);
        } catch {
          // ignore malformed frame
        }
      };

      this.ws.onerror = (err) => {
        clearTimeout(timer);
        if (this.metrics) this.metrics.recordError(`WS-client-${this.user.id}`, err);
        reject(err);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.joined = false;
      };
    });
  }

  _handleMessage(msg, connectResolve, timer, t0) {
    const now = Date.now();

    if (msg.type === "welcome" || msg.type === "resync") {
      this.joined = true;
      this.version = msg.version || 0;
      this.role = msg.role;
      this.workerId = msg.workerId || null;
      if (Array.isArray(msg.peers)) {
        for (const p of msg.peers) this.peers.set(p.userId, p);
      }
      clearTimeout(timer);
      if (this.metrics) this.metrics.recordTiming("ws_connect_and_join", now - t0);
      connectResolve(this);
    } else if (msg.type === "op" && msg.entry) {
      const seq = msg.entry.seq;
      this.version = Math.max(this.version, seq);
      this.receivedOps.set(seq, { entry: msg.entry, arrival: now });

      const entryReqId = msg.entry.requestId;
      if (entryReqId && this.pendingAcks.has(entryReqId)) {
        const pending = this.pendingAcks.get(entryReqId);
        this.pendingAcks.delete(entryReqId);
        const duration = now - pending.tStart;
        if (this.metrics) this.metrics.recordTiming("ws_op_ack", duration);
        pending.resolve({ seq: msg.entry.seq, operationId: msg.entry.operationId, duration });
      } else if (this.metrics && typeof msg.entry.at === "number") {
        this.metrics.recordTiming("ws_fanout_transit", Math.max(0, now - msg.entry.at));
      }

      for (const listener of this.listeners) {
        try {
          listener(msg.entry);
        } catch {}
      }
    } else if (msg.type === "op-ack") {
      const reqId = msg.requestId;
      if (reqId && this.pendingAcks.has(reqId)) {
        const pending = this.pendingAcks.get(reqId);
        this.pendingAcks.delete(reqId);
        const duration = now - pending.tStart;
        if (this.metrics) this.metrics.recordTiming("ws_op_ack", duration);
        pending.resolve({ seq: msg.seq, operationId: msg.operationId, duration });
      } else if (!reqId && this.pendingAcks.size === 1) {
        const [onlyReqId, pending] = this.pendingAcks.entries().next().value;
        this.pendingAcks.delete(onlyReqId);
        const duration = now - pending.tStart;
        if (this.metrics) this.metrics.recordTiming("ws_op_ack", duration);
        pending.resolve({ seq: msg.seq, operationId: msg.operationId, duration });
      }
    } else if (msg.type === "op-rejected") {
      console.error(`[WS OP-REJECTED on ${this.user.name || this.user.id}]`, msg);
      const reqId = msg.requestId;
      if (reqId && this.pendingAcks.has(reqId)) {
        const pending = this.pendingAcks.get(reqId);
        this.pendingAcks.delete(reqId);
        pending.reject(new Error(`Op rejected: ${msg.error} (${msg.detail || ""})`));
      } else if (this.pendingAcks.size > 0) {
        for (const [pReqId, pending] of this.pendingAcks.entries()) {
          this.pendingAcks.delete(pReqId);
          pending.reject(new Error(`Op rejected: ${msg.error} (${msg.detail || ""})`));
        }
      }
    } else if (msg.type === "peer-joined" && msg.presence) {
      this.peers.set(msg.presence.userId, msg.presence);
    } else if (msg.type === "peer-left" && msg.userId) {
      this.peers.delete(msg.userId);
    }
  }

  async sendOp(label, ops, requestId = null, timeoutMs = 35000, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._doSendOp(label, ops, requestId, timeoutMs);
      } catch (err) {
        if (attempt < maxRetries && err.message.includes("editor role required")) {
          // Re-send join frame to refresh role cache on cluster worker, then retry
          if (this.ws && this.connected) {
            this.ws.send(
              JSON.stringify({ type: "join", boardId: this.boardId, fromSeq: this.version }),
            );
          }
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        if (
          attempt < maxRetries &&
          (err.message.includes("stale") || err.message.includes("conflict"))
        ) {
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  async _doSendOp(label, ops, requestId = null, timeoutMs = 35000) {
    if (!this.connected || !this.ws) {
      throw new Error("Cannot send op: WebSocket is not connected");
    }

    const reqId = requestId || `req_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const tStart = Date.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(reqId);
        reject(new Error(`Timeout waiting for op-ack (requestId: ${reqId})`));
      }, timeoutMs);

      this.pendingAcks.set(reqId, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        tStart,
      });

      this.ws.send(
        JSON.stringify({
          type: "op",
          requestId: reqId,
          label,
          ops,
        }),
      );
    });
  }

  sendPresence(cursor = null, selection = []) {
    if (!this.connected || !this.ws) return;
    this.ws.send(JSON.stringify({ type: "presence", cursor, selection }));
  }

  sendPing() {
    if (!this.connected || !this.ws) return;
    this.ws.send(JSON.stringify({ type: "ping" }));
  }

  onOp(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.joined = false;
  }
}
