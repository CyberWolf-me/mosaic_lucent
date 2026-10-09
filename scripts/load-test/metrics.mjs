/**
 * Metrics Collector, Percentile Engine & Persistence Verification Ledger
 */
import fs from "node:fs";
import path from "node:path";

export class MetricsCollector {
  constructor(runId, artifactDir) {
    this.runId = runId;
    this.artifactDir = artifactDir;
    this.timings = new Map(); // category -> number[]
    this.counters = new Map(); // name -> number
    this.ledger = []; // { id, boardId, userId, opType, acknowledged: boolean, persisted: boolean, details }
    this.checks = []; // { name, pass: boolean, detail: string }
    this.skips = []; // { name, reason }
    this.errors = [];
    this.startTime = Date.now();
    this.endTime = null;

    if (this.artifactDir) {
      fs.mkdirSync(this.artifactDir, { recursive: true });
    }
  }

  recordCheck(name, pass, detail = "") {
    const entry = { name, pass: !!pass, detail, timestamp: Date.now() };
    this.checks.push(entry);
    const tag = pass ? "PASS" : "FAIL";
    console.log(`[${tag}] ${name} ${detail ? `(${detail})` : ""}`);
    return pass;
  }

  recordSkip(name, reason = "") {
    this.skips.push({ name, reason, timestamp: Date.now() });
    console.log(`[SKIP] ${name} ${reason ? `(${reason})` : ""}`);
  }

  recordTiming(category, durationMs) {
    if (typeof durationMs !== "number" || isNaN(durationMs)) return;
    if (!this.timings.has(category)) {
      this.timings.set(category, []);
    }
    this.timings.get(category).push(durationMs);
  }

  increment(counter, value = 1) {
    this.counters.set(counter, (this.counters.get(counter) || 0) + value);
  }

  recordError(context, error) {
    const msg = error instanceof Error ? error.message : String(error);
    this.errors.push({ context, error: msg, stack: error?.stack, timestamp: Date.now() });
    console.error(`[ERROR] [${context}]`, msg);
  }

  recordLedgerEntry(entry) {
    this.ledger.push({
      id: entry.id,
      boardId: entry.boardId,
      userId: entry.userId,
      opType: entry.opType,
      acknowledged: !!entry.acknowledged,
      persisted: !!entry.persisted,
      seq: entry.seq,
      label: entry.label,
      timestamp: Date.now(),
      mismatch: entry.mismatch || null,
    });
  }

  calculateStats(samples) {
    if (!samples || samples.length === 0) {
      return {
        count: 0,
        min: 0,
        max: 0,
        avg: 0,
        p50: null,
        p90: null,
        p95: null,
        p99: null,
        statisticallyValid: false,
      };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const avg = Math.round(sum / count);
    const min = sorted[0];
    const max = sorted[count - 1];

    if (count < 5) {
      return {
        count,
        min,
        max,
        avg,
        p50: null,
        p90: null,
        p95: null,
        p99: null,
        statisticallyValid: false,
      };
    }

    const p = (pct) => {
      const idx = Math.min(Math.floor(count * (pct / 100)), count - 1);
      return sorted[idx];
    };

    return {
      count,
      min,
      max,
      avg,
      p50: p(50),
      p90: p(90),
      p95: p(95),
      p99: p(99),
      statisticallyValid: true,
    };
  }

  getAllStats() {
    const report = {};
    for (const [cat, samples] of this.timings.entries()) {
      report[cat] = this.calculateStats(samples);
    }
    return report;
  }

  finish() {
    this.endTime = Date.now();
  }

  generateReport(title = "Lucent Concurrency & Workflow Stress Report", targets = {}) {
    if (!this.endTime) this.finish();
    const durationSec = Math.round((this.endTime - this.startTime) / 1000);
    const stats = this.getAllStats();

    const passedChecks = this.checks.filter((c) => c.pass).length;
    const failedChecks = this.checks.filter((c) => !c.pass).length;

    const totalLedger = this.ledger.length;
    const ackedLedger = this.ledger.filter((l) => l.acknowledged).length;
    const persistedLedger = this.ledger.filter((l) => l.persisted).length;
    const lostWrites = this.ledger.filter((l) => l.acknowledged && !l.persisted).length;

    // Separate verdicts
    const functionalPass = failedChecks === 0 && lostWrites === 0;

    // Performance assessment against target (default: op ack p95 <= 500ms if available)
    const opAckStats = stats["ws_op_ack"];
    const opAckP95 = opAckStats?.statisticallyValid ? opAckStats.p95 : (opAckStats?.avg ?? 0);
    const opAckTarget = targets.ws_op_ack_p95 ?? 500;
    const performancePass = !opAckStats || opAckP95 <= opAckTarget;

    let md = `# ${title}\n\n`;
    md += `**Run ID:** \`${this.runId}\`  \n`;
    md += `**Execution Duration:** ${durationSec}s  \n`;
    md += `**Functional Correctness Verdict:** ${functionalPass ? "✅ **PASS (0 Lost Writes)**" : "❌ **FAIL**"}  \n`;
    md += `**Performance Verdict:** ${performancePass ? "✅ **PASS**" : `⚠️ **FAIL / BOTTLENECK (p95: ${opAckP95}ms > ${opAckTarget}ms target)**`}  \n`;
    md += `**Checks:** ${passedChecks} Passed / ${failedChecks} Failed / ${this.skips.length} Skipped  \n`;
    md += `**Acknowledged Operations:** ${ackedLedger} / ${totalLedger}  \n`;
    md += `**Persisted Operations:** ${persistedLedger} / ${ackedLedger} (Lost writes: **${lostWrites}**)  \n\n`;

    md += `## Latency Distributions (ms)\n\n`;
    md += `| Category | Samples | Min | Avg | p50 | p90 | p95 | p99 | Max | Statistical Status |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;
    for (const [cat, s] of Object.entries(stats)) {
      const p50Str = s.statisticallyValid ? `${s.p50}` : `*N/A*`;
      const p90Str = s.statisticallyValid ? `${s.p90}` : `*N/A*`;
      const p95Str = s.statisticallyValid ? `${s.p95}` : `*N/A*`;
      const p99Str = s.statisticallyValid ? `${s.p99}` : `*N/A*`;
      const statusStr = s.statisticallyValid
        ? `Valid (N=${s.count})`
        : `Insufficient (N=${s.count} < 5)`;
      md += `| **${cat}** | ${s.count} | ${s.min} | ${s.avg} | ${p50Str} | ${p90Str} | ${p95Str} | ${p99Str} | ${s.max} | ${statusStr} |\n`;
    }
    md += `\n`;

    md += `## Verification Checks\n\n`;
    for (const c of this.checks) {
      const icon = c.pass ? "✅ PASS" : "❌ FAIL";
      md += `* ${icon}: **${c.name}** ${c.detail ? `— *${c.detail}*` : ""}\n`;
    }
    md += `\n`;

    if (this.skips.length > 0) {
      md += `## Skipped Scenarios (${this.skips.length})\n\n`;
      for (const s of this.skips) {
        md += `* ⏭️ **${s.name}** ${s.reason ? `— *${s.reason}*` : ""}\n`;
      }
      md += `\n`;
    }

    if (this.errors.length > 0) {
      md += `## Encountered Exceptions (${this.errors.length})\n\n`;
      for (const err of this.errors) {
        md += `* **[${err.context}]** ${err.error}\n`;
      }
      md += `\n`;
    }

    // Save report to artifact dir
    if (this.artifactDir) {
      const mdPath = path.join(this.artifactDir, `report_${this.runId}.md`);
      const jsonPath = path.join(this.artifactDir, `metrics_${this.runId}.json`);
      fs.writeFileSync(mdPath, md, "utf8");
      fs.writeFileSync(
        jsonPath,
        JSON.stringify(
          {
            runId: this.runId,
            durationSec,
            stats,
            checks: this.checks,
            errors: this.errors,
            skips: this.skips,
            ledgerSummary: { totalLedger, ackedLedger, persistedLedger, lostWrites },
          },
          null,
          2,
        ),
        "utf8",
      );
      console.log(`[REPORT SAVED] ${mdPath}`);
    }

    return md;
  }
}
