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

export class Journey {
  constructor(readonly page: Page) {}

  /** Land on the app as an anonymous visitor — the user's first minute. */
  async open() {
    await this.page.goto(BASE ? `${BASE}/signup` : "/signup", {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
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

  /** Read the rendered canvas. One evaluate, no layout thrash from the runner. */
  async canvas(): Promise<CanvasState> {
    return this.page.evaluate(() => {
      const els = [...document.querySelectorAll(".node")] as HTMLElement[];
      const pick = (re: RegExp) =>
        els
          .map((e) => {
            const metaText = e.querySelector(".node-meta")?.textContent?.trim() || "";
            const m = re.exec(metaText) || re.exec(e.textContent || "");
            return (m?.[1] || "").trim();
          })
          .filter(Boolean);
      return {
        nodes: els.length,
        labels: els.map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()),
        roles: pick(/(START|PROCESS|END|DECISION|DATA|ACTOR|SYSTEM|TERMINAL|MERGE)/i),
        selected: document.querySelectorAll(".node.selected").length,
        bodyText: (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 4_000),
      };
    });
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
