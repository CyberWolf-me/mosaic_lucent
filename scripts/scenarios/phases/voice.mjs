/**
 * Voice, for real:
 *
 *   - Pia opens a Live call from the composer. The board's voice agent (the
 *     worker this run started under its own name) joins, hears her speak —
 *     a synthesized WAV fed in as Chromium's microphone — transcribes it with
 *     Deepgram, decides with the real model, and edits the board through the
 *     agent grant. Everyone's sockets see the agent's edit.
 *   - Ava talks with Lucent on the canvas: her words go through the voice
 *     conversation (scripted recognizer, real model, real text-to-speech).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sleep, waitFor } from "../lib/api.mjs";
import { gotoBoard, launchBrowser, openAs, shot } from "../lib/browser.mjs";
import { checkConvergence } from "../lib/converge.mjs";
import { applyProposalIn } from "./canvas.mjs";

const SPOKEN = "Please add a node called Beta feedback and connect it to the QA step.";

/** Windows' speech synthesizer → 16 kHz mono PCM, with 12 s of silence first
 *  so the agent is in the room before the words start. */
function speechWav(dir) {
  const raw = path.join(dir, "speech-raw.wav");
  const out = path.join(dir, "speech.wav");
  if (existsSync(out)) return out;
  const ps = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    `$s.SetOutputToWaveFile('${raw.replace(/'/g, "''")}', $f)`,
    `$s.Speak('${SPOKEN.replace(/'/g, "''")}')`,
    "$s.Dispose()",
  ].join("; ");
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
  const wav = readFileSync(raw);
  const dataAt = wav.indexOf(Buffer.from("data")) + 8;
  const pcm = wav.subarray(dataAt);
  const silence = Buffer.alloc(16000 * 2 * 12);
  const tail = Buffer.alloc(16000 * 2 * 4);
  const body = Buffer.concat([silence, pcm, tail]);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(body.length, 40);
  writeFileSync(out, Buffer.concat([header, body]));
  return out;
}

export async function voice(ctx) {
  const { world, report: r, stack } = ctx;
  const pia = world.p("Pia");
  const ava = world.p("Ava");

  // --- The duplex voice agent ------------------------------------------------
  if (stack.voiceAgent) {
    await r.guard("voice agent live call", async () => {
      const wav = speechWav(r.artifactDir);
      ctx.voiceBrowser = await launchBrowser({ fakeAudioWav: `${wav}%noloop`, headed: ctx.headed });
      await openAs(ctx.voiceBrowser, pia, { baseUrl: stack.webUrl, report: r });
      await gotoBoard(pia.page, stack.webUrl, world.boardId);
      const t0 = Date.now();
      await pia.page.getByRole("button", { name: "Live call" }).click();
      r.count("real voice-agent calls (Deepgram + model + LiveKit)");
      const agentEdit = await waitFor(
        () =>
          [...world.p("Gus").rt.entries.values()].find(
            (e) => e.at >= t0 && e.actor?.actorId === "voice-agent" && e.actor?.initiatedBy === pia.id,
          ),
        { timeout: 120_000, every: 1000, label: "the voice agent's edit" },
      ).catch(() => null);
      r.time("voice_agent_first_edit_ms", Date.now() - t0);
      const log = readFileSync(stack.voiceAgent.logPath, "utf8");
      r.check(
        "the voice agent heard Pia and edited the board (Deepgram STT → model → agent grant)",
        !!agentEdit,
        agentEdit
          ? agentEdit.ops.map((o) => `${o.op}${o.label ? ` "${o.label}"` : ""}`).join(", ")
          : `agent log tail: ${log.slice(-400).replace(/\s+/g, " ")}`,
      );
      if (agentEdit) {
        const n = await Promise.allSettled(
          world.people.filter((p) => p.rt?.open).map((p) => p.rt.waitForSeq(agentEdit.seq, 20_000)),
        );
        r.check("every socket received the agent's edit", n.every((x) => x.status === "fulfilled"));
      }
      await shot(pia.page, r.artifactDir, "voice-agent-call");
      await pia.page.getByRole("button", { name: "End the live call" }).click().catch(() => {});
    });
  } else {
    r.note("voice agent skipped (--no-voice-agent)");
  }

  // --- Talking with Lucent on the canvas --------------------------------------
  await r.guard("talk with Lucent on the canvas", async () => {
    const before = Object.keys((await world.serverBoard()).workspace.nodes).length;
    await ava.page.getByRole("button", { name: "Talk with Lucent" }).click();
    await waitFor(() => ava.page.evaluate(() => !!window.__recognizer?.onresult), { timeout: 10_000, label: "recognizer" });
    const t0 = performance.now();
    await ava.page.evaluate((t) => window.__say(t), "Add a node called Launch retro and connect it to the release step");
    r.count("real AI calls (voice turn)");
    const proposal = applyProposalIn(ava.page, 120_000);
    const grew = await waitFor(
      async () => (Object.keys((await world.serverBoard()).workspace.nodes).length > before ? true : null),
      { timeout: 150_000, every: 1500, label: "the spoken change" },
    ).catch(() => false);
    await proposal;
    r.time("voice_turn_to_board_ms", performance.now() - t0);
    r.check("a spoken request on the canvas changed the board (real model)", !!grew);
    const spoke = await waitFor(
      async () => /Answering|speaking|Listening/i.test((await ava.page.locator(".voice-phase").textContent().catch(() => "")) ?? ""),
      { timeout: 30_000, label: "spoken reply" },
    ).catch(() => false);
    r.check("Lucent answered out loud and kept listening", !!spoke);
    await ava.page.evaluate(() => window.__say("that's all"));
    await sleep(2500);
  });

  await checkConvergence(world, { label: "voice", startWorkspace: ctx.startWorkspace, browsers: ctx.canvasBrowsers, knownStale: ctx.knownStale });
}
