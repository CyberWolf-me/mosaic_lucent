/**
 * Undo and redo, the way people actually press them: Ctrl+Z / Ctrl+Y in a
 * real browser, on a shared board other people keep editing.
 *
 * The contract (core/operationHistory.ts): undo reverts only YOUR most recent
 * change, one step per press; redo puts it back; nothing anyone else made is
 * ever removed; pressing past the start does nothing (and never leaves the
 * board). Every undo the browser sends is inspected op by op, so a wipe shows
 * up as exactly the ops that did it.
 */
import { sleep, waitFor } from "../lib/api.mjs";
import { gotoBoard, openAs, shot } from "../lib/browser.mjs";
import { applyOperations } from "../../../packages/core/dist/index.js";
import { node, connect, uid } from "../lib/ops.mjs";
import { applyProposalIn } from "./canvas.mjs";

/** The board as the log has it, replayed by an always-connected socket. */
function logBoard(world, ref) {
  let ws = structuredClone(world.initialWorkspace);
  const entries = [...ref.rt.entries.values()].sort((a, b) => a.seq - b.seq);
  for (const e of entries) ws = applyOperations(ws, e.ops);
  return ws;
}

const summarize = (ops) => {
  const counts = {};
  for (const o of ops) counts[o.op] = (counts[o.op] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, v]) => `${k}×${v}`)
    .join(" ");
};

export async function undo(ctx) {
  const { world, report: r, stack } = ctx;
  const gus = world.p("Gus");
  const hana = world.p("Hana");
  const ref = world.p("Yara"); // a viewer: always connected, never edits
  const dir = r.artifactDir;

  // Other people's content Gus must never lose.
  const theirs = Array.from({ length: 5 }, () => uid("theirs"));
  await hana.rt.send(theirs.map((id, i) => node(id, `Hana's step ${i + 1}`)));
  await hana.rt.send(theirs.slice(1).map((id, i) => connect(theirs[i], id, "then")));

  if (!gus.page) {
    await openAs(ctx.browser, gus, { baseUrl: stack.webUrl, report: r });
  }
  await gotoBoard(gus.page, stack.webUrl, world.boardId, { lens: "visual" });
  const page = gus.page;
  await page.locator(".node").first().waitFor({ timeout: 30_000 });
  const viewport = page.locator(".canvas-viewport");
  const box = await viewport.boundingBox();
  const spot = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });

  const mine = () => [...ref.rt.entries.values()].filter((e) => e.by === gus.id).sort((a, b) => a.seq - b.seq);
  const waitMine = async (n, label) =>
    waitFor(() => mine().length >= n, { timeout: 15_000, label }).then(
      () => true,
      () => false,
    );
  const press = async (keys) => {
    // Focus the canvas, not a text field: the shortcut ignores inputs.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.mouse.click(spot(0.97, 0.55).x, spot(0.97, 0.55).y);
    await page.keyboard.press(keys);
  };

  // --- Gus makes six changes of his own --------------------------------------
  const before = mine().length;
  const target = page.locator(".node", { hasText: "Hana's step 3" }).first();
  const tb = await target.boundingBox();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb.x + tb.width / 2 + 120, tb.y + tb.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  await waitMine(before + 1, "drag");
  for (const [i, fx] of [0.12, 0.2, 0.28].entries()) {
    await page.keyboard.press("Escape");
    await page.keyboard.press("s");
    await page.mouse.click(spot(fx, 0.85).x, spot(fx, 0.85).y);
    await page.keyboard.type(`Gus sticky ${i + 1}`);
    await page.keyboard.press("Escape");
    await waitMine(before + 2 + i, `sticky ${i + 1}`);
  }
  for (const [i, fy] of [0.2, 0.32].entries()) {
    await page.keyboard.press("Escape");
    await page.keyboard.press("p");
    const a = spot(0.85, fy);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(a.x + k * 12, a.y + Math.sin(k) * 15);
    await page.mouse.up();
    await waitMine(before + 5 + i, `stroke ${i + 1}`);
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");
  const made = mine().slice(before);
  r.check(
    "each of Gus's changes (a drag, stickies with text, two strokes) is its own commit",
    made.length >= 6 && made.every((e) => e.ops.length === 1),
    made.map((e) => `${e.label}:${summarize(e.ops)}`).join(" | "),
  );
  await shot(page, dir, "undo-0-before");
  const base = logBoard(world, ref);
  const countTheirs = (ws) => theirs.filter((id) => ws.nodes[id]).length;
  const gusShapes = (ws) => Object.values(ws.shapes).filter((s) => s.by === gus.id || made.some((e) => e.ops.some((o) => o.id === s.id))).length;
  const shapesBefore = gusShapes(base);

  // Someone else keeps working while Gus undoes.
  const hanaLater = uid("later");
  await hana.rt.send([node(hanaLater, "Hana added this after Gus's edits")]);

  // --- Ctrl+Z, one press at a time ---------------------------------------------
  const undoTrail = [];
  for (let i = 1; i <= made.length; i++) {
    const n = mine().length;
    await press("Control+z");
    const got = await waitMine(n + 1, `undo ${i}`);
    const entry = mine().at(-1);
    const ws = logBoard(world, ref);
    undoTrail.push({
      press: i,
      sent: got ? summarize(entry.ops) : "nothing",
      label: got ? entry.label : "",
      theirs: countTheirs(ws),
      later: !!ws.nodes[hanaLater],
      gusShapes: gusShapes(ws),
      nodes: Object.keys(ws.nodes).length,
    });
  }
  r.note(`undo trail: ${undoTrail.map((u) => `#${u.press} ${u.sent} → their nodes ${u.theirs}/5, Gus's shapes ${u.gusShapes}, nodes ${u.nodes}`).join(" · ")}`);
  const inverseOf = { CREATE_SHAPE: "DELETE_SHAPE", UPDATE_SHAPE: "UPDATE_SHAPE", MOVE_NODE: "MOVE_NODE" };
  const expectSent = [...made].reverse().map((e) => `${inverseOf[e.ops[0].op]}×1`);
  const oneStep = undoTrail.every((u, i) => u.sent === expectSent[i]);
  r.check(
    `each Ctrl+Z reverts exactly Gus's latest change, newest first (${made.length} presses)`,
    oneStep,
    undoTrail.map((u) => `#${u.press}: ${u.sent}`).join(" · "),
  );
  r.check(
    "no undo removes anything someone else made",
    undoTrail.every((u) => u.theirs === 5 && u.later),
    undoTrail.map((u) => `#${u.press}: ${u.theirs}/5${u.later ? "" : " + lost Hana's later node"}`).join(" · "),
  );
  await shot(page, dir, "undo-1-after-six");

  // --- Past the start: nothing happens, and Gus stays on the board -------------
  const n0 = mine().length;
  for (let i = 0; i < 8; i++) await press("Control+z");
  await sleep(2500);
  const extra = mine().slice(n0);
  const url = page.url();
  const hero = await page.getByLabel("Describe what you want to build").count();
  const wsPast = logBoard(world, ref);
  r.check(
    "pressing Ctrl+Z past the start sends nothing and removes nothing",
    extra.length === 0 && countTheirs(wsPast) === 5,
    extra.length ? `sent ${extra.map((e) => summarize(e.ops)).join(" | ")}` : `their nodes ${countTheirs(wsPast)}/5`,
  );
  r.check(
    "…and Gus is still on the same board's canvas (no jump to the start screen or home)",
    /view=canvas/.test(url) && url.includes(world.boardId) && hero === 0,
    `url ${url.replace(stack.webUrl, "")}, start screen shown: ${hero > 0}`,
  );
  await shot(page, dir, "undo-2-past-start");

  // --- Ctrl+Y brings everything back, in order ---------------------------------
  const redoTrail = [];
  for (let i = 1; i <= made.length; i++) {
    const n = mine().length;
    await press("Control+y");
    const got = await waitMine(n + 1, `redo ${i}`);
    redoTrail.push(got ? summarize(mine().at(-1).ops) : "nothing");
  }
  const after = logBoard(world, ref);
  r.check(
    `${made.length} Ctrl+Y presses redo all ${made.length} changes`,
    redoTrail.every((x) => x !== "nothing") && gusShapes(after) === shapesBefore,
    `${redoTrail.join(" · ")} — Gus's shapes ${gusShapes(after)}/${shapesBefore}`,
  );
  const dragged = made.find((e) => e.ops[0].op === "MOVE_NODE")?.ops[0];
  const draggedBack = dragged ? after.nodes[dragged.id]?.position : undefined;
  const draggedTo = dragged?.position;
  if (dragged) {
    r.check(
      "the redone drag puts the node back where Gus dropped it",
      draggedBack && draggedTo && draggedBack.x === draggedTo.x && draggedBack.y === draggedTo.y,
      `${JSON.stringify(draggedBack)} vs ${JSON.stringify(draggedTo)}`,
    );
  } else {
    r.note("the scripted drag didn't register as a move this run (pointer landed off the node); the drag/redo check was skipped");
  }
  await shot(page, dir, "undo-3-after-redo");

  // --- An AI build is one step: undo it, redo it -------------------------------
  const ai = world.p("Ava");
  if (ai.page) {
    await gotoBoard(ai.page, stack.webUrl, world.boardId, { lens: "visual" });
    await ai.page.getByRole("button", { name: "Build mode" }).click().catch(() => {});
    const box2 = ai.page.getByLabel("Ask Lucent");
    await box2.fill("Add an online store checkout: cart, payment, confirmation and shipping");
    const avaBefore = [...ref.rt.entries.values()].filter((e) => e.by === ai.id).length;
    await box2.press("Enter");
    r.count("real AI calls (generate)");
    await applyProposalIn(ai.page, 120_000);
    const built = await waitFor(
      () => [...ref.rt.entries.values()].filter((e) => e.by === ai.id).length > avaBefore,
      { timeout: 150_000, label: "AI build" },
    ).then(
      () => true,
      () => false,
    );
    const aiEntry = [...ref.rt.entries.values()].filter((e) => e.by === ai.id).sort((a, b) => a.seq - b.seq).at(-1);
    const created = (aiEntry?.ops ?? []).filter((o) => o.op === "CREATE_NODE").map((o) => o.id);
    const viaProposal = aiEntry?.label === "proposal approved" || !!aiEntry?.actor?.approvedBy;
    if (built && created.length && viaProposal) {
      // Approval commits server-side; this tab records it so Ctrl+Z can undo it.
      const count = () => [...ref.rt.entries.values()].filter((e) => e.by === ai.id).length;
      await ai.page.keyboard.press("Escape");
      const n0 = count();
      await ai.page.keyboard.press("Control+z");
      await sleep(1200);
      const asked = await ai.page.getByRole("alertdialog", { name: "Confirm undo" }).isVisible().catch(() => false);
      await ai.page.keyboard.press("Control+z");
      await waitFor(() => count() > n0, { timeout: 10_000 }).catch(() => {});
      const ws1 = logBoard(world, ref);
      const gone = created.filter((id) => !ws1.nodes[id]).length;
      r.check(
        "an AI change applied by approving its proposal can be undone with Ctrl+Z (after confirming)",
        asked && gone === created.length && countTheirs(ws1) === 5,
        `confirmation ${asked ? "shown" : "not shown"}; removed ${gone}/${created.length} of its nodes; others' nodes ${countTheirs(ws1)}/5`,
      );
      const n1 = count();
      await ai.page.keyboard.press("Control+y");
      await waitFor(() => count() > n1, { timeout: 10_000 }).catch(() => {});
      const ws2 = logBoard(world, ref);
      r.check(
        "…and Ctrl+Y brings it back",
        created.every((id) => ws2.nodes[id]),
        `${created.filter((id) => ws2.nodes[id]).length}/${created.length}`,
      );
    } else if (built && created.length) {
      const nAva = [...ref.rt.entries.values()].filter((e) => e.by === ai.id).length;
      await ai.page.keyboard.press("Escape");
      await ai.page.mouse.click(spot(0.97, 0.55).x, spot(0.97, 0.55).y);
      await ai.page.keyboard.press("Control+z"); // asks first (a large undo)
      await sleep(800);
      await ai.page.keyboard.press("Control+z"); // confirms
      await waitFor(() => [...ref.rt.entries.values()].filter((e) => e.by === ai.id).length > nAva, { timeout: 15_000 }).catch(() => {});
      const ws1 = logBoard(world, ref);
      const gone = created.filter((id) => !ws1.nodes[id]).length;
      r.check(
        `one Ctrl+Z undoes the whole AI build (${created.length} nodes) and nothing else`,
        gone === created.length && countTheirs(ws1) === 5 && gusShapes(ws1) === shapesBefore,
        `removed ${gone}/${created.length} AI nodes; their nodes ${countTheirs(ws1)}/5; Gus's shapes ${gusShapes(ws1)}/${shapesBefore}`,
      );
      const empty = Object.keys(ws1.nodes).length === 0;
      if (empty) r.note("the board was empty after that undo — the start screen replaces the canvas, which reads as being sent home");
      const nAva2 = [...ref.rt.entries.values()].filter((e) => e.by === ai.id).length;
      await ai.page.keyboard.press("Control+y");
      await waitFor(() => [...ref.rt.entries.values()].filter((e) => e.by === ai.id).length > nAva2, { timeout: 15_000 }).catch(() => {});
      const ws2 = logBoard(world, ref);
      const back = created.filter((id) => ws2.nodes[id]).length;
      r.check(`Ctrl+Y brings the AI build back (${created.length} nodes)`, back === created.length, `${back}/${created.length}`);
    } else {
      r.check("the AI build for the undo test landed", false, aiEntry ? summarize(aiEntry.ops) : "no commit");
    }
  }

  // --- The reported flow: a fresh board, an AI build, drawings, Ctrl+Z past it all
  await r.guard("fresh board: build, draw, undo past everything, redo", async () => {
    const owner = world.p("Ava");
    const fresh = await owner.post("/api/boards", { name: `Undo check ${world.runId}`, orgId: world.orgId });
    const watcher = new (await import("../lib/realtime.mjs")).LiveClient(owner, stack.apiUrl, fresh.id);
    await watcher.connect(0);
    const p = owner.page;
    await gotoBoard(p, stack.webUrl, fresh.id, { lens: "visual" });
    const hero = p.getByLabel("Describe what you want to build");
    await hero.waitFor({ timeout: 30_000 });
    await hero.fill("An e-commerce platform with Stripe payments");
    await hero.press("Enter");
    r.count("real AI calls (generate)");
    await p.locator(".node").first().waitFor({ timeout: 150_000 });
    await waitFor(() => watcher.entries.size >= 1, { timeout: 30_000 });
    const built = Object.keys(applyOperations(structuredClone(world.initialWorkspace), [...watcher.entries.values()].flatMap((e) => e.ops)).nodes).length;
    // Two strokes on top.
    const vb = await p.locator(".canvas-viewport").boundingBox();
    for (const fy of [0.2, 0.35]) {
      await p.keyboard.press("Escape");
      await p.keyboard.press("p");
      const a = { x: vb.x + vb.width * 0.85, y: vb.y + vb.height * fy };
      await p.mouse.move(a.x, a.y);
      await p.mouse.down();
      for (let k = 1; k <= 10; k++) await p.mouse.move(a.x + k * 12, a.y + Math.sin(k) * 15);
      await p.mouse.up();
    }
    await p.keyboard.press("Escape");
    await p.keyboard.press("v");
    await waitFor(() => watcher.entries.size >= 3, { timeout: 15_000 });
    const boardOf = () => applyOperations(structuredClone(world.initialWorkspace), [...watcher.entries.values()].sort((a, b) => a.seq - b.seq).flatMap((e) => e.ops));
    const lastSent = (n) => (watcher.entries.size > n ? summarize([...watcher.entries.values()].sort((a, b) => a.seq - b.seq).at(-1).ops) : "nothing");
    const pressZ = async () => {
      const n = watcher.entries.size;
      await p.keyboard.press("Control+z");
      await waitFor(() => watcher.entries.size > n, { timeout: 4_000 }).catch(() => {});
      return lastSent(n);
    };
    const confirmBar = () => p.getByRole("alertdialog", { name: "Confirm undo" });
    await p.keyboard.press("Escape");
    const z1 = await pressZ();
    const z2 = await pressZ();
    r.check(
      "on a fresh board, Ctrl+Z removes the strokes one at a time before touching the AI build",
      z1 === "DELETE_SHAPE×1" && z2 === "DELETE_SHAPE×1" && Object.keys(boardOf().nodes).length === built,
      `${z1} · ${z2}`,
    );
    // The next step would take the whole AI build away: it must ask first.
    const z3 = await pressZ();
    const asked = await confirmBar().isVisible().catch(() => false);
    const barText = asked ? ((await confirmBar().textContent()) ?? "") : "";
    r.check(
      "a Ctrl+Z that would remove the whole AI build asks first and removes nothing yet",
      z3 === "nothing" && asked && Object.keys(boardOf().nodes).length === built,
      asked ? barText.slice(0, 140) : `sent ${z3}, no confirmation shown`,
    );
    await shot(p, dir, "undo-fresh-confirm");
    await p.keyboard.press("Escape");
    await sleep(500);
    r.check(
      "Esc keeps the board (no undo sent, bar gone)",
      !(await confirmBar().isVisible().catch(() => false)) && Object.keys(boardOf().nodes).length === built,
    );
    // Asked again, and this time confirmed with a second press.
    await pressZ();
    const z4 = await pressZ();
    const emptied = boardOf();
    const heroShown = (await p.getByLabel("Describe what you want to build").count()) > 0;
    const banner = await p.getByText("Everything on this board was undone.").count();
    r.check(
      "a second Ctrl+Z confirms: the AI build is undone, the canvas stays and offers Redo",
      /DELETE_NODE×/.test(z4) && Object.keys(emptied.nodes).length === 0 && !heroShown && banner > 0,
      `${z4} → ${Object.keys(emptied.nodes).length} nodes; start screen ${heroShown ? "shown" : "not shown"}, redo banner ${banner ? "shown" : "missing"}`,
    );
    const redoTrail = [];
    for (let i = 1; i <= 3; i++) {
      const n = watcher.entries.size;
      await p.keyboard.press("Control+y");
      await waitFor(() => watcher.entries.size > n, { timeout: 6_000 }).catch(() => {});
      redoTrail.push(lastSent(n));
    }
    const restored = boardOf();
    r.check(
      "Ctrl+Y brings the AI build and both strokes back",
      Object.keys(restored.nodes).length === built && Object.keys(restored.shapes).length === 2,
      `${redoTrail.join(" · ")} → ${Object.keys(restored.nodes).length}/${built} nodes, ${Object.keys(restored.shapes).length}/2 strokes`,
    );
    await shot(p, dir, "undo-fresh-after-y");
    watcher.close();
    await gotoBoard(p, stack.webUrl, world.boardId, { lens: "visual" });
  });

  // --- The same on a LOCAL board (a new user's first, unshared board) ---------
  await r.guard("local board: build, draw, undo past everything, redo", async () => {
    const fay = world.p("Fay");
    const pg = await openAs(ctx.browser, fay, { baseUrl: stack.webUrl, report: r });
    await pg.goto(`${stack.webUrl}/?view=canvas`, { waitUntil: "domcontentloaded" });
    const hero = pg.getByLabel("Describe what you want to build");
    await hero.waitFor({ timeout: 30_000 });
    await hero.fill("An e-commerce platform with Stripe payments");
    await hero.press("Enter");
    r.count("real AI calls (generate)");
    await pg.locator(".node").first().waitFor({ timeout: 150_000 });
    await sleep(1500);
    const vb = await pg.locator(".canvas-viewport").boundingBox();
    const count = async () => ({
      nodes: await pg.locator(".node").count(),
      shapes: await pg.locator(".shape").count(),
      hero: (await pg.getByLabel("Describe what you want to build").count()) > 0,
      url: pg.url().replace(stack.webUrl, ""),
    });
    for (const fy of [0.2, 0.35]) {
      await pg.keyboard.press("Escape");
      await pg.keyboard.press("p");
      const a = { x: vb.x + vb.width * 0.85, y: vb.y + vb.height * fy };
      await pg.mouse.move(a.x, a.y);
      await pg.mouse.down();
      for (let k = 1; k <= 10; k++) await pg.mouse.move(a.x + k * 12, a.y + Math.sin(k) * 15);
      await pg.mouse.up();
    }
    await pg.keyboard.press("Escape");
    await pg.keyboard.press("v");
    await sleep(800);
    const start = await count();
    const trail = [];
    for (let i = 1; i <= 5; i++) {
      // Z#3 only stages the big undo (and the next Escape keeps the board);
      // from Z#4 on, a second press confirms.
      await pg.keyboard.press("Escape");
      await pg.keyboard.press("Control+z");
      if (i >= 4) await pg.keyboard.press("Control+z");
      await sleep(900);
      trail.push({ i, ...(await count()) });
    }
    await shot(pg, dir, "undo-local-after-z");
    const emptied = trail.find((t) => t.nodes === 0 && t.shapes === 0);
    const banner = await pg.getByText("Everything on this board was undone.").count();
    r.check(
      "undoing to an empty board keeps the canvas and offers Redo, instead of the start screen",
      !!emptied && !emptied.hero && banner > 0,
      emptied ? `start screen ${emptied.hero ? "shown" : "not shown"}, redo banner ${banner ? "shown" : "missing"}` : "the board never emptied",
    );
    // A person on the start screen clicks into it — then tries to get the board back.
    const onStart = await pg.getByLabel("Describe what you want to build").count();
    if (onStart) await pg.getByLabel("Describe what you want to build").click();
    const redo = [];
    for (let i = 1; i <= 3; i++) {
      await pg.keyboard.press("Control+y");
      await sleep(900);
      redo.push({ i, ...(await count()) });
    }
    await shot(pg, dir, "undo-local-after-y");
    r.note(
      `local board: start ${start.nodes} nodes / ${start.shapes} shapes · ` +
        trail.map((t) => `Z#${t.i} → ${t.nodes}n ${t.shapes}s${t.hero ? " START SCREEN" : ""}`).join(" · ") +
        ` · (clicked into the start screen) ` +
        redo.map((t) => `Y#${t.i} → ${t.nodes}n ${t.shapes}s${t.hero ? " START SCREEN" : ""}`).join(" · "),
    );
    r.check(
      "local board: the Ctrl+Z that would remove the AI build only asks — nothing removed",
      trail[2].nodes === start.nodes,
      `${trail[2].nodes}/${start.nodes} nodes after the third press`,
    );
    r.check(
      "local board: Ctrl+Z takes the strokes off one at a time first",
      trail[0].shapes === start.shapes - 1 && trail[0].nodes === start.nodes && trail[1].shapes === start.shapes - 2,
      trail.slice(0, 2).map((t) => `${t.nodes}n ${t.shapes}s`).join(" · "),
    );
    const last = redo.at(-1);
    r.check(
      "local board: after undoing to an empty board, Ctrl+Y gets the board back even if the start screen took focus",
      last.nodes === start.nodes && last.shapes === start.shapes,
      `${last.nodes}/${start.nodes} nodes, ${last.shapes}/${start.shapes} shapes${last.hero ? ", still on the start screen" : ""}`,
      last.nodes === start.nodes
        ? {}
        : { known: "an empty board swaps the canvas for the start screen (CanvasView.tsx:3359-3365); its prompt takes the keys and the canvas shortcut ignores text fields (CanvasView.tsx:634), so Ctrl+Y can't reach the redo stack" },
    );
    await pg.context().close();
    fay.page = null;
  });

  // --- After a reload there is nothing of Gus's to undo ------------------------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".node").first().waitFor({ timeout: 30_000 });
  await sleep(1500);
  const n1 = mine().length;
  for (let i = 0; i < 3; i++) await press("Control+z");
  await sleep(2500);
  const afterReload = mine().slice(n1);
  r.check(
    "after a reload, Ctrl+Z has nothing to undo and sends nothing",
    afterReload.length === 0,
    afterReload.map((e) => summarize(e.ops)).join(" | "),
  );
}
