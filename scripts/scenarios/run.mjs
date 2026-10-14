#!/usr/bin/env node
/**
 * Team-session scenarios: 24 people on one Lucent board, at the same time
 * and one by one, across every mode — canvas editing, AI Build and Ask,
 * lenses, comments and votes, a meeting transcribed inside a real LiveKit
 * call, the voice agent, permission changes and reconnects.
 *
 *   node scripts/scenarios/run.mjs                 # every phase
 *   node scripts/scenarios/run.mjs --phases=setup  # just the stack and the team
 *   node scripts/scenarios/run.mjs --keep          # leave the stack up afterwards
 *   node scripts/scenarios/run.mjs --no-voice-agent --headed
 *
 * It starts its own isolated stack (lib/stack.mjs): a throwaway Postgres in
 * Docker, the API and Vite on their own ports. It uses the REAL AI provider,
 * LiveKit and Deepgram configured in packages/server/.env — so it spends
 * credits — with a voice-agent name unique to the run. Needs Docker and a
 * built server (`npm run build -w @lucent/server`).
 *
 * Output: .load-artifacts/scenarios/<runId>/ — report.md, results.json,
 * screenshots, and the stack's logs.
 */
import path from "node:path";
import { Stack, REPO } from "./lib/stack.mjs";
import { Report } from "./lib/report.mjs";
import { World } from "./lib/world.mjs";
import { dumpErrors } from "./lib/browser.mjs";
import { kickoff, relay, contention } from "./phases/canvas.mjs";
import { modes } from "./phases/modes.mjs";
import { meeting } from "./phases/meeting.mjs";
import { voice } from "./phases/voice.mjs";
import { churn } from "./phases/churn.mjs";
import { undo } from "./phases/undo.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const PHASES = [
  ["kickoff", "Everyone at once: 23 people edit while the owner's real AI build lands", kickoff],
  ["relay", "One by one: a baton through 17 editors, each building on what they saw", relay],
  ["contention", "Same object, same instant: renames, drags, delete vs. edit, retries, REST writers", contention],
  ["modes", "Every mode in real browsers: lenses, Kanban, Focus/Present/Zen, comments, votes, spotlight, undo, Ask, slash, node AI", modes],
  ["undo", "Ctrl+Z / Ctrl+Y in a real browser on a board others keep editing", undo],
  ["meeting", "Half the team in a real LiveKit meeting (transcribed, extracted, summarized) while the other half builds", meeting],
  ["voice", "Voice: the duplex voice agent edits the board; talking with Lucent on the canvas", voice],
  ["churn", "Demotion, removal, drop-offs and catch-up, trash and restore, history — then final convergence", churn],
];
const ALL_PHASES = ["setup", ...PHASES.map(([name]) => name)];
const phases = args.phases ? String(args.phases).split(",") : ALL_PHASES;

const runId = Date.now().toString(36);
const artifactDir = path.join(REPO, ".load-artifacts", "scenarios", runId);
const report = new Report(runId, artifactDir);
const stack = new Stack({
  runId,
  artifactDir,
  ports: {
    pg: Number(args.pgPort ?? 56491),
    api: Number(args.apiPort ?? 4391),
    web: Number(args.webPort ?? 5191),
  },
  voiceAgent: !args["no-voice-agent"] && phases.includes("voice"),
  mockAi: !!args["mock-ai"],
});

const world = new World({ stack, report, runId });
const ctx = { world, report, stack, headed: !!args.headed };
let exitCode = 0;
try {
  report.startPhase("setup", "Isolated stack, 24 accounts, workspace, board, sockets");
  await stack.up();
  report.note(`API ${stack.apiUrl} · web ${stack.webUrl} · db ${stack.container} · agent name ${stack.agentName}`);
  await world.provision();
  await world.connectAll();
  if (!args["skip-idle"]) await report.guard("idle eviction check ran", () => world.idleEvictionCheck());
  // From here on people are active: cursors move, as they would while working.
  world.startHeartbeats(() => world.people.filter((p) => p.page));
  report.endPhase();
  for (const [name, title, fn] of PHASES) {
    if (!phases.includes(name)) continue;
    report.startPhase(name, title);
    ctx.phaseStart = Date.now();
    await report.guard(`${name} phase ran to the end`, () => fn(ctx));
    report.endPhase();
  }
  ctx.done = true;
} catch (err) {
  report.check("run completed without crashing", false, err?.stack ?? String(err));
  exitCode = 1;
} finally {
  world.stopHeartbeats();
  for (const p of world.people) {
    p.rt?.close();
    await p.call?.leave?.().catch?.(() => {});
  }
  dumpErrors(world.people, artifactDir);
  await ctx.browser?.close().catch(() => {});
  await ctx.voiceBrowser?.close().catch(() => {});
  const summary = report.write({
    setup: {
      runId,
      api: stack.apiUrl,
      web: stack.webUrl,
      board: world.boardId,
      org: world.orgId,
    },
  });
  console.log(`\nReport: ${path.join(artifactDir, "report.md")}`);
  console.log(`${summary.passed} passed, ${summary.failed} failed, ${summary.known} known`);
  if (summary.failed) exitCode = 1;
  if (args.keep) {
    console.log("Stack left running (--keep). Stop it with: docker rm -f " + stack.container + " and kill the api/web processes.");
  } else {
    await stack.down();
  }
  process.exit(exitCode);
}
