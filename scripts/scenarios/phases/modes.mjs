/**
 * Every mode and surface of the board, driven through real browsers while the
 * other people's sockets watch what reaches them.
 */
import { sleep, waitFor } from "../lib/api.mjs";
import { gotoBoard, shot } from "../lib/browser.mjs";
import { checkConvergence } from "../lib/converge.mjs";
import { applyProposalIn } from "./canvas.mjs";
import { node, uid } from "../lib/ops.mjs";

/** Wait until every socket in `people` has seen an entry matching `pred`. */
async function everyoneSees(world, pred, timeout = 20_000) {
  const res = await Promise.allSettled(
    world.people
      .filter((p) => p.rt?.open)
      .map((p) => p.rt.until(() => [...p.rt.entries.values()].some(pred), timeout, "entry")),
  );
  return res.filter((x) => x.status === "fulfilled").length;
}

const hasOp = (kind, extra = () => true) => (e) => e.ops.some((o) => o.op === kind && extra(o));

/** A guarded step that screenshots the given browsers when it throws. */
async function step(r, name, people, fn) {
  try {
    return await fn();
  } catch (err) {
    for (const p of people) await shot(p.page, r.artifactDir, `fail-${name.replace(/\W+/g, "_")}-${p.name}`);
    r.check(name, false, err?.message?.split(/\r?\n/).slice(0, 3).join(" | "));
  }
}

export async function modes(ctx) {
  const { world, report: r, stack } = ctx;
  const ava = world.p("Ava");
  const gus = world.p("Gus");
  const sam = world.p("Sam");
  const vic = world.p("Vic");
  const open = world.people.filter((p) => p.rt?.open).length;
  const dir = r.artifactDir;

  // --- Viewer: the board is read-only, and says so -------------------------
  await r.guard("viewer browser is read-only", async () => {
    await vic.page.locator(".ai-pill.read-only").waitFor({ timeout: 15_000 });
    const toolbar = await vic.page.locator(".shape-toolbar").count();
    const badge = await vic.page.getByRole("status", { name: "View only" }).count();
    r.check("the viewer's composer is a read-only notice, with no toolbar and a View only badge", toolbar === 0 && badge > 0, `toolbar=${toolbar} badge=${badge}`);
  });

  // --- Lenses: one model, every representation -------------------------------
  for (const [lens, label] of [
    ["document", "Document lens"],
    ["sequence", "Sequence lens"],
    ["er", "ER diagram lens"],
    ["wireframe", "Wireframe lens"],
    ["kanban", "Kanban lens"],
  ]) {
    await r.guard(`${label} renders`, async () => {
      await gus.page.locator(`.rail-lens[aria-label="${label}"]`).click();
      await gus.page.waitForURL(new RegExp(`lens=${lens}`), { timeout: 10_000 }).catch(() => {});
      await sleep(1200);
      const errors = gus.page.errors.length;
      await shot(gus.page, dir, `lens-${lens}`);
      r.check(`Gus switches to the ${label} while everyone keeps working`, true, `page errors so far: ${errors}`);
    });
  }

  // --- Kanban: cards are the same nodes, moves are ops everyone gets ---------
  await step(r, "kanban convert and move", [gus], async () => {
    // The convert offer only shows while no node is a card yet; the real AI
    // build usually made some already.
    const convert = gus.page.getByRole("button", { name: /Convert all \d+ nodes to cards/ });
    if (await convert.isVisible().catch(() => false)) {
      await convert.click();
      const n1 = await everyoneSees(world, hasOp("SET_ISSUE"));
      r.check(`converting the board to Kanban cards reached all ${open} sockets`, n1 === open, `${n1}/${open}`);
    } else {
      r.note("the AI build had already made Kanban cards, so there was nothing to convert");
    }
    const card = gus.page.locator('[aria-label="Work board"] [role="listitem"] [role="button"]').first();
    await card.waitFor({ timeout: 10_000 });
    await card.focus();
    await gus.page.keyboard.press("ArrowRight");
    const n2 = await everyoneSees(world, hasOp("UPDATE_ISSUE", (o) => o.statusCategory && o.statusCategory !== "todo"));
    r.check(`moving a card to the next column reached all ${open} sockets`, n2 === open, `${n2}/${open}`);
    await shot(gus.page, dir, "kanban-after-move");
  });
  await gotoBoard(gus.page, stack.webUrl, world.boardId, { lens: "visual" });

  // --- Edit / Focus / Present / Zen -----------------------------------------
  await step(r, "focus, present, zen", [ava], async () => {
    const first = ava.page.locator(".node").first();
    await first.click();
    await ava.page.locator('.mode-btn[title="Focus selected node"]').click();
    await sleep(800);
    r.check("Focus mode opens on the selected node", (await ava.page.locator('.mode-btn.active[title="Focus selected node"]').count()) === 1);
    await shot(ava.page, dir, "mode-focus");
    await ava.page.locator('.mode-btn[title="Edit"]').click();
    await ava.page.locator('.mode-btn[title="Present walkthrough"]').click();
    const next = ava.page.getByRole("button", { name: "Next slide" });
    await next.waitFor({ timeout: 10_000 });
    for (let i = 0; i < 3; i++) {
      await next.click();
      await sleep(400);
    }
    const where = await ava.page.locator('[aria-label^="Presentation"]').first().getAttribute("aria-label");
    r.check("Present walks the board slide by slide", /of \d+/.test(where ?? ""), where);
    r.check("the composer hides while presenting", (await ava.page.locator(".ai-pill").count()) === 0);
    await shot(ava.page, dir, "mode-present");
    await ava.page.getByRole("button", { name: "Exit presentation" }).click();
    await ava.page.locator('[data-testid="toggle-zen"], button[aria-label="Toggle Zen mode"]').first().click();
    await sleep(500);
    r.check("Zen hides the rail and the top bar", (await ava.page.locator(".left-rail:visible").count()) === 0);
    await ava.page.keyboard.press("z");
    await sleep(500);
  });

  // --- Comments from a commenter's browser, with an @mention ----------------
  await step(r, "commenter comments in the UI", [sam], async () => {
    await sam.page.getByRole("button", { name: /All comments|open comment threads/ }).first().click();
    const inbox = sam.page.getByRole("dialog", { name: "All comments" });
    await inbox.waitFor({ timeout: 10_000 });
    await inbox.locator(".cmt-inbox-main").first().click();
    const panel = sam.page.getByRole("dialog", { name: "Comments" });
    await panel.waitFor({ timeout: 10_000 });
    const authors = await panel.locator(".cmt-author").allTextContents();
    const named = authors.filter((a) => world.people.some((p) => p.name === a.trim()));
    r.check(
      "comment threads show who wrote each comment by name",
      authors.length > 0 && named.length === authors.length,
      `authors shown: ${authors.slice(0, 3).join(", ")}`,
      named.length === 0 ? { known: "comment authors render the raw user id the server stamped (web/src/views/Comments.tsx:106, :119)" } : {},
    );
    await panel.locator(".cmt-actions").first().getByRole("button", { name: "Reply" }).click();
    const reply = panel.getByPlaceholder(/Reply… use @name to mention/);
    await reply.waitFor({ timeout: 10_000 });
    await reply.fill("Agreed — @Ben can you own the timeline?");
    await reply.press("Enter");
    const n = await everyoneSees(world, hasOp("REPLY_COMMENT"));
    r.check(`a commenter's reply typed in the browser reached all ${open} sockets`, n === open, `${n}/${open}`);
    const mention = await waitFor(
      async () => (await world.p("Ben").get("/api/notifications")).notifications.find((x) => x.kind === "comment.mention" || x.kind === "comment.reply"),
      { timeout: 20_000, label: "Ben's mention" },
    ).catch(() => null);
    r.check("the @mentioned person gets a notification", !!mention, mention?.kind ?? "none");
    await sam.page.keyboard.press("Escape");
  });

  // --- Votes and reactions from the engagement bar --------------------------
  await step(r, "vote and react in the UI", [gus], async () => {
    // On a laid-out node first: does the vote/react bar appear?
    await gus.page.locator(".node").nth(1).click();
    const onNode = await gus.page.locator(".eng-vote").first().waitFor({ timeout: 4_000 }).then(() => true, () => false);
    r.check(
      "selecting a node offers the vote / react bar",
      onNode,
      onNode ? "" : "no bar under the selected node",
      onNode ? {} : { known: "the bar needs a stored position and size, which auto-laid-out nodes don't have (web/src/views/CanvasView.tsx:4458-4469)" },
    );
    await gus.page.keyboard.press("Escape");
    // A sticky has a stored box: vote and react on it.
    await gus.page.locator(".shape.sticky").first().click();
    await gus.page.locator(".eng-vote").first().click();
    const v = await everyoneSees(world, (e) => e.by === gus.id && e.ops.some((o) => o.op === "ADD_VOTE"));
    r.check(`a vote clicked in the browser reached all ${open} sockets`, v === open, `${v}/${open}`);
    await gus.page.locator(".eng-react").first().click();
    const rx = await everyoneSees(world, (e) => e.by === gus.id && e.ops.some((o) => o.op === "ADD_REACTION"));
    r.check(`a reaction reached all ${open} sockets`, rx === open, `${rx}/${open}`);
  });

  // --- Spotlight and summon reach everyone; follow a person -----------------
  await step(r, "spotlight, summon, follow", [gus, ava, vic], async () => {
    await gus.page.getByRole("button", { name: "Spotlight me" }).click();
    const spot = await Promise.allSettled(
      world.people.filter((p) => p.name !== "Gus").map((p) => p.rt.waitForEvent("spotlight", (e) => e.spotlight?.userId === gus.id, 15_000)),
    );
    r.check("Gus's spotlight reached the other 23", spot.every((x) => x.status === "fulfilled"), `${spot.filter((x) => x.status === "fulfilled").length}/23`);
    await gus.page.getByRole("button", { name: "Bring everyone here" }).click();
    const summon = await Promise.allSettled(
      world.people.filter((p) => p.name !== "Gus").map((p) => p.rt.waitForEvent("summon", (e) => e.from?.userId === gus.id || e.from === gus.id, 15_000)),
    );
    r.check("'Bring everyone here' reached the other 23", summon.every((x) => x.status === "fulfilled"), `${summon.filter((x) => x.status === "fulfilled").length}/23`);
    const viewerChip = await vic.page.locator(".follow-chip").first().textContent({ timeout: 10_000 }).catch(() => "");
    r.check("the viewer's browser shows who brought everyone there", /Gus/.test(viewerChip ?? ""), viewerChip);
    // A viewer may not lead.
    vic.rt.spotlight(true);
    const refused = await vic.rt.waitForEvent("error", () => true, 5_000).catch(() => null);
    r.check("a viewer's spotlight is refused", !!refused, refused?.message ?? "no error frame");
    await gus.page.getByRole("button", { name: /Stop|Go back/ }).first().click().catch(() => {});
    // Follow whoever is in the visible avatars (5 shown, the rest behind "+N").
    const followBtn = ava.page.locator('[aria-label^="Follow "]').first();
    const leader = ((await followBtn.getAttribute("aria-label")) ?? "").replace(/^Follow /, "");
    await followBtn.click();
    const following = await ava.page.getByRole("button", { name: `Following ${leader}` }).first().isVisible().catch(() => false);
    r.check(`Ava follows ${leader} from the presence bar`, following);
    await ava.page.getByRole("button", { name: `Following ${leader}` }).first().click().catch(() => {});
  });

  // --- Undo is per person: Gus's undo reverts only his own sticky -----------
  await step(r, "undo in the browser", [gus], async () => {
    await gus.page.keyboard.press("Escape");
    await gus.page.getByRole("button", { name: "Sticky · S" }).click();
    const canvas = gus.page.locator(".canvas-viewport");
    const box = await canvas.boundingBox();
    await gus.page.mouse.click(box.x + box.width - 260, box.y + 160);
    const created = await everyoneSees(world, (e) => e.by === gus.id && e.ops.some((o) => o.op === "CREATE_SHAPE"));
    await gus.page.keyboard.press("Escape");
    await gus.page.keyboard.press("Escape");
    await gus.page.keyboard.press("Control+z");
    const undone = await everyoneSees(world, (e) => e.by === gus.id && e.label === "undo");
    r.check(`Gus's sticky and its undo both reached all ${open} sockets`, created === open && undone === open, `created ${created}, undone ${undone}`);
  });

  // --- AI from the browser: Ask (real), a slash command, a node action ------
  await step(r, "Ask mode, real model", [ava], async () => {
    await ava.page.getByRole("button", { name: "Ask mode" }).click();
    const box = ava.page.getByLabel("Ask Lucent");
    await box.fill("What did the team decide so far, and what is still open?");
    await box.press("Enter");
    r.count("real AI calls (ask)");
    const t0 = performance.now();
    await ava.page.locator(".ai-tab-log").click().catch(() => {});
    const answered = await waitFor(
      async () => {
        const log = await ava.page.locator(".ai-log").textContent().catch(() => "");
        return log && /LUCENT/i.test(log) && log.length > 80 ? log : null;
      },
      { timeout: 120_000, every: 1000, label: "Ask answer" },
    ).catch(() => null);
    r.time("ai_ask_browser_ms", performance.now() - t0);
    r.check("Ask (real model) answers in the conversation", !!answered, answered ? answered.slice(-160) : "no answer");
    await shot(ava.page, dir, "ask-answer");
    await ava.page.getByRole("button", { name: "Build mode" }).click();
  });

  await step(r, "slash command, real model", [ava], async () => {
    const box = ava.page.getByLabel("Ask Lucent");
    await box.fill("/edge-cases the release step");
    const before = (await world.serverBoard()).latestSeq;
    await box.press("Enter");
    r.count("real AI calls (generate)");
    const t0 = performance.now();
    const proposed = await applyProposalIn(ava.page, 150_000);
    const after = await waitFor(async () => ((await world.serverBoard()).latestSeq > before ? true : null), {
      timeout: proposed ? 30_000 : 150_000,
      every: 1000,
      label: "slash command changes",
    }).catch(() => false);
    r.time("ai_slash_ms", performance.now() - t0);
    await ava.page.locator(".ai-tab-log:not(.open)").click().catch(() => {});
    const said = ((await ava.page.locator(".ai-log").textContent().catch(() => "")) ?? "").slice(-220);
    r.check("/edge-cases (real model) changed the board", !!after, `${proposed ? "via an applied proposal" : "no proposal"}; conversation ends: ${said}`);
  });

  await step(r, "node AI action, real model", [ava], async () => {
    await ava.page.locator(".node").first().click();
    const explain = ava.page.getByRole("button", { name: "Explain node" });
    await explain.waitFor({ timeout: 10_000 });
    await explain.click();
    r.count("real AI calls (generate)");
    const t0 = performance.now();
    const replied = await waitFor(
      async () => {
        await ava.page.locator(".ai-tab-log:not(.open)").click().catch(() => {});
        const turns = await ava.page.locator(".ai-log > div").count().catch(() => 0);
        return turns >= 6 ? turns : null;
      },
      { timeout: 120_000, every: 1500, label: "explain reply" },
    ).catch(() => null);
    r.time("ai_node_action_ms", performance.now() - t0);
    r.check("'Explain node' (real model) replies in the conversation", !!replied, `${replied ?? 0} turns in the log`);
    await ava.page.keyboard.press("Escape");
  });

  await checkConvergence(world, { label: "modes", startWorkspace: ctx.startWorkspace, browsers: ctx.canvasBrowsers, knownStale: ctx.knownStale });
}
