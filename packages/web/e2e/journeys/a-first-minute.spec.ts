import { expect, test } from "./fixtures";

/**
 * Scenario A — The first minute.
 *
 * "Think out loud. Build visually." This is the product's whole promise, so it is
 * the scenario that gets the strictest assertions and the most honest failure
 * messages. If only one of these passes, the suite is worth running.
 */

test.describe("A · the first minute", () => {
  test("a run against a mock provider is not a pass", async ({ journey, page }) => {
    // A mock run proves the reducer is correct. It cannot prove the product
    // works, and reporting one as a pass is the specific dishonesty this guard
    // exists to prevent. Opt in loudly via SCENARIOS_ALLOW_MOCK=1.
    if (process.env.SCENARIOS_ALLOW_MOCK === "1") {
      test.skip(true, "mock explicitly allowed for a fast inner-loop run");
    }

    await journey.signUp("Provider Probe");
    // `/health` is deliberately minimal — the provider name lives behind the
    // authenticated metrics route precisely so a public probe learns nothing.
    // Read it from inside the signed-in session, the way an operator would.
    const info = await page.evaluate(async () => {
      const r = await fetch("/api/metrics", { credentials: "include" });
      return r.ok ? await r.json() : { error: r.status };
    });

    expect(
      (info as { provider?: string }).provider,
      `could not read the provider from /api/metrics: ${JSON.stringify(info)}`,
    ).toBeTruthy();
    expect(
      String((info as { provider: string }).provider).toLowerCase(),
      "this suite ran against the MOCK provider; the results prove only the " +
        "reducer. Re-run with real credentials, or set SCENARIOS_ALLOW_MOCK=1 " +
        "if that is what you intended.",
    ).not.toBe("mock");
  });

  test("signup → prompt → a semantically correct diagram", async ({ journey, errors, page }) => {
    // Capture the wire payload. The "no AI-authored coordinates" claim is about
    // what the model SENT, not about where things ended up on screen — a renderer
    // bug could disguise a coordinate leak, and a passing render could too.
    const payloads: string[] = [];
    page.on("response", async (res) => {
      if (res.url().includes("/api/generate") && res.ok()) {
        payloads.push(await res.text().catch(() => ""));
      }
    });

    await journey.signUp();
    const after = await journey.ask(
      "A five-step onboarding flow: sign up, verify email, choose plan, invite team, first login",
    );

    // 1. It produced something.
    expect(
      after.nodes,
      `no nodes rendered. Page said: "${after.bodyText.slice(0, 300)}"`,
    ).toBeGreaterThanOrEqual(3);

    // 2. Every node is labelled. A blank card is not a diagram.
    const labelled = after.labels.filter((l) => l.replace(/^[A-Z_]+/, "").trim().length > 0);
    expect(labelled.length, `unlabelled nodes: ${JSON.stringify(after.labels)}`).toBe(after.nodes);

    // 3. THE SEMANTIC CLAIM. Five grey boxes in a row is not the product; the
    //    roles are. This is the one assertion that tests the product rather
    //    than the render.
    const roles = after.roles.map((r) => r.toUpperCase());
    expect(
      roles.length,
      `no semantic roles found — the diagram is a picture, not a model: ${JSON.stringify(after.labels)}`,
    ).toBeGreaterThanOrEqual(3);
    expect(
      roles.some((r) => r === "START"),
      `no START step in: ${roles.join(",")}`,
    ).toBe(true);
    expect(
      roles.some((r) => r === "END"),
      `no END step in: ${roles.join(",")}`,
    ).toBe(true);

    // 4. THE ARCHITECTURAL NON-NEGOTIABLE. The LLM must not author geometry;
    //    the layout engine owns coordinates. Measured on the wire.
    const payload = payloads.join("");
    expect(payload.length, "no generate payload captured").toBeGreaterThan(0);
    const coordFields = (payload.match(/"(x|y|position)"\s*:/g) || []).length;
    expect(
      coordFields,
      `the model sent ${coordFields} coordinate field(s); layout must own geometry`,
    ).toBe(0);

    // 5. Nothing blew up in the console.
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });
});
