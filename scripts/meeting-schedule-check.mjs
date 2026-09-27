/**
 * Scheduled meetings, end to end (docs/28 A3.4).
 *
 * Two real accounts against the running app (localhost:5173 → API :4387),
 * a real LiveKit project for the call, Chrome's fake camera and mic:
 *
 *   the host schedules a meeting from the Meetings list and invites a
 *   teammate → the teammate gets the notification and a mail with the
 *   calendar invite → the meeting page (S3) shows when, who and the agenda →
 *   the host changes it (the teammate is told) → the host joins from the page,
 *   records, and the recording becomes that meeting → a second meeting's
 *   page shows "Last time" → the host cancels it, and the teammate is told.
 *
 *   SERVER_LOG=<api log> node scripts/meeting-schedule-check.mjs
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://localhost:5173";
const headed = process.env.HEADED === "1";
const logPath = process.env.SERVER_LOG;
if (!logPath) throw new Error("set SERVER_LOG to the API server's log");
const serverLog = () => readFileSync(logPath, "utf8");

const browser = await chromium.launch({
  headless: !headed,
  slowMo: headed ? 150 : 0,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function waitFor(fn, timeout = 15000, every = 250) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    try {
      value = await fn();
      if (value) return value;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, every));
  }
  return value;
}

async function account(name) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["camera", "microphone"],
  });
  await ctx.addInitScript(() => {
    class ScriptedRecognition {
      constructor() {
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        this.results = [];
        window.__recognizer = this;
      }
      start() {}
      stop() {}
    }
    window.SpeechRecognition = ScriptedRecognition;
    window.webkitSpeechRecognition = ScriptedRecognition;
    window.__say = (text) => {
      const r = window.__recognizer;
      if (!r || !r.onresult) return false;
      const result = Object.assign([{ transcript: text }], { isFinal: true });
      r.results.push(result);
      r.onresult({ resultIndex: r.results.length - 1, results: r.results });
      return true;
    };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
  const email = `${name.split(" ")[0].toLowerCase()}_${Date.now()}@example.com`;
  await page.goto(base + "/signup", { waitUntil: "networkidle", timeout: 30000 });
  await page.locator('input[type="text"]').first().fill(name);
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill("schedule-check-123");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/view=canvas/, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  for (let i = 0; i < 5; i++) {
    const s = page.getByRole("button", { name: /^Skip$/ });
    if (!(await s.count())) break;
    await s
      .first()
      .click({ force: true })
      .catch(() => {});
    await page.waitForTimeout(300);
  }
  return { ctx, page, email, name };
}

async function post(page, path, data) {
  const mint = await page.request.get(`${base}/api/auth/csrf`);
  const { token } = await mint.json();
  const res = await page.request.post(`${base}${path}`, {
    headers: { "x-csrf-token": token, origin: base },
    data,
  });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

/** A local date and time `minutes` from now, as the date and time inputs take them. */
async function localSlot(page, minutes) {
  return page.evaluate((m) => {
    const d = new Date(Date.now() + m * 60_000);
    const pad = (n) => String(n).padStart(2, "0");
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  }, minutes);
}

// --- a host and a teammate on one board ---------------------------------------

const host = await account("Hana Host");
await host.page.getByRole("button", { name: "Share board" }).click();
await host.page.getByRole("button", { name: /publish & start collaborating/i }).click();
await host.page.waitForURL(/[?&]board=/, { timeout: 15000 });
const boardId = new URL(host.page.url()).searchParams.get("board");
const verify = serverLog().match(
  new RegExp(`to=${host.email.replace(/[.+]/g, "\\$&")}[^\\n]*?(/verify\\?token=[\\w-]+)`),
)?.[1];
if (!verify) throw new Error("no verification link for the host in SERVER_LOG");
await host.page.goto(base + verify, { waitUntil: "networkidle" });
const guest = await account("Gus Guest");
const link = await post(host.page, `/api/boards/${boardId}/share`, { role: "editor" });
const joined = await post(guest.page, `/api/boards/${boardId}/join`, { token: link.body.token });
check("the teammate is on the board", joined.status === 200, `${joined.status}`);

// --- S2: schedule from the Meetings list -------------------------------------------

await host.page.goto(`${base}/?view=meetings&board=${boardId}`, { waitUntil: "networkidle" });
await host.page.getByRole("button", { name: "Schedule" }).first().click();
const sheet = host.page.getByRole("dialog", { name: "Schedule a meeting" });
await sheet.waitFor({ timeout: 10000 });
await sheet.getByRole("button", { name: "Schedule" }).click();
check(
  "the sheet asks for a title before anything is sent",
  await waitFor(async () => (await sheet.textContent())?.includes("Add a title.")),
);
const soon = await localSlot(host.page, 6);
await sheet.getByLabel("Title", { exact: true }).fill("Launch sync");
await sheet.getByLabel("Date").fill(soon.date);
await sheet.getByLabel("Time").fill(soon.time);
await sheet.getByLabel("Notes template").selectOption("standup");
const gus = sheet.getByRole("checkbox", { name: /Gus Guest/ });
check("the teammate is offered as an invitee", await waitFor(() => gus.isVisible(), 10000));
await gus.check();
await sheet.getByRole("button", { name: "Schedule" }).click();
const toast = await waitFor(async () =>
  (await host.page.textContent("body"))?.includes("Invites sent to 1 person"),
);
check("scheduling says who was invited", toast);

// --- S3: the meeting's page ---------------------------------------------------------

const page3 = await waitFor(async () =>
  (await host.page.locator(".upc-title").textContent())?.includes("Launch sync"),
);
check("the host lands on the meeting's page", page3);
const meetingId = new URL(host.page.url()).searchParams.get("meeting");
const upc = await host.page.locator(".upc").textContent();
check(
  "the page says who's coming and what the agenda is",
  upc?.includes("Gus Guest") &&
    upc.includes("Hana Host") &&
    upc.includes("Agenda · Standup") &&
    upc.includes("Blockers"),
);
check(
  "an empty board says there's nothing from earlier meetings",
  upc?.includes("No earlier meetings on these boards"),
);

// --- the invite reached the teammate -----------------------------------------------

const inviteLine = await waitFor(() =>
  serverLog()
    .split("\n")
    .find((l) => l.includes(`to=${guest.email}`) && l.includes("invited you to")),
);
check(
  "the teammate is mailed the invite with a calendar file",
  inviteLine?.includes('Hana Host invited you to \\"Launch sync\\"') &&
    inviteLine.includes("invite.ics"),
  inviteLine?.slice(0, 160),
);
const tray = await guest.page.request.get(`${base}/api/notifications`);
const invited = (await tray.json()).notifications?.find((n) => n.kind === "meeting.invited");
check(
  "and sees it in the notifications tray, linked to the meeting",
  invited?.link === `/?board=${boardId}&view=meeting&meeting=${meetingId}`,
);
await guest.page.goto(`${base}/?view=meetings&board=${boardId}`, { waitUntil: "networkidle" });
check(
  "the teammate's Meetings list shows it under Upcoming",
  await waitFor(async () => {
    const section = guest.page.getByRole("region", { name: "Upcoming" });
    return (await section.textContent())?.includes("Launch sync");
  }),
);

// --- the host changes it ------------------------------------------------------------

await host.page.getByRole("button", { name: "Edit" }).click();
const edit = host.page.getByRole("dialog", { name: "Change the meeting" });
await edit.waitFor();
await edit.getByLabel("Title", { exact: true }).fill("Launch sync (moved room)");
await edit.getByRole("button", { name: "Save changes" }).click();
check(
  "a change is saved and shown",
  await waitFor(async () =>
    (await host.page.locator(".upc-title").textContent())?.includes("moved room"),
  ),
);
check(
  "the teammate is told it changed",
  await waitFor(() =>
    serverLog()
      .split("\n")
      .some((l) => l.includes(`to=${guest.email}`) && l.includes("changed")),
  ),
);

// --- Join from the page: the recording becomes the meeting -----------------------------

await host.page.getByRole("button", { name: "Join" }).click();
await host.page.getByRole("region", { name: "Join the call" }).waitFor({ timeout: 10000 });
await host.page.getByRole("button", { name: "Join now" }).click();
await host.page.locator(".call-stage").waitFor({ timeout: 20000 });
await host.page.getByRole("button", { name: "Transcribe this meeting" }).click();
await host.page.waitForFunction(() => !!window.__recognizer?.onresult, null, { timeout: 10000 });
await host.page.evaluate(() => window.__say("Blockers: the release notes are late."));
const adopted = await waitFor(async () => {
  const res = await host.page.request.get(`${base}/api/boards/${boardId}/meetings/${meetingId}`);
  const m = await res.json();
  return m.turns?.length > 0 ? m : null;
});
check(
  "the recording that starts in its window becomes the scheduled meeting",
  adopted?.id === meetingId &&
    adopted.title === "Launch sync (moved room)" &&
    adopted.turns[0].text === "Blockers: the release notes are late.",
);
const listRes = await host.page.request.get(`${base}/api/boards/${boardId}/meetings`);
check("no second transcript was opened", (await listRes.json()).meetings.length === 1);
await host.page.getByRole("button", { name: "Stop transcribing" }).click();
const summarized = await waitFor(
  async () => {
    const res = await host.page.request.get(`${base}/api/boards/${boardId}/meetings/${meetingId}`);
    const m = await res.json();
    return m.endedAt && m.recap ? m : null;
  },
  45000,
  1000,
);
check("it ends into a summary", !!summarized);
await host.page.getByRole("button", { name: "Leave" }).click();
await host.page
  .getByRole("menuitem", { name: /Leave the call/ })
  .click()
  .catch(() => {});

// --- a second meeting: "last time", then cancelled -------------------------------------

const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
const invitable = await host.page.request.get(`${base}/api/boards/${boardId}/meetings/invitable`);
const gusId = (await invitable.json()).people.find((p) => p.name === "Gus Guest")?.id;
const second = await post(host.page, `/api/boards/${boardId}/meetings/schedule`, {
  title: "Launch retro",
  scheduledFor: tomorrow,
  durationMin: 30,
  invitees: [gusId],
  template: "retro",
});
check("a second meeting is scheduled", second.status === 201, `${second.status}`);
const secondId = second.body.meeting?.id;
await host.page.goto(`${base}/?view=meeting&board=${boardId}&meeting=${secondId}`, {
  waitUntil: "networkidle",
});
check(
  "its page starts where the last meeting left off",
  await waitFor(async () => {
    const section = host.page.getByRole("region", { name: "Last time" });
    return (await section.textContent())?.includes("moved room");
  }),
);
await host.page.getByRole("button", { name: "Cancel meeting" }).click();
await host.page.getByRole("dialog", { name: "Cancel this meeting?" }).waitFor();
await host.page
  .getByRole("dialog", { name: "Cancel this meeting?" })
  .getByRole("button", { name: "Cancel meeting" })
  .click();
check(
  "a cancelled meeting says who called it off",
  await waitFor(async () =>
    (await host.page.locator(".upc-cancelled").textContent())?.includes("Cancelled by Hana Host"),
  ),
);
const cancelLine = await waitFor(() =>
  serverLog()
    .split("\n")
    .find((l) => l.includes(`to=${guest.email}`) && l.includes("cancelled")),
);
check(
  "and the teammate is sent the cancellation for their calendar",
  cancelLine?.includes("cancel.ics"),
  cancelLine?.slice(0, 160),
);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
