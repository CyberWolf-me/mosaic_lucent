/**
 * Real browser users. Each scenario person who needs the UI gets a Chromium
 * context signed in as that person (bearer token in localStorage — the web
 * client's own fallback path, http.ts), with the tour dismissed, chosen
 * settings seeded, fake camera/microphone, and optionally a scripted speech
 * recognizer (`window.__say(text)`) standing in for the browser's — headless
 * Chromium has none, and this drives the real capture path rather than a
 * debug hook.
 */
import { chromium } from "playwright";
import path from "node:path";
import { writeFileSync } from "node:fs";

export async function launchBrowser({ fakeAudioWav, headed = false } = {}) {
  return chromium.launch({
    headless: !headed,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      ...(fakeAudioWav ? [`--use-file-for-fake-audio-capture=${fakeAudioWav}`] : []),
    ],
  });
}

export async function openAs(browser, person, { baseUrl, settings = {}, scriptedSpeech = false, report }) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["camera", "microphone"],
  });
  await ctx.addInitScript(
    ([user, token, settings]) => {
      localStorage.setItem("lucent.user", JSON.stringify(user));
      localStorage.setItem("lucent.token", token);
      localStorage.setItem("lucent.scope", user.id);
      localStorage.setItem("lucent.tour.seen.v1", "1");
      localStorage.setItem("lucent.v2.theme_init", "1");
      const prior = JSON.parse(localStorage.getItem("lucent.settings") || "{}");
      localStorage.setItem("lucent.settings", JSON.stringify({ ...prior, ...settings }));
    },
    [{ id: person.id, email: person.email, name: person.name }, person.token, settings],
  );
  if (scriptedSpeech) {
    await ctx.addInitScript(() => {
      class ScriptedRecognition {
        constructor() {
          this.onresult = null;
          this.onerror = null;
          this.onend = null;
          this.continuous = false;
          this.interimResults = false;
          this.results = [];
          window.__recognizer = this;
        }
        start() {
          this.started = true;
        }
        stop() {
          this.started = false;
          this.onend?.();
        }
        abort() {
          this.stop();
        }
      }
      window.SpeechRecognition = ScriptedRecognition;
      window.webkitSpeechRecognition = ScriptedRecognition;
      window.__say = (text) => {
        const r = window.__recognizer;
        if (!r || !r.onresult) return false;
        const result = Object.assign([{ transcript: text, confidence: 0.95 }], { isFinal: true });
        r.results.push(result);
        r.onresult({ resultIndex: r.results.length - 1, results: r.results });
        return true;
      };
    });
  }
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => {
    page.errors.push(e.message);
    report?.note(`[${person.name} pageerror] ${e.message.slice(0, 200)}`);
  });
  page.consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") page.consoleErrors.push(m.text().slice(0, 300));
  });
  // Every realtime frame this browser exchanges (presence excluded), so a
  // divergence can be traced to what the page actually received.
  page.wsFrames = [];
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/ws?")) return;
    page.wsFrames.push({ dir: "open", at: Date.now() });
    const log = (dir) => (f) => {
      try {
        const m = JSON.parse(f.payload);
        if (["presence", "peer-joined", "peer-left", "pong", "ping"].includes(m.type)) return;
        page.wsFrames.push({
          dir,
          type: m.type,
          seq: m.entry?.seq ?? m.seq,
          version: m.version,
          catchup: m.catchup?.length,
          fromSeq: m.fromSeq,
          ops: m.ops?.length ?? m.entry?.ops?.length,
          req: m.requestId ?? m.entry?.requestId,
          error: m.error,
          at: Date.now(),
        });
      } catch {}
    };
    ws.on("framereceived", log("in"));
    ws.on("framesent", log("out"));
    ws.on("close", () => page.wsFrames.push({ dir: "close", at: Date.now() }));
  });
  person.page = page;
  person.ctx = ctx;
  return page;
}

/** Open a board view. `view` canvas|meeting|history|…; `lens` for the canvas. */
export async function gotoBoard(page, baseUrl, boardId, { view = "canvas", lens, extra = "" } = {}) {
  const q = new URLSearchParams({ view, board: boardId });
  if (lens) q.set("lens", lens);
  await page.goto(`${baseUrl}/?${q}${extra}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator(".top-bar").first().waitFor({ timeout: 60_000 });
}

/** Labels of the nodes this browser renders (canvas lens). */
export function nodeLabels(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".node")]
      .map((n) => n.getAttribute("aria-label") || n.textContent?.trim() || "")
      .filter(Boolean),
  );
}

export async function shot(page, dir, name) {
  try {
    await page.screenshot({ path: path.join(dir, `${name}.png`) });
  } catch {
    /* page gone */
  }
}

export function dumpErrors(people, dir) {
  const out = {};
  for (const p of people) if (p.page) out[p.name] = { pageErrors: p.page.errors, consoleErrors: p.page.consoleErrors.slice(-40) };
  writeFileSync(path.join(dir, "browser-errors.json"), JSON.stringify(out, null, 2));
  for (const p of people) if (p.page?.wsFrames) writeFileSync(path.join(dir, `ws-${p.name}.json`), JSON.stringify(p.page.wsFrames, null, 1));
}
