/**
 * Half the team holds a meeting inside the board's REAL LiveKit call while
 * the other half keeps working on the canvas — at the same time.
 *
 * Meeting track (12): Ben joins from his browser, becomes host and
 * transcribes; the other 11 join as Node participants through Lucent's token
 * route (guests wait in the lobby until admitted). Everyone "speaks": their
 * finished lines reach Ben's device over the call's data channel and land in
 * one transcript, attributed. The real model extracts decisions, actions and
 * questions as proposals; the owner applies them from her browser. Chat,
 * hands, co-host, mute-everyone, remove, lock — then the host ends the call
 * for everyone, which ends the transcript and starts the real summary.
 *
 * Canvas track (12): continuous edits, two real AI builds over the API, a
 * real Ask, a real generated image, comments — while the meeting runs.
 */
import { pMap, sleep, waitFor } from "../lib/api.mjs";
import { gotoBoard, openAs, shot } from "../lib/browser.mjs";
import { checkConvergence } from "../lib/converge.mjs";
import { CallParticipant } from "../lib/livekit.mjs";
import { Rejected } from "../lib/realtime.mjs";
import { comment, connect, node, sticky, text, uid } from "../lib/ops.mjs";
import { MEETING_HALF, CANVAS_HALF } from "../lib/world.mjs";
import { applyProposalIn } from "./canvas.mjs";
import { summarizeWorkspace } from "../../../packages/ai/dist/index.js";

/** What each person says, in order. Mixed so extraction has something real to find. */
const SCRIPT = [
  ["Ben", "Thanks everyone. Goal today: lock the beta date and who owns QA."],
  ["Cleo", "I think we should ship the beta on November 14th."],
  ["Dev", "Agreed, November 14th works if the payments fix lands this week."],
  ["Hana", "Open question: do we need a feature flag service before the beta?"],
  ["Ava", "Decision: we go with a staged rollout, ten percent first."],
  ["Ivo", "I'll own QA for the beta, starting Monday."],
  ["Jade", "Risk: app store review could take a week, so submit early."],
  ["Kai", "Can we add crash reporting before beta? I think it is required."],
  ["Lena", "I will draft the beta announcement by Friday."],
  ["Eli", "Action: Dev to fix the payments bug by Wednesday."],
  ["Sam", "Question from support: who answers beta tester emails?"],
  ["Ben", "Let's decide: support rotation, Sam owns the inbox."],
  ["Cleo", "Requirement: beta builds must be signed and notarized."],
  ["Hana", "Decision: no feature flag service for beta, revisit after launch."],
];

export async function meeting(ctx) {
  const { world, report: r, stack } = ctx;
  const ben = world.p("Ben");
  const ava = world.p("Ava");
  const dir = r.artifactDir;
  const startSeq = (await world.serverBoard()).latestSeq;

  // Let the workspace's automation propose whatever the meeting leaves unextracted (ADR 0049).
  await ava.patch(`/api/orgs/${world.orgId}/settings`, { automation: { meetingExtract: true } });

  // --- Ben's browser: meeting view, video call, host, transcribing ----------
  await openAs(ctx.browser, ben, {
    baseUrl: stack.webUrl,
    report: r,
    scriptedSpeech: true,
    settings: { meetingMode: "intelligence", sttProvider: "browser" },
  });
  await gotoBoard(ben.page, stack.webUrl, world.boardId, { view: "meeting" });
  await ben.page.getByRole("button", { name: /video call/i }).first().click();
  await ben.page.getByRole("region", { name: "Join the call" }).waitFor({ timeout: 30_000 });
  await ben.page.getByRole("button", { name: "Join now" }).click();
  await ben.page.locator(".call-stage").waitFor({ timeout: 45_000 });
  const benHost = await waitFor(async () => (await ben.page.locator(".call-tile .call-host-badge").count()) >= 1, {
    timeout: 20_000,
    label: "host badge",
  }).catch(() => false);
  r.check("Ben joined the real LiveKit call from his browser and is the host", !!benHost);
  await ben.page.getByRole("button", { name: /Transcribe this meeting/ }).first().click();
  const recording = await waitFor(
    async () => (await ben.page.getByRole("button", { name: /Stop transcribing/ }).count()) > 0,
    { timeout: 20_000, label: "recording" },
  ).catch(() => false);
  r.check("Ben's device is keeping the call's transcript", !!recording);
  await shot(ben.page, dir, "meeting-host-joined");

  // --- Both tracks at once ---------------------------------------------------
  const meetingTrack = runMeetingTrack(ctx);
  const canvasTrack = runCanvasTrack(ctx, () => ctx.meetingDone);
  const raceTrack = runTurnsRace(ctx);
  const results = await Promise.allSettled([meetingTrack, canvasTrack, raceTrack]);
  for (const [i, res] of results.entries()) {
    if (res.status === "rejected") {
      r.check(`${["meeting track", "canvas track", "turns race"][i]} finished`, false, res.reason?.stack?.split("\n").slice(0, 3).join(" | "));
    }
  }
  await checkConvergence(world, {
    label: "meeting + canvas",
    startWorkspace: ctx.startWorkspace,
    browsers: ctx.canvasBrowsers,
    knownStale: ctx.knownStale,
  });
}

async function runMeetingTrack(ctx) {
  const { world, report: r } = ctx;
  const ben = world.p("Ben");
  const ava = world.p("Ava");
  try {
    // 11 Node participants join through Lucent's token route.
    const others = MEETING_HALF.filter((n) => n !== "Ben").map((n) => world.p(n));
    for (const p of others) p.call = new CallParticipant(p, world.boardId);
    const tokenFirst = await Promise.all(others.map((p) => p.call.requestToken()));
    const waiting = others.filter((p, i) => tokenFirst[i].status === 202);
    const straightIn = others.filter((p, i) => tokenFirst[i].status === 200);
    r.check(
      "workspace members get straight in; link guests wait in the lobby",
      straightIn.every((p) => ["owner", "member"].includes(p.role)) && waiting.every((p) => !["owner", "member"].includes(p.role)),
      `in: ${straightIn.map((p) => p.name).join(",")} · waiting: ${waiting.map((p) => p.name).join(",")}`,
    );
    const joins = others.map((p) => p.call.join({ waitTimeoutMs: 90_000 }));

    // The host lets guests in: the first from the knock banner in his browser,
    // the rest through the host API; one is turned away.
    const denied = world.p("Vic");
    await waitFor(async () => (await ben.page.locator(".call-banner.is-waiting").count()) > 0, {
      timeout: 30_000,
      label: "knock banner",
    }).catch(() => {});
    const banner = ben.page.locator(".call-banner.is-waiting").first();
    const bannerName = (await banner.textContent().catch(() => "")) ?? "";
    await banner.getByRole("button", { name: "Let in" }).click().catch(() => {});
    r.check("the host sees a guest knocking and lets them in from the browser", bannerName.length > 0, bannerName.slice(0, 80));
    for (const g of waiting) {
      if (bannerName.includes(g.name)) continue;
      await ben.post(`/api/boards/${world.boardId}/call/admit`, { userId: g.id, allow: g !== denied });
    }
    const joined = await Promise.allSettled(joins);
    const statusOf = (p) => p.call.tokenAnswers.at(-1)?.status;
    r.check(
      "10 people joined Ben in the call; the guest the host turned away was refused",
      others.filter((p) => p !== denied).every((p) => p.call.connected) && statusOf(denied) === 403,
      others.map((p) => `${p.name}:${p.call.connected ? "in" : statusOf(p)}`).join(" "),
    );
    const live = await ben.get(`/api/boards/${world.boardId}/call`);
    r.check("GET /call lists 11 participants", live.participants?.length === 11, `${live.participants?.length}`);
    const inCall = others.filter((p) => p.call.connected);

    // Everyone speaks: lines go to the keeper (Ben) over the data channel.
    const t0 = performance.now();
    for (const [name, line] of SCRIPT) {
      if (name === "Ben") await ben.page.evaluate((t) => window.__say(t), line);
      else {
        const p = world.p(name);
        if (p.call?.connected) await p.call.line(line, ben.id);
      }
      await sleep(900);
    }
    r.time("meeting_script_ms", performance.now() - t0);

    // Chat, hands, co-host, mute everyone.
    await world.p("Cleo").call.chat("Slides are in the board, frame 2");
    await world.p("Hana").call.chat("+1 to the staged rollout");
    const chatSeen = await waitFor(
      async () => (await ben.page.getByRole("button", { name: /Chat \(\d+ unread\)/ }).count()) > 0,
      { timeout: 15_000, label: "chat unread" },
    ).catch(() => false);
    r.check("chat from Node participants shows as unread in the host's browser", !!chatSeen);
    const hands = ["Dev", "Hana", "Jade", "Lena"].map((n) => world.p(n));
    const handRes = await Promise.all(hands.map((p) => p.call.state({ hand: true })));
    r.check("4 people raise hands (server-set call attributes)", handRes.every((x) => x.status === 200), handRes.map((x) => x.status).join(","));
    const handsSeen = await waitFor(
      async () => {
        const evs = world.p("Cleo").call.events.filter((e) => e.type === "attributes" && e.changed?.["lucent.hand"]);
        return new Set(evs.map((e) => e.identity)).size >= 4;
      },
      { timeout: 15_000, label: "hands" },
    ).catch(() => false);
    r.check("another participant sees all 4 hands go up", !!handsSeen);
    const lower = await ben.try("POST", `/api/boards/${world.boardId}/call/state`, { identity: world.p("Dev").id, hand: false });
    r.check("the host lowers someone else's hand", lower.status === 200, `${lower.status}`);
    const cohost = await ben.try("POST", `/api/boards/${world.boardId}/call/hosts`, { identity: world.p("Cleo").id });
    r.check("the host makes Cleo a co-host", cohost.status === 200, `${cohost.status}`);
    const muted = await world.p("Cleo").try("POST", `/api/boards/${world.boardId}/call/mute`, { everyone: true });
    r.check("the co-host mutes everyone", muted.status === 200 && muted.data?.muted >= 5, JSON.stringify(muted.data));
    const notHost = await world.p("Kai").try("POST", `/api/boards/${world.boardId}/call/mute`, { everyone: true });
    r.check("a plain participant may not mute everyone", notHost.status === 403, `${notHost.status}`);

    // Remove one participant; they can't come back. Then lock the call.
    const kai = world.p("Kai");
    const removed = await ben.try("POST", `/api/boards/${world.boardId}/call/remove`, { identity: kai.id });
    await waitFor(() => !kai.call.connected, { timeout: 15_000, label: "Kai removed" }).catch(() => {});
    const back = await kai.call.requestToken();
    r.check(
      "the host removes Kai: he is disconnected and can't rejoin",
      removed.status === 200 && !kai.call.connected && back.status === 403,
      `remove ${removed.status}, connected ${kai.call.connected}, rejoin ${back.status} ${JSON.stringify(back.data)}`,
    );
    const lock = await ben.try("POST", `/api/boards/${world.boardId}/call/settings`, { locked: true });
    const late = new CallParticipant(world.p("Fay"), world.boardId);
    const lateAnswer = await late.requestToken();
    r.check("after the host locks the call, a late joiner is refused", lock.status === 200 && lateAnswer.status === 403, `lock ${lock.status}, late ${lateAnswer.status} ${JSON.stringify(lateAnswer.data)}`);

    // The transcript holds everyone's lines, attributed.
    const meetings = await waitFor(
      async () => {
        const { meetings } = await ava.get(`/api/boards/${world.boardId}/meetings`);
        const live = meetings.find((m) => m.endedAt === null && m.turns?.length >= SCRIPT.length - 2);
        return live ? meetings : null;
      },
      { timeout: 40_000, every: 1500, label: "transcript" },
    ).catch(async () => (await ava.get(`/api/boards/${world.boardId}/meetings`)).meetings);
    const transcript = meetings.find((m) => m.endedAt === null) ?? meetings[0];
    ctx.meetingId = transcript?.id;
    const speakers = new Set((transcript?.turns ?? []).map((t) => t.speaker));
    const expectedSpeakers = new Set(SCRIPT.map(([n]) => n).filter((n) => n === "Ben" || world.p(n).call?.connected || n === "Kai"));
    r.check(
      `one transcript holds the call's lines (${SCRIPT.length} spoken)`,
      (transcript?.turns?.length ?? 0) >= SCRIPT.length - 1,
      `${transcript?.turns?.length} turns`,
    );
    r.check(
      "each line is attributed to the person who said it",
      [...expectedSpeakers].every((n) => speakers.has(n) || [...speakers].some((s) => s.startsWith(n))),
      `speakers: ${[...speakers].join(", ")}`,
    );

    // Real-model extraction proposes statements; the owner applies them.
    const proposed = await world.p("Fay").rt.waitForEvent("proposal-created", (e) => e.at > ctx.phaseStart, 180_000).catch(() => null);
    if (!proposed) {
      // The live loop waits for silence and spacing; ask for it explicitly.
      await ben.page.getByRole("button", { name: /Extract to board/ }).first().click().catch(() => {});
    }
    r.count("real AI calls (meeting extraction)");
    const applied = await applyProposalIn(ava.page, 180_000);
    r.check("the real model's meeting extraction arrived as a proposal the owner applied", applied);
    await sleep(1500);
    const board = await world.serverBoard();
    const statements = Object.values(board.workspace.nodes).filter((n) => n.statement);
    const kinds = new Set(statements.map((n) => n.statement.kind));
    r.check(
      "the board now holds extracted statements (decisions, actions, questions…)",
      statements.length >= 3,
      `${statements.length} statements, kinds: ${[...kinds].join(",")}`,
    );
    ctx.extracted = statements;

    // Review: approve one, assign one, reject one.
    const fromMeeting = statements.filter((n) => n.trust === "ai-suggested" || n.statement?.trust === "ai-suggested" || n.provenance);
    const pool = fromMeeting.length >= 3 ? fromMeeting : statements;
    if (pool.length >= 3) {
      const [a, b, c] = pool;
      const approve = await ava.try("POST", `/api/boards/${world.boardId}/review`, { nodeIds: [a.id], action: "approve" });
      const assign = await ava.try("POST", `/api/boards/${world.boardId}/review`, {
        nodeIds: [b.id],
        action: "assign",
        assignee: "Ivo",
        dueDate: "2026-11-14",
      });
      const reject = await ava.try("POST", `/api/boards/${world.boardId}/review`, { nodeIds: [c.id], action: "reject" });
      r.check(
        "review: approve, assign (owner + due date) and reject each commit",
        [approve, assign, reject].every((x) => x.status === 200),
        [approve, assign, reject].map((x) => `${x.status}`).join(","),
      );
    }

    // The host ends the call for everyone.
    await ben.page.getByRole("button", { name: /Leave or end the call/ }).click();
    await ben.page.getByRole("menuitem", { name: /End the call for everyone/ }).click();
    const allOut = await waitFor(() => inCall.filter((p) => p.name !== "Kai").every((p) => !p.call.connected), {
      timeout: 30_000,
      label: "everyone disconnected",
    }).catch(() => false);
    const reasons = inCall.map((p) => p.call.events.find((e) => e.type === "disconnected")?.reason);
    r.check("ending the call disconnects every participant", !!allOut, `reasons: ${[...new Set(reasons)].join(",")}`);
    const notLive = await waitFor(async () => !(await ben.get(`/api/boards/${world.boardId}/call`)).live, {
      timeout: 20_000,
      label: "call over",
    }).catch(() => false);
    r.check("the call is no longer live", !!notLive);

    // Ending the call ends the transcript; the real model writes the summary.
    const t1 = performance.now();
    const summarized = await waitFor(
      async () => {
        const m = await ava.get(`/api/boards/${world.boardId}/meetings/${ctx.meetingId}`);
        return m.endedAt && m.recap?.sections?.length ? m : null;
      },
      { timeout: 180_000, every: 2000, label: "summary" },
    ).catch(() => null);
    r.count("real AI calls (meeting summary)");
    r.time("meeting_summary_ms", performance.now() - t1);
    r.check(
      "the transcript ended with the call and has a real-model summary",
      !!summarized && summarized.recap.by === "model",
      summarized ? `${summarized.recap.sections.length} sections, by ${summarized.recap.by}` : "no recap",
    );
    const told = await ben.try("POST", `/api/boards/${world.boardId}/meetings/${ctx.meetingId}/notify-owners`, {});
    r.check("owners of the meeting's actions are notified", told.status === 200, JSON.stringify(told.data)?.slice(0, 160));
    const viewerAppend = await world.p("Vic").try("POST", `/api/boards/${world.boardId}/meetings/${ctx.meetingId}/turns`, {
      turns: [{ speaker: "Vic", at: Date.now(), text: "viewer tries to add a line" }],
    });
    r.check("a viewer cannot add to a meeting's transcript", viewerAppend.status === 403 || viewerAppend.status === 404, `${viewerAppend.status}`);
    await shot(ben.page, r.artifactDir, "meeting-after-end");
    for (const p of inCall) await p.call.leave();
  } finally {
    ctx.meetingDone = true;
  }
}

/** The other 12 keep working the whole time the meeting runs. */
async function runCanvasTrack(ctx, done) {
  const { world, report: r } = ctx;
  const people = CANVAS_HALF.map((n) => world.p(n));
  const editors = people.filter((p) => ["member", "editor"].includes(p.role));
  const commenters = people.filter((p) => p.role === "commenter");
  const viewers = people.filter((p) => p.role === "viewer");
  let sent = 0;
  let failed = 0;
  const loops = editors.map(async (p, i) => {
    const mine = uid(`w_${p.name.toLowerCase()}`);
    await p.rt.send([node(mine, `${p.name} — meeting-time work`)]);
    let k = 0;
    while (!done()) {
      const batch =
        k % 3 === 0
          ? [sticky(uid("st"), `${p.name} note ${k}`, 900 + i * 40, k * 20)]
          : k % 3 === 1
            ? [text(mine, `${p.name} — meeting-time work (rev ${k})`)]
            : [connect(mine, ctx.seed, "supports")];
      try {
        await p.rt.send(batch);
        sent++;
      } catch (err) {
        // A repeated edge is a legitimate validation refusal, not a failure.
        if (!(err instanceof Rejected && err.error === "validation")) failed++;
      }
      k++;
      await sleep(700 + Math.random() * 600);
    }
  });
  const chatter = commenters.map(async (p) => {
    let k = 0;
    while (!done()) {
      try {
        await p.rt.send([comment(uid("c"), ctx.seed, `${p.name}: note ${k} for @Ava`)]);
        sent++;
      } catch {
        failed++;
      }
      k++;
      await sleep(2500);
    }
  });
  const watchers = viewers.map(async (p) => {
    while (!done()) {
      p.rt.presence({ x: Math.random() * 1200, y: Math.random() * 800 });
      await sleep(400);
    }
  });

  // Real AI over the API while the meeting runs: two builds, an Ask, an image.
  const ai = (async () => {
    const milo = world.p("Milo");
    for (const [who, message] of [
      ["Milo", "Add a QA checklist: smoke tests, regression suite, device matrix, sign-off"],
      ["Nia", "Add an analytics section: events to track for the beta and a dashboard"],
    ]) {
      const p = world.p(who);
      const t0 = performance.now();
      const gen = await p.try("POST", "/api/generate", {
        message,
        summary: summarizeWorkspace((await world.serverBoard()).workspace),
        boardId: world.boardId,
        run: { boardId: world.boardId, surface: "canvas" },
      });
      r.count("real AI calls (generate)");
      r.time("ai_generate_api_ms", performance.now() - t0);
      const ops = gen.data?.operations ?? gen.data?.ops ?? [];
      if (gen.status === 200 && ops.length) {
        try {
          const ack = await p.rt.send(ops, { label: `AI: ${message.slice(0, 40)}`, runId: gen.data.runId });
          r.check(`${who}'s real AI build (${ops.length} ops) committed while the meeting ran`, true, `seq ${ack.seq}`);
        } catch (err) {
          r.check(`${who}'s real AI build committed while the meeting ran`, false, err.message);
        }
      } else {
        r.check(`${who}'s real AI build returned operations`, false, `${gen.status} ${JSON.stringify(gen.data)?.slice(0, 200)}`);
      }
    }
    const t1 = performance.now();
    const ask = await world.p("Quinn").try("POST", `/api/boards/${world.boardId}/ask`, {
      question: "Who owns QA and when is the beta?",
    });
    r.count("real AI calls (ask)");
    r.time("ai_ask_api_ms", performance.now() - t1);
    r.check("a real Ask over the API answers mid-meeting", ask.status === 200 && !!(ask.data?.answer ?? ask.data?.text), `${ask.status} ${JSON.stringify(ask.data)?.slice(0, 160)}`);
    const t2 = performance.now();
    const img = await world.p("Omar").try("POST", "/api/image", { prompt: "a simple flat rocket logo for a beta launch", boardId: world.boardId });
    r.count("real AI calls (image)");
    r.time("ai_image_ms", performance.now() - t2);
    const src = img.data?.dataUrl ?? img.data?.url ?? img.data?.src;
    if (img.status === 200 && src) {
      await world
        .p("Omar")
        .rt.send([{ op: "CREATE_SHAPE", id: uid("img"), kind: "image", position: { x: 1400, y: 200 }, size: { width: 200, height: 200 }, src }])
        .then(
          () => r.check("a real generated image lands on the board", true),
          (err) => r.check("a real generated image lands on the board", false, err.message),
        );
    } else {
      r.check("the image provider returned an image", false, `${img.status} ${JSON.stringify(img.data)?.slice(0, 200)}`);
    }
  })();

  await Promise.all([...loops, ...chatter, ...watchers, ai]);
  r.check(`the canvas half kept editing through the meeting (${sent} batches)`, failed === 0 && sent > 20, `${sent} sent, ${failed} failed`);
}

/**
 * Many devices appending to the SAME meeting at once. The product routes
 * everyone's lines through one keeper, but the API accepts appends from any
 * editor — so they must not lose each other's turns.
 */
async function runTurnsRace(ctx) {
  const { world, report: r } = ctx;
  const dev = world.p("Dev");
  const m = await dev.post(`/api/boards/${world.boardId}/meetings`, {
    turns: [{ speaker: "Dev", at: Date.now(), text: "Side channel: standup notes", speakerId: dev.id }],
    mode: "record",
  });
  const writers = world.editors.slice(0, 12);
  const results = await Promise.allSettled(
    writers.map((p, i) =>
      p.post(`/api/boards/${world.boardId}/meetings/${m.id}/turns`, {
        turns: [{ speaker: p.name, at: Date.now() + i, text: `${p.name}'s update`, speakerId: p.id }],
      }),
    ),
  );
  const ok = results.filter((x) => x.status === "fulfilled").length;
  const after = await dev.get(`/api/boards/${world.boardId}/meetings/${m.id}`);
  const lost = 1 + ok - (after.turns?.length ?? 0);
  r.check(
    `12 editors append to one meeting at once: all ${ok} appends kept`,
    lost === 0,
    `${after.turns?.length} turns stored for ${1 + ok} sent — ${lost} lost`,
    lost > 0 ? { known: "pg-meetings appendTo is read-merge-write without a lock (store/pg-meetings.ts:217-239)" } : {},
  );
  await dev.post(`/api/boards/${world.boardId}/meetings/${m.id}/end`, {});
}
