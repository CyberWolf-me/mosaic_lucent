/**
 * The eval runner CLI: `npm run evals -w @lucent/ai`.
 *
 * With no provider key set, scores MockProvider — which must pass 1.0, so a
 * red run here means the harness or the golden set is broken, not the model.
 * With a key, swap the provider at the top to score the real thing; the case
 * list and the gate are the same, which is the point.
 */
import { MockProvider } from "../src/providers/mock.js";
import { GOLDEN_SET } from "../src/golden.js";
import { runGoldenSet } from "../src/evals.js";

const THRESHOLD = 1.0;

const provider = new MockProvider();
const report = await runGoldenSet(provider, GOLDEN_SET);

for (const result of report.results) {
  const mark = result.ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${result.id}`);
  for (const reason of result.reasons) console.log(`      ${reason}`);
}
console.log(
  `\n${report.passed}/${report.total} golden cases pass (score ${report.score.toFixed(2)})`,
);
if (report.score < THRESHOLD) {
  console.error(`eval gate: score ${report.score.toFixed(2)} is below ${THRESHOLD}`);
  process.exit(1);
}
