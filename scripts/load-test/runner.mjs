#!/usr/bin/env node
/**
 * Lucent Concurrency & Workflow Load-Test Suite Runner
 *
 * Usage:
 *   node scripts/load-test/runner.mjs --profile=smoke
 *   node scripts/load-test/runner.mjs --profile=all
 *   node scripts/load-test/runner.mjs --scenario=LT-02
 *   node scripts/load-test/runner.mjs --profile=resilience --target=http://127.0.0.1:4387
 *
 * Profiles run their scenarios in order; each scenario is ISOLATED — a throw is
 * recorded and the suite continues, so one failing scenario never aborts the rest.
 */

import { CONFIG, assertNonProd } from "./config.mjs";
import { MetricsCollector } from "./metrics.mjs";
import {
  runSmoke,
  runBaseline,
  runLT01,
  runLT02,
  runLT03,
  runLT04,
  runLT05,
  runLT06,
  runLT07,
  runLT08,
  runLT09,
  runLT10,
  runLT11,
  runLT12,
  runLT13,
  runLT14,
  runLT15,
  runLT16,
  runLT17,
  runLT18,
} from "./scenarios.mjs";

const SCENARIOS = {
  smoke: runSmoke,
  baseline: runBaseline,
  "LT-01": runLT01,
  "LT-02": runLT02,
  "LT-03": runLT03,
  "LT-04": runLT04,
  "LT-05": runLT05,
  "LT-06": runLT06,
  "LT-07": runLT07,
  "LT-08": runLT08,
  "LT-09": runLT09,
  "LT-10": runLT10,
  "LT-11": runLT11,
  "LT-12": runLT12,
  "LT-13": runLT13,
  "LT-14": runLT14,
  "LT-15": runLT15,
  "LT-16": runLT16,
  "LT-17": runLT17,
  "LT-18": runLT18,
};

const ALL = Object.keys(SCENARIOS);

const PROFILES = {
  smoke: ["smoke"],
  baseline: ["baseline"],
  target: ["LT-01"],
  "hot-board": ["LT-02", "LT-03"],
  "ai-storm": ["LT-04", "LT-05"],
  workflows: ["LT-06", "LT-07", "LT-12", "LT-13", "LT-14"],
  resilience: ["LT-08", "LT-09", "LT-10", "LT-11", "LT-15", "LT-18"],
  capacity: ["LT-16", "LT-17"],
  all: ALL,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { profile: "smoke", scenario: null, target: CONFIG.TARGET_URL };
  for (const arg of args) {
    if (arg.startsWith("--profile=")) options.profile = arg.split("=")[1];
    else if (arg.startsWith("--scenario=")) options.scenario = arg.split("=")[1].toUpperCase();
    else if (arg.startsWith("--target=")) options.target = arg.split("=")[1];
  }
  return options;
}

async function main() {
  const options = parseArgs();

  // SAFETY GATE: hard-block production / non-loopback targets before any load.
  try {
    assertNonProd(options.target);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exit(2);
  }

  const runId = `LT_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const metrics = new MetricsCollector(runId, CONFIG.ARTIFACT_DIR);

  const keys = options.scenario ? [options.scenario] : PROFILES[options.profile];
  if (!keys) {
    console.error(`Unknown profile: ${options.profile}`);
    process.exit(1);
  }

  console.log("============================================================");
  console.log("LUCENT CONCURRENCY & WORKFLOW LOAD-TEST RUNNER");
  console.log(`Run ID:      ${runId}`);
  console.log(`Target:      ${options.target}`);
  console.log(`Profile:     ${options.profile}`);
  console.log(`Scenario:    ${options.scenario || "All in profile"}`);
  console.log(`Sequence:    ${keys.join(", ")}`);
  console.log(`Artifacts:   ${CONFIG.ARTIFACT_DIR}`);
  console.log("============================================================\n");

  const tStart = Date.now();

  // Per-scenario isolation: a throw is recorded, then the suite moves on.
  for (const key of keys) {
    const fn = SCENARIOS[key];
    if (!fn) {
      console.error(`Unknown scenario key: ${key}`);
      metrics.recordError(key, new Error(`unknown scenario key ${key}`));
      continue;
    }
    try {
      await fn(options.target, metrics, CONFIG);
    } catch (err) {
      metrics.recordError(key, err);
      console.error(`\n[scenario ${key} aborted] ${err?.message || err}\n`);
    }
  }

  metrics.finish();
  const totalElapsedSec = Math.round((Date.now() - tStart) / 1000);
  console.log("\n============================================================");
  console.log(`TEST EXECUTION FINISHED (${totalElapsedSec}s)`);
  console.log("============================================================\n");

  const report = metrics.generateReport(
    `Lucent Load Test Run Report (${options.profile.toUpperCase()})`,
  );
  console.log(report);

  const hasFailures = metrics.checks.some((c) => !c.pass) || metrics.errors.length > 0;
  process.exit(hasFailures ? 1 : 0);
}

main();
