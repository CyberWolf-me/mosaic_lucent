#!/usr/bin/env node
/**
 * Lucent Concurrency & Workflow Load-Test Suite Runner
 *
 * Usage:
 *   node scripts/load-test/runner.mjs --profile=smoke
 *   node scripts/load-test/runner.mjs --profile=baseline
 *   node scripts/load-test/runner.mjs --profile=target
 *   node scripts/load-test/runner.mjs --profile=hot-board
 *   node scripts/load-test/runner.mjs --profile=ai-storm
 *   node scripts/load-test/runner.mjs --profile=resilience
 *   node scripts/load-test/runner.mjs --scenario=LT-02
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

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    profile: "smoke",
    scenario: null,
    target: CONFIG.TARGET_URL,
  };

  for (const arg of args) {
    if (arg.startsWith("--profile=")) {
      options.profile = arg.split("=")[1];
    } else if (arg.startsWith("--scenario=")) {
      options.scenario = arg.split("=")[1].toUpperCase();
    } else if (arg.startsWith("--target=")) {
      options.target = arg.split("=")[1];
    }
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

  console.log("============================================================");
  console.log("LUCENT CONCURRENCY & WORKFLOW LOAD-TEST RUNNER");
  console.log(`Run ID:      ${runId}`);
  console.log(`Target:      ${options.target}`);
  console.log(`Profile:     ${options.profile}`);
  console.log(`Scenario:    ${options.scenario || "All in profile"}`);
  console.log(`Artifacts:   ${CONFIG.ARTIFACT_DIR}`);
  console.log("============================================================\n");

  const tStart = Date.now();

  try {
    if (options.scenario) {
      switch (options.scenario) {
        case "LT-01":
          await runLT01(options.target, metrics, CONFIG);
          break;
        case "LT-02":
          await runLT02(options.target, metrics, CONFIG);
          break;
        case "LT-03":
          await runLT03(options.target, metrics, CONFIG);
          break;
        case "LT-04":
          await runLT04(options.target, metrics, CONFIG);
          break;
        case "LT-05":
          await runLT05(options.target, metrics, CONFIG);
          break;
        case "LT-06":
          await runLT06(options.target, metrics, CONFIG);
          break;
        case "LT-07":
          await runLT07(options.target, metrics, CONFIG);
          break;
        case "LT-08":
          await runLT08(options.target, metrics, CONFIG);
          break;
        case "LT-09":
          await runLT09(options.target, metrics, CONFIG);
          break;
        case "LT-10":
          await runLT10(options.target, metrics, CONFIG);
          break;
        case "LT-11":
          await runLT11(options.target, metrics, CONFIG);
          break;
        case "LT-12":
          await runLT12(options.target, metrics, CONFIG);
          break;
        case "LT-13":
          await runLT13(options.target, metrics, CONFIG);
          break;
        case "LT-14":
          await runLT14(options.target, metrics, CONFIG);
          break;
        case "LT-15":
          await runLT15(options.target, metrics, CONFIG);
          break;
        case "LT-16":
          await runLT16(options.target, metrics, CONFIG);
          break;
        case "LT-17":
          await runLT17(options.target, metrics, CONFIG);
          break;
        case "LT-18":
          await runLT18(options.target, metrics, CONFIG);
          break;
        default:
          console.error(`Unknown scenario: ${options.scenario}`);
          process.exit(1);
      }
    } else {
      switch (options.profile) {
        case "smoke":
          await runSmoke(options.target, metrics, CONFIG);
          break;
        case "baseline":
          await runBaseline(options.target, metrics, CONFIG);
          break;
        case "target":
          await runLT01(options.target, metrics, CONFIG);
          break;
        case "hot-board":
          await runLT02(options.target, metrics, CONFIG);
          await runLT03(options.target, metrics, CONFIG);
          break;
        case "ai-storm":
          await runLT04(options.target, metrics, CONFIG);
          await runLT05(options.target, metrics, CONFIG);
          break;
        case "workflows":
          await runLT06(options.target, metrics, CONFIG);
          await runLT07(options.target, metrics, CONFIG);
          await runLT12(options.target, metrics, CONFIG);
          await runLT13(options.target, metrics, CONFIG);
          await runLT14(options.target, metrics, CONFIG);
          break;
        case "resilience":
          await runLT08(options.target, metrics, CONFIG);
          await runLT09(options.target, metrics, CONFIG);
          await runLT10(options.target, metrics, CONFIG);
          await runLT11(options.target, metrics, CONFIG);
          await runLT15(options.target, metrics, CONFIG);
          await runLT18(options.target, metrics, CONFIG);
          break;
        case "capacity":
          await runLT16(options.target, metrics, CONFIG);
          await runLT17(options.target, metrics, CONFIG);
          break;
        case "all":
          await runSmoke(options.target, metrics, CONFIG);
          await runBaseline(options.target, metrics, CONFIG);
          await runLT01(options.target, metrics, CONFIG);
          await runLT02(options.target, metrics, CONFIG);
          await runLT03(options.target, metrics, CONFIG);
          await runLT04(options.target, metrics, CONFIG);
          await runLT05(options.target, metrics, CONFIG);
          await runLT06(options.target, metrics, CONFIG);
          await runLT07(options.target, metrics, CONFIG);
          await runLT08(options.target, metrics, CONFIG);
          await runLT09(options.target, metrics, CONFIG);
          await runLT10(options.target, metrics, CONFIG);
          await runLT11(options.target, metrics, CONFIG);
          await runLT12(options.target, metrics, CONFIG);
          await runLT13(options.target, metrics, CONFIG);
          await runLT14(options.target, metrics, CONFIG);
          await runLT15(options.target, metrics, CONFIG);
          await runLT16(options.target, metrics, CONFIG);
          await runLT17(options.target, metrics, CONFIG);
          await runLT18(options.target, metrics, CONFIG);
          break;
        default:
          console.error(`Unknown profile: ${options.profile}`);
          process.exit(1);
      }
    }
  } catch (err) {
    console.error("\n[FATAL ERROR IN RUNNER]", err);
    metrics.recordError("RunnerMain", err);
  } finally {
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
}

main();
