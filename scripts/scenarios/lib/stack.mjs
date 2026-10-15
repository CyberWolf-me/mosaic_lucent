/**
 * The isolated stack a scenario run talks to — never the developer's own
 * servers, never production:
 *
 *   - a throwaway Postgres 16 in Docker (its own port, removed afterwards), so
 *     persistence is real but nothing lands in the hosted database;
 *   - the API (`packages/server/dist/main.js`) on its own port, with the real
 *     AI / LiveKit / Deepgram settings from packages/server/.env, telemetry
 *     off, raised rate limits, and a voice-agent name unique to this run so a
 *     dispatch can never reach a worker serving real users;
 *   - Vite on its own port, proxying /api and /ws to that API;
 *   - optionally the voice-agent worker, registered under the same unique name
 *     and calling back to this API only.
 *
 * Every child's output goes to a log file in the run's artifact directory.
 */
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export const REPO = path.resolve(import.meta.dirname, "..", "..", "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(500);
  }
  throw new Error(`${label} did not come up at ${url} within ${timeoutMs}ms (${last})`);
}

/** Kill a process and everything it spawned (Windows needs the tree kill). */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

function launch(name, command, args, { cwd, env, logDir }) {
  const logPath = path.join(logDir, `${name}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.logPath = logPath;
  child.on("exit", (code) => log.write(`\n[stack] ${name} exited with ${code}\n`));
  return child;
}

export class Stack {
  constructor({ runId, artifactDir, ports, voiceAgent, mockAi = false }) {
    this.mockAi = mockAi;
    this.runId = runId;
    this.artifactDir = artifactDir;
    this.ports = ports; // { pg, api, web }
    this.voiceAgentWanted = voiceAgent;
    this.container = `lucent-scenarios-pg-${runId}`;
    this.agentName = `lucent-scenarios-${runId}`;
    this.apiUrl = `http://127.0.0.1:${ports.api}`;
    this.webUrl = `http://127.0.0.1:${ports.web}`;
    this.dbUrl = `postgres://postgres:scenarios@127.0.0.1:${ports.pg}/lucent`;
    this.children = [];
  }

  assertBuilt() {
    const dist = path.join(REPO, "packages", "server", "dist", "main.js");
    if (!existsSync(dist)) {
      throw new Error("packages/server/dist is missing — run `npm run build -w @lucent/server` first");
    }
    for (const pkg of ["server", "core", "ai"]) {
      const src = path.join(REPO, "packages", pkg, "src");
      const out = path.join(REPO, "packages", pkg, "dist");
      const srcAt = newestMtimeSync(src);
      const outAt = newestMtimeSync(out);
      if (srcAt > outAt + 1000) {
        throw new Error(
          `packages/${pkg}/dist is older than its src — rebuild (npm run build -w @lucent/server builds core, ai and server)`,
        );
      }
    }
  }

  async startPostgres() {
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        this.container,
        "-e",
        "POSTGRES_PASSWORD=scenarios",
        "-e",
        "POSTGRES_DB=lucent",
        "-p",
        `127.0.0.1:${this.ports.pg}:5432`,
        "postgres:16",
        // Enough connections for every pool the API opens under 24 users.
        "-c",
        "max_connections=200",
      ],
      { stdio: "ignore" },
    );
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      try {
        // Over TCP: during first-boot init the image runs a temporary server on
        // the unix socket only, then restarts — pg_isready on the socket
        // answers too early and the API's migration hits the restart.
        execFileSync(
          "docker",
          ["exec", this.container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "lucent", "-tAc", "select 1"],
          { stdio: "ignore", env: { ...process.env } },
        );
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error("Postgres container did not become ready");
  }

  /** Run SQL inside the throwaway database (test setup only). */
  sql(statement) {
    return execFileSync(
      "docker",
      ["exec", "-i", this.container, "psql", "-U", "postgres", "-d", "lucent", "-tAc", statement],
      { encoding: "utf8" },
    ).trim();
  }

  serverEnv() {
    return {
      ...process.env,
      LUCENT_PORT: String(this.ports.api),
      LUCENT_DATABASE_URL: this.dbUrl,
      LUCENT_REQUIRE_AUTH: "1",
      LUCENT_WEB_ORIGIN: this.webUrl,
      LUCENT_WEB_ORIGINS: `http://localhost:${this.ports.web}`,
      LUCENT_SESSION_SECRET: `scenarios-${this.runId}-session-secret`,
      // 24 people on one machine: lift the per-user meters, keep them on.
      LUCENT_RATE_PER_MINUTE: "600",
      LUCENT_QUOTA_PER_DAY: "20000",
      LUCENT_AUTH_LIMIT_PER_WINDOW: "200",
      LUCENT_VOICE_AGENT_NAME: this.agentName,
      // No product analytics or billing from a test run.
      LUCENT_POSTHOG_KEY: "",
      POSTHOG_PROJECT_TOKEN: "",
      LUCENT_STRIPE_SECRET_KEY: "",
      LUCENT_STRIPE_WEBHOOK_SECRET: "",
      LUCENT_TURNSTILE_SECRET_KEY: "",
      // --mock-ai: the deterministic offline provider, for iterating on a scenario for free.
      ...(this.mockAi ? { LUCENT_AI_PROVIDER: "mock", LUCENT_AI_KEY: "", LUCENT_IMAGE_KEY: "dummy", LUCENT_IMAGE_BASE_URL: "" } : {}),
    };
  }

  async startApi() {
    const child = launch("api", process.execPath, ["dist/main.js"], {
      cwd: path.join(REPO, "packages", "server"),
      env: this.serverEnv(),
      logDir: this.artifactDir,
    });
    this.children.push(child);
    this.api = child;
    await waitForHttp(`${this.apiUrl}/health`, 90_000, "API");
  }

  async startWeb() {
    const vite = path.join(REPO, "packages", "web", "node_modules", "vite", "bin", "vite.js");
    const child = launch(
      "web",
      process.execPath,
      [vite, "--port", String(this.ports.web), "--host", "127.0.0.1", "--strictPort"],
      {
        cwd: path.join(REPO, "packages", "web"),
        env: {
          ...process.env,
          LUCENT_API_PORT: String(this.ports.api),
          LUCENT_WEB_PORT: String(this.ports.web),
          LUCENT_POSTHOG_KEY: "",
          POSTHOG_PROJECT_TOKEN: "",
        },
        logDir: this.artifactDir,
      },
    );
    this.children.push(child);
    await waitForHttp(this.webUrl, 90_000, "Vite");
  }

  async startVoiceAgent() {
    const tsx = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
    const child = launch(
      "voice-agent",
      process.execPath,
      [tsx, "--conditions=development", "src/main.ts", "start"],
      {
        cwd: path.join(REPO, "packages", "voice-agent"),
        env: {
          ...process.env,
          LUCENT_SERVER_URL: this.apiUrl,
          LUCENT_VOICE_AGENT_NAME: this.agentName,
        },
        logDir: this.artifactDir,
      },
    );
    this.children.push(child);
    this.voiceAgent = child;
    // The worker logs once it has registered with LiveKit.
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      const log = existsSync(child.logPath) ? readFileSync(child.logPath, "utf8") : "";
      if (/registered worker|worker registered|"msg":"registered/i.test(log)) return true;
      if (child.exitCode !== null) throw new Error(`voice agent exited (${child.exitCode}); see ${child.logPath}`);
      await sleep(1000);
    }
    throw new Error(`voice agent did not register within 120s; see ${child.logPath}`);
  }

  apiLog() {
    return existsSync(this.api?.logPath ?? "") ? readFileSync(this.api.logPath, "utf8") : "";
  }

  /** Refuse to start on a port something else (another project, a dev server) holds. */
  async assertPortsFree() {
    for (const [name, port] of Object.entries(this.ports)) {
      const free = await new Promise((resolve) => {
        const srv = net.createServer();
        srv.once("error", () => resolve(false));
        srv.once("listening", () => srv.close(() => resolve(true)));
        srv.listen(port, "0.0.0.0");
      });
      if (!free) throw new Error(`port ${port} (${name}) is in use — pass --${name}Port=<free port>`);
    }
  }

  async up() {
    this.assertBuilt();
    await this.assertPortsFree();
    await this.startPostgres();
    await this.startApi();
    await this.startWeb();
    if (this.voiceAgentWanted) await this.startVoiceAgent();
  }

  async down({ keepDb = false } = {}) {
    for (const child of this.children.reverse()) killTree(child);
    if (!keepDb) {
      try {
        execFileSync("docker", ["rm", "-f", this.container], { stdio: "ignore" });
      } catch {
        /* gone */
      }
    }
  }
}

/** Newest source mtime under a directory, for the stale-build check. */
function newestMtimeSync(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        newest = Math.max(newest, statSync(p).mtimeMs);
      }
    }
  };
  walk(dir);
  return newest;
}
