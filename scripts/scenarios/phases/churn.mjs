/**
 * The team changes underneath itself: a demotion and a removal mid-session,
 * four people dropping off and coming back, a meeting deleted and restored —
 * and at the end, everyone still sees the same board.
 */
import { pMap, sleep } from "../lib/api.mjs";
import { checkConvergence } from "../lib/converge.mjs";
import { Rejected } from "../lib/realtime.mjs";
import { node, sticky, text, uid } from "../lib/ops.mjs";

export async function churn(ctx) {
  const { world, report: r } = ctx;
  const ava = world.p("Ava");

  // Demote an editor while their socket is open.
  const quinn = world.p("Quinn");
  await ava.patch(`/api/boards/${world.boardId}/members/${quinn.id}`, { role: "viewer" });
  await sleep(500);
  const afterDemote = await quinn.rt.send([node(uid("q"), "Quinn after demotion")]).then(
    () => "accepted",
    (e) => (e instanceof Rejected ? e.error : e.message),
  );
  r.check("a demoted editor's next edit, on the already-open socket, is refused", afterDemote === "permission", afterDemote);

  // Remove someone: their socket is told, and their edits stop.
  const rosa = world.p("Rosa");
  await ava.del(`/api/boards/${world.boardId}/members/${rosa.id}`);
  const evicted = await rosa.rt.waitForEvent("error", (e) => /access removed/.test(e.message ?? ""), 10_000).catch(() => null);
  r.check("a removed member's open socket is told 'access removed'", !!evicted, evicted?.message ?? "no frame");
  const rosaGet = await rosa.try("GET", `/api/boards/${world.boardId}`);
  r.check("a removed member can no longer read the board", rosaGet.status === 404 || rosaGet.status === 403, `${rosaGet.status}`);
  rosa.rt.close();

  // Four people drop off; the room keeps moving; they come back.
  const dropped = ["Milo", "Nia", "Tara", "Wes"].map((n) => world.p(n));
  const heads = new Map(dropped.map((p) => [p.name, p.rt.contiguousHead()]));
  for (const p of dropped) p.rt.close();
  await sleep(300);
  const busy = world.editors.filter((p) => !["Quinn", "Rosa", "Milo", "Nia"].includes(p.name)).slice(0, 10);
  await pMap(busy, async (p) => {
    await p.rt.send([sticky(uid("off"), `${p.name} while others were away`)]);
    await p.rt.send([node(uid("off"), `${p.name} offline-period node`)]);
  }, 10);
  const head = (await world.serverBoard()).latestSeq;
  for (const p of dropped) {
    const from = heads.get(p.name);
    const welcome = await p.rt.connect(from);
    const caughtUp = welcome.type === "resync" || (welcome.catchup ?? []).length === head - from;
    r.check(
      `${p.name} reconnects from seq ${from} and catches up on exactly what was missed`,
      caughtUp && (welcome.type === "resync" || p.rt.contiguousHead() >= head),
      `${welcome.type}, ${(welcome.catchup ?? []).length} entries for ${head - from} missed`,
    );
  }

  // A meeting goes to the trash and comes back.
  const { meetings } = await ava.get(`/api/boards/${world.boardId}/meetings`);
  const victim = meetings.find((m) => m.endedAt);
  if (victim) {
    const delRes = await ava.try("DELETE", `/api/boards/${world.boardId}/meetings/${victim.id}`);
    const trash = await ava.get(`/api/orgs/${world.orgId}/trash`);
    const inTrash = JSON.stringify(trash).includes(victim.id);
    const restore = await ava.try("POST", `/api/orgs/${world.orgId}/trash/restore`, { kind: "meeting", id: victim.id });
    const back = await ava.try("GET", `/api/boards/${world.boardId}/meetings/${victim.id}`);
    r.check(
      "a meeting moves to the trash and is restored with its transcript",
      [200, 204].includes(delRes.status) && inTrash && [200, 204].includes(restore.status) && back.status === 200 && back.data.turns?.length === victim.turns?.length,
      `delete ${delRes.status}, in trash ${inTrash}, restore ${restore.status}, back ${back.status}`,
    );
  }

  // History tells who did what.
  const history = await ava.get(`/api/boards/${world.boardId}/history`);
  const rows = history.revisions ?? history.entries ?? history.items ?? [];
  const actors = new Set(rows.map((x) => x.actor?.name ?? x.actorName ?? x.by ?? x.actor?.actorId).filter(Boolean));
  r.check("the board's history lists revisions by many different people", rows.length > 0 && actors.size >= 5, `${rows.length} rows, ${actors.size} actors`);

  // Final word: everyone still connected sees the same board as the server.
  await sleep(1000);
  await checkConvergence(world, { label: "final", startWorkspace: ctx.startWorkspace, browsers: ctx.canvasBrowsers, knownStale: ctx.knownStale });
}
