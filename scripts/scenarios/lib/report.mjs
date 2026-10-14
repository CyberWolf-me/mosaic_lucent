/**
 * Checks, timings and the run report. A check is a named claim about what
 * the product did; a failed one keeps its evidence. `known` marks a failure
 * that reproduces a bug already identified, so the report separates "new
 * regression" from "known defect, still present".
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export class Report {
  constructor(runId, artifactDir) {
    this.runId = runId;
    this.artifactDir = artifactDir;
    mkdirSync(artifactDir, { recursive: true });
    this.checks = [];
    this.timings = new Map();
    this.counts = new Map();
    this.notes = [];
    this.phase = "setup";
    this.phaseTimes = [];
    this.startedAt = Date.now();
  }

  startPhase(name, title) {
    this.phase = name;
    this.phaseTimes.push({ name, title, start: Date.now(), end: null });
    console.log(`\n=== ${name} — ${title} ===`);
  }
  endPhase() {
    const p = this.phaseTimes.at(-1);
    if (p && !p.end) p.end = Date.now();
  }

  check(name, pass, detail = "", { known } = {}) {
    const entry = { phase: this.phase, name, pass: !!pass, detail: String(detail ?? ""), known };
    this.checks.push(entry);
    const tag = pass ? "PASS" : known ? "KNOWN" : "FAIL";
    console.log(`  ${tag}  ${name}${detail ? `  — ${String(detail).slice(0, 240)}` : ""}`);
    return !!pass;
  }

  /** Run `fn`; an exception becomes a failed check instead of ending the run. */
  async guard(name, fn) {
    try {
      return await fn();
    } catch (err) {
      this.check(name, false, err?.stack?.split("\n").slice(0, 3).join(" | ") ?? String(err));
      return undefined;
    }
  }

  time(key, ms) {
    if (!this.timings.has(key)) this.timings.set(key, []);
    this.timings.get(key).push(ms);
  }
  count(key, n = 1) {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }
  note(text) {
    this.notes.push({ phase: this.phase, text });
    console.log(`  note  ${text}`);
  }

  stats(key) {
    const xs = [...(this.timings.get(key) ?? [])].sort((a, b) => a - b);
    if (!xs.length) return null;
    const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
    return { n: xs.length, p50: q(0.5), p95: q(0.95), max: xs.at(-1) };
  }

  write(extra = {}) {
    const failed = this.checks.filter((c) => !c.pass && !c.known);
    const known = this.checks.filter((c) => !c.pass && c.known);
    const passed = this.checks.filter((c) => c.pass);
    const ms = (n) => (n == null ? "—" : `${Math.round(n)} ms`);
    const lines = [];
    lines.push(`# Team-session scenarios — run ${this.runId}`);
    lines.push("");
    lines.push(
      `${new Date(this.startedAt).toISOString()} · ${Math.round((Date.now() - this.startedAt) / 1000)} s · ` +
        `**${passed.length} passed, ${failed.length} failed, ${known.length} known defects**`,
    );
    lines.push("");
    if (extra.setup) {
      lines.push("## Setup");
      lines.push("");
      for (const [k, v] of Object.entries(extra.setup)) lines.push(`- **${k}:** ${v}`);
      lines.push("");
    }
    lines.push("## Phases");
    lines.push("");
    lines.push("| Phase | What | Checks | Time |");
    lines.push("|---|---|---|---|");
    for (const p of this.phaseTimes) {
      const cs = this.checks.filter((c) => c.phase === p.name);
      const bad = cs.filter((c) => !c.pass && !c.known).length;
      const kn = cs.filter((c) => !c.pass && c.known).length;
      lines.push(
        `| ${p.name} | ${p.title} | ${cs.length - bad - kn}/${cs.length}${bad ? ` · **${bad} failed**` : ""}${kn ? ` · ${kn} known` : ""} | ${Math.round(((p.end ?? Date.now()) - p.start) / 1000)} s |`,
      );
    }
    lines.push("");
    if (failed.length || known.length) {
      lines.push("## Failures");
      lines.push("");
      for (const c of [...failed, ...known]) {
        lines.push(`- **${c.known ? "KNOWN" : "FAIL"}** \`${c.phase}\` ${c.name}${c.detail ? ` — ${c.detail}` : ""}${c.known ? ` _(${c.known})_` : ""}`);
      }
      lines.push("");
    }
    lines.push("## Timings");
    lines.push("");
    lines.push("| Metric | n | p50 | p95 | max |");
    lines.push("|---|---|---|---|---|");
    for (const key of [...this.timings.keys()].sort()) {
      const s = this.stats(key);
      lines.push(`| ${key} | ${s.n} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.max)} |`);
    }
    lines.push("");
    if (this.counts.size) {
      lines.push("## Counts");
      lines.push("");
      for (const [k, v] of [...this.counts.entries()].sort()) lines.push(`- ${k}: ${v}`);
      lines.push("");
    }
    if (this.notes.length) {
      lines.push("## Notes");
      lines.push("");
      for (const n of this.notes) lines.push(`- \`${n.phase}\` ${n.text}`);
      lines.push("");
    }
    lines.push("## All checks");
    lines.push("");
    for (const c of this.checks) {
      lines.push(`- ${c.pass ? "✅" : c.known ? "🟡" : "❌"} \`${c.phase}\` ${c.name}${c.detail && !c.pass ? ` — ${c.detail}` : ""}`);
    }
    const md = lines.join("\n") + "\n";
    writeFileSync(path.join(this.artifactDir, "report.md"), md);
    writeFileSync(
      path.join(this.artifactDir, "results.json"),
      JSON.stringify(
        {
          runId: this.runId,
          checks: this.checks,
          timings: Object.fromEntries([...this.timings.keys()].map((k) => [k, this.stats(k)])),
          counts: Object.fromEntries(this.counts),
          notes: this.notes,
          phases: this.phaseTimes,
          ...extra,
        },
        null,
        2,
      ),
    );
    return { failed: failed.length, known: known.length, passed: passed.length };
  }
}
