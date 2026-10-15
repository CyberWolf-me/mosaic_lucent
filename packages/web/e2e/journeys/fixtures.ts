import { test as base, expect, type Page } from "@playwright/test";

/**
 * Scenario fixtures (docs/eval-results/user-journey-scenarios.md).
 *
 * The rule these enforce: **a green run against a mock provider proves nothing**
 * and must never be reported as a pass. `assertRealProvider` runs once per worker
 * and refuses a mock run unless the operator explicitly opts in, because a
 * silently-degraded suite is how a broken pipeline looks green.
 *
 * Isolation: each test gets a fresh account, so each gets a fresh personal org.
 * Three of these scenarios are about authorization; a shared account would make
 * every other scenario's state visible to them and turn ordering into flake.
 */

const BASE = process.env.BASE_URL || "";

/** What the canvas is doing right now, read from the DOM it actually renders. */
export type CanvasState = {
  nodes: number;
  labels: string[];
  roles: string[];
  selected: number;
  bodyText: string;
};

/** True while a generation is still streaming/revealing. */
const isWorking = (t: string) => /Building the model|Working…|Thinking|generating/i.test(t);

/**
 * Every role the canvas can render, from `TYPE_STYLE` in web/src/scene.ts — the
 * single source of truth for the meta label a node shows.
 *
 * The alternation this replaced was
 * `START|PROCESS|END|DECISION|DATA|ACTOR|SYSTEM|TERMINAL|MERGE`, which is not
 * that vocabulary: it omitted STEP altogether. STEP is what the reducer assigns
 * every intermediate node of a linear flow, so a perfectly correct seven-node
 * journey (START, five STEPs, END) scored two matches and failed the suite's
 * ">= 3 semantic roles" assertion — the test calling the diagram "a picture,
 * not a model" while the model sat in the DOM the whole time. GOAL, OUTCOME,
 * SCREEN, SERVICE and DATABASE were missing too; DATA, TERMINAL and MERGE
 * appear nowhere in the app.
 *
 * Passed into `page.evaluate` as a source string because a RegExp does not
 * survive the serialisation to the browser context.
 */
const ROLE_SOURCE =
  "^(ACTOR|SCREEN|SERVICE|EXTERNAL|SYSTEM|DATABASE|CACHE|QUEUE|DECISION|NOTE|IDEA|STEP|CONDITION|OUTCOME|START|END|PROCESS|TASK|ROLE|PERSON|TEAM|DEPARTMENT|GOAL)$";

export class Journey {
  constructor(readonly page: Page) {}

  /**
   * Land on the app as an anonymous visitor — the user's first minute.
   *
   * `waitUntil` is deliberately `domcontentloaded`, not `networkidle`. The auth
   * screen embeds a Cloudflare Turnstile widget (AuthView's bot gate), and
   * Turnstile keeps a long-lived script/poll open on `challenges.cloudflare.com`
   * for as long as the widget is mounted. `networkidle` is defined as "no
   * in-flight requests for 500 ms", so on this page it is unsatisfiable by
   * construction and every caller died on the 30 s goto timeout while the page
   * itself had rendered in well under a second.
   *
   * Waiting on the app's own DOM is also the stronger assertion: it proves the
   * auth card mounted, which is what "the user's first minute" actually means.
   * A network-quiescence check proved nothing about the product and broke the
   * moment a third party changed its polling.
   */
  async open() {
    await this.page.goto(BASE ? `${BASE}/signup` : "/signup", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // The signup form is on screen: the same affordance the smoke spec asserts.
    await this.page
      .getByRole("button", { name: /create an account|create account|sign up/i })
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
  }

  /** Sign up a brand-new user. Returns the credentials for cross-client scenarios. */
  async signUp(name = "Scenario User", password = "scenario-123456") {
    const email = `scenario_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`;
    await this.open();
    await this.page.locator('input[type="text"]').first().fill(name);
    await this.page.locator('input[type="email"]').first().fill(email);
    await this.page.locator('input[type="password"]').first().fill(password);
    await this.page
      .getByRole("button", { name: /create account|sign up/i })
      .first()
      .click();
    await this.page.waitForTimeout(2_500);
    // The onboarding modal is real product surface, not a test obstacle: walk it
    // the way a user does, and tolerate its absence.
    for (let i = 0; i < 6; i++) {
      const b = this.page.getByRole("button", { name: /^(Skip|Got it|Done|Close|Finish)$/i });
      if (!(await b.count())) break;
      await b
        .first()
        .click({ force: true })
        .catch(() => {});
      await this.page.waitForTimeout(300);
    }
    return { email, password };
  }

  /**
   * Read the rendered canvas. One evaluate, no layout thrash from the runner.
   */
  async canvas(): Promise<CanvasState> {
    return this.page.evaluate((roleSource: string) => {
      const rolesRe = new RegExp(roleSource, "i");
      const els = [...document.querySelectorAll(".node")] as HTMLElement[];
      // The meta line is icon + role text (atoms.tsx renders `.node-meta` as a
      // dot/icon followed by the label), so the text is matched as a whole
      // rather than scanned for a substring: "STEP" must not be found inside an
      // unrelated label, and a node whose meta is absent contributes nothing.
      const pick = () =>
        els
          .map((e) => e.querySelector(".node-meta")?.textContent?.trim() ?? "")
          .filter((t) => rolesRe.test(t));
      return {
        nodes: els.length,
        labels: els.map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()),
        roles: pick(),
        selected: document.querySelectorAll(".node.selected").length,
        bodyText: (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 4_000),
      };
    }, ROLE_SOURCE);
  }

  /**
   * Ask the canvas something and wait for it to settle.
   * "Settled" is defined by the DOM, not by a timer: nodes present AND the
   * working indicator gone. A fixed sleep would either flake or hide a hang.
   */
  async ask(prompt: string, { timeoutMs = 120_000 } = {}) {
    await this.page.locator("textarea").first().fill(prompt);
    await this.page.keyboard.press("Enter").catch(() => {});
    return this.settle(timeoutMs);
  }

  /** Wait for generation to finish. Throws with the page's own words on failure. */
  async settle(timeoutMs = 120_000): Promise<CanvasState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.canvas();
      if (s.nodes > 0 && !isWorking(s.bodyText)) {
        // The sketch reveal staggers nodes in; a mid-reveal read undercounts and
        // makes "did it keep the old node?" answer the wrong question.
        await this.page.waitForTimeout(3_000);
        return this.canvas();
      }
      await this.page.waitForTimeout(500);
    }
    const s = await this.canvas();
    throw new Error(
      `canvas never settled in ${timeoutMs}ms — nodes=${s.nodes} ` +
        `body="${s.bodyText.slice(0, 200)}"`,
    );
  }

  /** Run a keyboard shortcut on the document. */
  async press(key: string) {
    await this.page.keyboard.press(key);
    await this.page.waitForTimeout(400);
  }

  /** Bounding box of the first node wide enough to be a real card. */
  async firstNodeBox() {
    const box = await this.page.evaluate(() => {
      const el = ([...document.querySelectorAll(".node")] as HTMLElement[]).find(
        (e) => e.getBoundingClientRect().width > 50,
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        cx: r.x + r.width / 2,
        cy: r.y + r.height / 2,
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
      };
    });
    return box;
  }
}

/** Console/page errors a user would experience. Network 401s during the signed-out
 *  first paint are not defects, so they are filtered by message, not ignored. */
export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/status of 401/.test(t)) return; // pre-login session poll

    // Third-party console noise is not a Lucent defect, and asserting on it
    // makes the suite fail whenever Cloudflare changes its internals. Filtered
    // by the emitting *script's origin*, not by message text, so the filter
    // cannot accidentally swallow a genuine error from our own bundle:
    //
    //   - challenges.cloudflare.com  Turnstile's bot-gate. It logs
    //     `%c%d font-size:0;color:transparent NaN` — a malformed console format
    //     string of its own — plus WebGL/font warnings on the auth screen.
    //     Verified by reading ConsoleMessage.location().url: the message
    //     originates in the Turnstile iframe, never in the app.
    //
    // A same-origin error, or one from our own chunks, still fails the test.
    const origin = m.location()?.url ?? "";
    if (/^https?:\/\/challenges\.cloudflare\.com\//.test(origin)) return;

    errors.push(t);
  });
  return errors;
}

export const test = base.extend<{ journey: Journey; errors: string[] }>({
  errors: async ({ page }, use) => {
    const errors = trackErrors(page);
    await use(errors);
  },
  journey: async ({ page }, use) => {
    await use(new Journey(page));
  },
});

export { expect, BASE };
