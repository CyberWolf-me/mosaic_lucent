/**
 * Adversarial tests: spec validation, transition table, scope globs.
 * Spec Phase 6: invalid specs, unknown deps, cycles, prohibited paths,
 * file-less tasks without approvals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTaskDocument, checkTransition } from "../lib/spec.js";
import { checkScope, matchesAny } from "../lib/scope.js";
import { minimalTask } from "./helpers.mjs";

function docOf(tasks) {
  return validateTaskDocument({ spec_version: 1, tasks });
}

describe("task spec validation", () => {
  it("accepts the shipped tasks.json shape", () => {
    const { tasks, errors } = docOf([minimalTask("ENG-1")]);
    assert.equal(errors.length, 0);
    assert.equal(tasks.length, 1);
  });

  it("rejects duplicates, unknown deps, cycles, and empty criteria", () => {
    const dup = docOf([minimalTask("A-1"), minimalTask("A-1")]);
    assert.ok(dup.errors.some((e) => /duplicate task id/.test(e)));
    const unknown = docOf([minimalTask("B-1", { dependencies: ["B-9"] })]);
    assert.ok(unknown.errors.some((e) => /unknown dependency/.test(e)));
    const self = docOf([minimalTask("C-1", { dependencies: ["C-1"] })]);
    assert.ok(self.errors.some((e) => /depends on itself/.test(e)));
    const cycle = docOf([minimalTask("D-1", { dependencies: ["D-2"] }), minimalTask("D-2", { dependencies: ["D-1"] })]);
    assert.ok(cycle.errors.some((e) => /dependency cycle/.test(e)));
    const empty = docOf([minimalTask("E-1", { acceptance_criteria: [] })]);
    assert.ok(empty.errors.some((e) => /acceptance_criteria/.test(e)));
  });

  it("rejects missing commands, bad scopes, and bad retry policy", () => {
    const noCmd = docOf([minimalTask("F-1", { verification: { commands: [], required_gates: ["x"] } })]);
    assert.ok(noCmd.errors.some((e) => /verification.commands/.test(e)));
    const badScope = docOf([minimalTask("G-1", { scope: { allowed_paths: ["/abs", "../up"] } })]);
    assert.ok(badScope.errors.some((e) => /invalid allowed path/.test(e)));
    const badRetry = docOf([minimalTask("H-1", { retry_policy: { max_automatic_attempts: 99 } })]);
    assert.ok(badRetry.errors.some((e) => /max_automatic_attempts/.test(e)));
  });

  it("file-less scope is legal only with explicit approvals", () => {
    const bare = docOf([minimalTask("I-1", { scope: { allowed_paths: [] } })]);
    assert.ok(bare.errors.some((e) => /file-less scope requires/.test(e)));
    const gated = docOf([
      minimalTask("I-2", { scope: { allowed_paths: [] }, required_approvals: ["founder:push"] }),
    ]);
    assert.equal(gated.errors.length, 0);
  });
});

describe("central transition table", () => {
  it("workers can claim and submit, nothing more", () => {
    assert.equal(checkTransition("ready", "in_progress", "worker"), null);
    assert.equal(checkTransition("in_progress", "review", "worker"), null);
    assert.ok(checkTransition("review", "integration", "worker"));
    assert.ok(checkTransition("integration", "verified", "worker"));
    assert.ok(checkTransition("verified", "done", "worker"));
  });

  it("reviewers integrate or return work; integrators verify", () => {
    assert.equal(checkTransition("review", "integration", "reviewer"), null);
    assert.equal(checkTransition("review", "in_progress", "reviewer"), null);
    assert.equal(checkTransition("integration", "verified", "integrator"), null);
    // The integrator executes an accepted review; the ACCEPT record itself
    // is still required (store.js guard, pinned in store.test.mjs).
    assert.equal(checkTransition("review", "integration", "integrator"), null);
    assert.ok(checkTransition("review", "integration", "worker"));
  });

  it("unknown states and jumps fail closed", () => {
    assert.ok(checkTransition("backlog", "done", "cto"));
    assert.ok(checkTransition("nope", "ready", "cto"));
    assert.ok(checkTransition("ready", "nope", "cto"));
  });
});

describe("scope enforcement", () => {
  it("glob shapes used in tasks.json behave", () => {
    assert.ok(matchesAny("packages/server/src/app.ts", ["packages/server/src/**"]));
    assert.ok(matchesAny("packages/ai/test/x.test.ts", ["packages/ai/**"]));
    assert.ok(!matchesAny("docs/x.md", ["packages/**"]));
    assert.ok(matchesAny(".env", [".env", ".env.*"]));
    assert.ok(!matchesAny(".env.production", [".env"]));
    assert.ok(matchesAny("a/b/c.txt", ["a/**/c.txt"]));
  });

  it("prohibited wins; outside-allowed is a violation", () => {
    const task = minimalTask("S-1", {
      scope: { allowed_paths: ["packages/server/**"], prohibited_paths: ["packages/server/migrations/**"] },
    });
    assert.ok(checkScope(task, ["packages/server/src/app.ts"]).ok);
    const bad = checkScope(task, ["packages/server/migrations/0001.sql", "docs/x.md"]);
    assert.equal(bad.ok, false);
    assert.equal(bad.violations.length, 2);
    assert.ok(bad.violations[0].includes("prohibited"));
    assert.ok(bad.violations[1].includes("outside allowed"));
  });
});
