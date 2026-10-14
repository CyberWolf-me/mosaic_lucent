/**
 * Canvas scenarios: everyone at once, one by one, and on the same object.
 */
import { pMap, sleep, waitFor } from "../lib/api.mjs";
import { gotoBoard, launchBrowser, openAs, shot } from "../lib/browser.mjs";
import { checkConvergence, STALE_AI_BASE } from "../lib/converge.mjs";
import { Rejected, newRequestId } from "../lib/realtime.mjs";
import { comment, connect, del, move, node, react, sticky, text, uid, vote } from "../lib/ops.mjs";

const BUILD_PROMPT =
  "Launch plan for our mobile app: design review, build, QA, beta, then release. " +
  "We decided on a staged rollout. Open question: do we need a feature flag service? Risk: app store review delay.";

/** Open the four canvas browsers: owner, guest editor, commenter, viewer. */
export async function openCanvasBrowsers(ctx) {
  const { world, stack, report } = ctx;
  ctx.browser ??= await launchBrowser({ headed: ctx.headed });
  for (const name of ["Ava", "Gus", "Sam", "Vic"]) {
    const person = world.p(name);
    await openAs(ctx.browser, person, {
      baseUrl: stack.webUrl,
      report,
      scriptedSpeech: name === "Ava",
      // Ava builds by voice later; Lucent's reply is spoken, so let it.
      settings: { meetingMode: "intelligence", approvalThreshold: "large" },
    });
    await gotoBoard(person.page, stack.webUrl, world.boardId);
  }
  ctx.canvasBrowsers = ["Ava", "Gus", "Sam", "Vic"].map((n) => world.p(n));
}

/** Wait for the proposal panel in a browser and apply it; returns true if one was applied. */
export async function applyProposalIn(page, timeoutMs = 20_000) {
  const panel = page.getByRole("dialog", { name: "Proposed changes" });
  try {
    await panel.waitFor({ timeout: timeoutMs });
  } catch {
    return false;
  }
  await panel.getByRole("button", { name: /Apply all/ }).click();
  await panel.waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------

export async function kickoff(ctx) {
  const { world, report: r } = ctx;
  await openCanvasBrowsers(ctx);
  const ava = world.p("Ava");
  ctx.startWorkspace = world.initialWorkspace;

  // The owner starts a REAL AI build from the empty board's hero, and the
  // other 23 pile in while the model is still thinking.
  const hero = ava.page.getByLabel("Describe what you want to build");
  await hero.waitFor({ timeout: 30_000 });
  await hero.fill(BUILD_PROMPT);
  const tBuild = performance.now();
  await hero.press("Enter");
  r.count("real AI calls (generate)");

  const seed = "seed_kickoff";
  await ava.rt.send([node(seed, "Kickoff", "start")], { label: "seed" });
  ctx.seed = seed;

  const editors = world.editors.filter((p) => p.name !== "Ava");
  const commenters = world.who((p) => p.role === "commenter");
  const viewers = world.who((p) => p.role === "viewer");
  const t0 = performance.now();
  const editorWork = editors.map((p) => {
    const id = uid(`n_${p.name.toLowerCase()}`);
    p.kickoffNode = id;
    // Pipelined: three batches in flight at once from every editor.
    return Promise.allSettled([
      p.rt.send([node(id, `${p.name}'s workstream`)], { label: "kickoff node" }),
      p.rt.send([connect(seed, id, "feeds")], { label: "kickoff edge" }),
      p.rt.send([sticky(uid("st"), `${p.name}: first thought`, Math.random() * 800, Math.random() * 600)], {
        label: "kickoff sticky",
      }),
    ]);
  });
  const commenterWork = commenters.map((p) =>
    Promise.allSettled([
      p.rt.send([comment(uid("c"), seed, `${p.name}: can we see the timeline? @Ava`)], { label: "comment" }),
      p.rt.send([vote(uid("v"), seed)], { label: "vote" }),
      p.rt.send([react(uid("r"), seed, "🎉")], { label: "react" }),
    ]),
  );
  const forbiddenPeople = [...viewers, world.p("Tara")];
  const forbidden = forbiddenPeople
    .map((p) => p.rt.send([node(uid("nope"), `${p.name} tries to edit`)], { label: "forbidden edit", timeoutMs: 8_000 }))
    .map((pr) => pr.then(() => "accepted", (e) => (e instanceof Rejected ? e.error : "uncorrelated")));

  const editorResults = (await Promise.all(editorWork)).flat();
  const commenterResults = (await Promise.all(commenterWork)).flat();
  const forbiddenResults = await Promise.all(forbidden);
  const stormMs = performance.now() - t0;

  const okEditor = editorResults.filter((x) => x.status === "fulfilled").length;
  const failures = editorResults.filter((x) => x.status === "rejected").map((x) => x.reason);
  const reordered = failures.filter((e) => e instanceof Rejected && e.error === "validation" && /does not exist/.test(e.detail ?? ""));
  r.check(
    `all ${editorResults.length} editor batches (16 editors × node, then edge to it, then sticky — sent back-to-back) acknowledged`,
    okEditor === editorResults.length,
    failures.length
      ? `${failures.length} refused, ${reordered.length} of them an edge validated before the node it points at — the same socket's batches committed out of order`
      : `${Math.round(stormMs)} ms for the whole storm`,
    failures.length && failures.length === reordered.length
      ? { known: "one socket's batches can commit out of order: Room.commit awaits a requestId lookup (findRequest) before joining the commit queue (server/src/room.ts:380-382)" }
      : {},
  );
  r.count("edge batches refused because their node landed later", reordered.length);
  r.check(
    "commenters' comment, vote and reaction all acknowledged",
    commenterResults.every((x) => x.status === "fulfilled"),
    commenterResults.filter((x) => x.status === "rejected").map((x) => x.reason.message).join("; "),
  );
  const refusedFrames = forbiddenPeople.map((p) =>
    p.rt.events.some((e) => e.type === "op-rejected" && e.error === "permission"),
  );
  r.check(
    "viewers' edits and a commenter's edit are refused with `permission`",
    refusedFrames.every(Boolean),
    forbiddenPeople.map((p, i) => `${p.name}:${refusedFrames[i] ? "refused" : "no refusal"}`).join(", "),
  );
  r.check(
    "each refusal names the request it refuses (so the client can tell which edit failed)",
    forbiddenResults.every((x) => x === "permission"),
    forbiddenResults.join(", "),
    forbiddenResults.every((x) => x === "uncorrelated")
      ? { known: "permission refusals carry no requestId (server/src/room.ts:364-368 returns none, realtime.ts:464-470 echoes none)" }
      : {},
  );

  // The AI build lands either directly or — because the board is no longer
  // empty and the batch is large — as a proposal every peer sees.
  const outcome = await waitFor(
    async () => {
      if (await ava.page.getByRole("dialog", { name: "Proposed changes" }).count()) return "proposal";
      const failure = ava.page.locator(".hero-failure, .toast-error, [role=alert]");
      if (await failure.count()) {
        const t = (await failure.first().textContent()) ?? "";
        if (t.trim()) return `failed: ${t.trim().slice(0, 200)}`;
      }
      if (await ava.page.locator(".clarification-bar").count()) return "clarification";
      // The browser's own commits carry its requestId format (boardSync.ts: req_<base36>).
      const fromBrowser = [...ava.rt.entries.values()].filter(
        (e) => e.by === ava.id && String(e.requestId ?? "").startsWith("req_"),
      );
      if (fromBrowser.length) return "applied";
      return null;
    },
    { timeout: 240_000, every: 1000, label: "the AI build to land" },
  ).catch((e) => `timeout: ${e.message}`);
  r.time("ai_build_browser_ms", performance.now() - tBuild);
  r.note(`owner's AI build outcome: ${outcome}`);
  if (outcome === "clarification") {
    await ava.page.locator(".clarification-bar .hero-chip").first().click();
    r.count("real AI calls (generate)");
  }
  if (outcome === "proposal" || outcome === "clarification") {
    const everyone = await Promise.allSettled(
      world.people.map((p) => p.rt.waitForEvent("proposal-created", () => true, 120_000)),
    );
    r.check(
      "the AI proposal reached all 24 people's sockets",
      everyone.every((x) => x.status === "fulfilled"),
      `${everyone.filter((x) => x.status === "fulfilled").length}/24`,
    );
    const gusSees = await world
      .p("Gus")
      .page.getByRole("dialog", { name: "Proposed changes" })
      .waitFor({ timeout: 30_000 })
      .then(
        () => true,
        () => false,
      );
    r.check("a guest editor's browser shows the same proposal panel", gusSees);
    const applied = await applyProposalIn(ava.page, 30_000);
    r.check("the owner applied the AI proposal from her browser", applied);
    const decided = await Promise.allSettled(
      world.people.map((p) => p.rt.waitForEvent("proposal-decided", () => true, 60_000)),
    );
    r.check(
      "every socket heard the proposal was decided",
      decided.every((x) => x.status === "fulfilled"),
      `${decided.filter((x) => x.status === "fulfilled").length}/24`,
    );
  } else {
    r.check("the owner's real AI build produced changes", outcome === "applied", outcome);
  }
  await shot(ava.page, r.artifactDir, "kickoff-ava");
  await shot(world.p("Vic").page, r.artifactDir, "kickoff-vic-viewer");
  await sleep(1500);
  ctx.knownStale = { Ava: STALE_AI_BASE };
  await checkConvergence(world, {
    label: "kickoff",
    startWorkspace: ctx.startWorkspace,
    browsers: ctx.canvasBrowsers,
    knownStale: ctx.knownStale,
  });
  // A reload re-joins from seq 0 and replays the log: the requester's canvas recovers.
  await ava.page.reload({ waitUntil: "domcontentloaded" });
  await ava.page.locator(".top-bar").first().waitFor({ timeout: 60_000 });
  ctx.knownStale = {};
  await checkConvergence(world, { label: "after owner reload", startWorkspace: ctx.startWorkspace, browsers: [ava] });
}

// ---------------------------------------------------------------------------

export async function relay(ctx) {
  const { world, report: r } = ctx;
  const ava = world.p("Ava");
  const id = uid("relay");
  const seedAck = await ava.rt.send([node(id, "Relay:", "process")], { label: "relay seed" });
  await Promise.all(world.people.map((q) => q.rt.waitForSeq(seedAck.seq, 20_000)));
  const runners = world.editors; // owner + 16 editors, in roster order
  let expected = "Relay:";
  const hops = [];
  for (const p of runners) {
    // Each runner builds on the label as THEIR socket last saw it.
    const seen = [...p.rt.entries.values()]
      .sort((a, b) => a.seq - b.seq)
      .flatMap((e) => e.ops)
      .filter((o) => (o.op === "CHANGE_TEXT" && o.id === id) || (o.op === "CREATE_NODE" && o.id === id))
      .map((o) => (o.op === "CHANGE_TEXT" ? o.text : o.label))
      .at(-1);
    const next = `${seen} →${p.name}`;
    const t0 = performance.now();
    const ack = await p.rt.send([text(id, next)], { label: "relay hop" });
    await Promise.all(world.people.map((q) => q.rt.waitForSeq(ack.seq, 20_000)));
    const ms = performance.now() - t0;
    r.time("relay_hop_everyone_has_it_ms", ms);
    hops.push(ms);
    expected = next;
  }
  const finalText = [...ava.rt.entries.values()]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((e) => e.ops)
    .filter((o) => o.op === "CHANGE_TEXT" && o.id === id)
    .at(-1)?.text;
  r.check(
    `the baton passed through all ${runners.length} editors in order, each building on what they saw`,
    finalText === expected,
    finalText,
  );
  const shown = await Promise.all(
    ctx.canvasBrowsers.map((p) =>
      p.page
        .locator(".node", { hasText: "→Rosa" })
        .first()
        .waitFor({ timeout: 20_000 })
        .then(
          () => true,
          () => false,
        ),
    ),
  );
  r.check("all four browsers show the finished relay label", shown.every(Boolean), shown.join(","));
  await checkConvergence(world, { label: "relay", startWorkspace: ctx.startWorkspace, browsers: ctx.canvasBrowsers, knownStale: ctx.knownStale });
}

// ---------------------------------------------------------------------------

const PROJECTION_RACE =
  "socket commits save the room's state in whatever order their saves finish (server/src/realtime.ts:539-545), so an older state can land last";

/** Poll the stored board until `pick` equals `want` (deep), or 8 s pass; returns the last value. */
async function settled(world, pick, want) {
  let value;
  const end = Date.now() + 8_000;
  while (Date.now() < end) {
    value = pick(await world.serverBoard());
    if (JSON.stringify(value) === JSON.stringify(want)) return value;
    await sleep(800);
  }
  return value;
}

export async function contention(ctx) {
  const { world, report: r } = ctx;
  const ava = world.p("Ava");
  const editors = world.editors.slice(1, 13); // 12 editors
  const hot = uid("hot");
  const doomed = uid("doomed");
  await ava.rt.send([node(hot, "Hot node"), node(doomed, "Doomed node")], { label: "contention seed" });

  // 12 people rename the same node at the same instant: last seq wins.
  const renames = await Promise.allSettled(editors.map((p) => p.rt.send([text(hot, `named by ${p.name}`)])));
  const acked = renames.map((x, i) => (x.status === "fulfilled" ? { seq: x.value.seq, name: editors[i].name } : null)).filter(Boolean);
  r.check("12 simultaneous renames of one node are all acknowledged", acked.length === 12, `${acked.length}`);
  const winner = acked.sort((a, b) => b.seq - a.seq)[0];
  await Promise.all(world.people.map((q) => q.rt.waitForSeq(winner.seq, 20_000)));
  const lastSeen = (p) =>
    [...p.rt.entries.values()]
      .sort((a, b) => a.seq - b.seq)
      .flatMap((e) => e.ops)
      .filter((o) => o.op === "CHANGE_TEXT" && o.id === hot)
      .at(-1)?.text;
  const views = new Set(world.people.map(lastSeen));
  r.check(
    "every socket ends on the rename with the highest seq",
    views.size === 1 && views.has(`named by ${winner.name}`),
    [...views].join(" | "),
  );
  const storedLabel = await settled(world, (b) => b.workspace.nodes[hot]?.label, `named by ${winner.name}`);
  r.check(
    "the stored board settles on that same name",
    storedLabel === `named by ${winner.name}`,
    `${storedLabel} vs ${winner.name}`,
    storedLabel === `named by ${winner.name}` ? {} : { known: PROJECTION_RACE },
  );

  // …and drag it at the same instant (MOVE_NODE is human-only: the socket path).
  const moves = await Promise.allSettled(editors.map((p, i) => p.rt.send([move(hot, i * 37, i * 11)])));
  const moveWinner = moves
    .map((x, i) => (x.status === "fulfilled" ? { seq: x.value.seq, i } : null))
    .filter(Boolean)
    .sort((a, b) => b.seq - a.seq)[0];
  const want = { x: moveWinner.i * 37, y: moveWinner.i * 11 };
  const pos = await settled(world, (b) => b.workspace.nodes[hot]?.position, want);
  r.check(
    "12 simultaneous drags: the stored node sits where the last drag (by seq) put it",
    pos && pos.x === want.x && pos.y === want.y,
    `${JSON.stringify(pos)} vs ${JSON.stringify(want)}`,
    pos && pos.x === want.x && pos.y === want.y ? {} : { known: PROJECTION_RACE },
  );

  // Delete races an edit: the edit must be refused if it lands second, never resurrect the node.
  const [d, e] = await Promise.allSettled([
    world.p("Ben").rt.send([del(doomed)], { label: "delete" }),
    world.p("Gus").rt.send([text(doomed, "Gus edits a node being deleted")], { label: "late edit" }),
  ]);
  const editOutcome = e.status === "fulfilled" ? "applied" : e.reason instanceof Rejected ? e.reason.error : e.reason.message;
  const order = d.status === "fulfilled" && e.status === "fulfilled" ? (e.value.seq < d.value.seq ? "edit first" : "edit after delete!") : "";
  r.check(
    "delete vs. edit race: the delete wins and a later edit is refused (`validation`), never applied after it",
    d.status === "fulfilled" && (editOutcome === "validation" || order === "edit first"),
    `delete ${d.status}, edit ${editOutcome} ${order}`,
  );
  const gone = await settled(world, (b) => !b.workspace.nodes[doomed], true);
  r.check("the stored board no longer has the deleted node", gone === true, `${gone}`, gone === true ? {} : { known: PROJECTION_RACE });

  // The same batch sent twice (a retry after a dropped connection) commits once.
  const rid = newRequestId("dup");
  const dupNode = uid("dup");
  const first = await world.p("Hana").rt.send([node(dupNode, "Sent twice")], { requestId: rid });
  const second = await world.p("Hana").rt.send([node(dupNode, "Sent twice")], { requestId: rid });
  await sleep(500);
  const withRid = [...ava.rt.entries.values()].filter((x) => x.requestId === rid);
  r.check(
    "a retried batch (same requestId) is acknowledged as a duplicate and logged once",
    second.duplicate && second.seq === first.seq && withRid.length === 1,
    `duplicate=${second.duplicate} seqs ${first.seq}/${second.seq} logged ${withRid.length}×`,
  );

  // REST and socket writers at once — five integrations posting ops while people type.
  const rest = await Promise.allSettled(
    editors.slice(0, 5).map((p, i) =>
      p.post(`/api/boards/${world.boardId}/ops`, {
        ops: [node(uid("rest"), `REST writer ${p.name}`), move(hot, 1, 1)],
        label: "rest writer",
      }),
    ),
  );
  const restOk = rest.filter((x) => x.status === "fulfilled");
  r.check(
    "5 concurrent REST /ops writers all commit (MOVE_NODE dropped as human-only)",
    restOk.length === 5,
    rest.filter((x) => x.status === "rejected").map((x) => x.reason.message).join("; "),
  );
  await checkConvergence(world, { label: "contention", startWorkspace: ctx.startWorkspace, browsers: ctx.canvasBrowsers, knownStale: ctx.knownStale });
}
