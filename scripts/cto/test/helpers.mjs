/** Shared fixtures for the control-plane adversarial suite (node:test). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpCto() {
  return mkdtempSync(join(tmpdir(), "cto-test-"));
}

export function specs(...tasks) {
  return new Map(tasks.map((t) => [t.id, t]));
}

export function minimalTask(id, overrides = {}) {
  return {
    id,
    title: `task ${id}`,
    description: "test task",
    owner_role: "implementation",
    dependencies: [],
    scope: { allowed_paths: ["packages/**"], prohibited_paths: [".env"] },
    acceptance_criteria: ["done for real"],
    verification: { commands: [{ command: "true", cwd: "." }], required_gates: ["relevant_tests"] },
    deliverables: ["evidence"],
    risk: "low",
    required_approvals: [],
    retry_policy: { max_automatic_attempts: 2 },
    ...overrides,
  };
}
