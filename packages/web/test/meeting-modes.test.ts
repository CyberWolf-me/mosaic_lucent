import { describe, it, expect } from "vitest";
import {
  MEETING_MODES,
  effectiveMode,
  isMeetingMode,
  modeAllowsExtraction,
  modeDegraded,
  MODE_LABELS,
  MODE_NOTES,
} from "../src/meeting-modes.js";

/**
 * docs/24 Phase D: meeting modes as behavior profiles.
 *
 * The acceptance the plan names: a Record meeting burns zero generations.
 * That is pinned here as a pure rule (`modeAllowsExtraction`) over the
 * trigger the view consults — a Record-only extract would be a clause-4
 * defect, so the refusal lives one function call above the send, tested
 * without a DOM.
 */
describe("meeting modes", () => {
  it("names exactly the four advisory profiles", () => {
    expect([...MEETING_MODES]).toEqual(["record", "intelligence", "assistant", "participant"]);
    expect(isMeetingMode("record")).toBe(true);
    expect(isMeetingMode("番組")).toBe(false);
    expect(isMeetingMode(undefined)).toBe(false);
  });

  it("record is the only mode that forbids extraction", () => {
    expect(modeAllowsExtraction("record")).toBe(false);
    expect(modeAllowsExtraction("intelligence")).toBe(true);
    expect(modeAllowsExtraction("assistant")).toBe(true);
    expect(modeAllowsExtraction("participant")).toBe(true);
    expect(effectiveMode("record")).toBe("record");
    expect(effectiveMode("participant")).toBe("intelligence");
  });

  it("discloses each mode's behavior; only Participant is still future", () => {
    // Assistant's voice loop is built now, so it is no longer degraded — only
    // Participant (proactive intervention) is future.
    expect(modeDegraded("assistant")).toBe(false);
    expect(modeDegraded("participant")).toBe(true);
    expect(modeDegraded("record")).toBe(false);
    expect(modeDegraded("intelligence")).toBe(false);
    // Assistant discloses explicit invocation; Intelligence discloses that
    // board changes are proposed, never silent; Participant discloses it's future.
    expect(MODE_NOTES.assistant).toContain("Lucent");
    expect(MODE_NOTES.intelligence).toMatch(/propos/i);
    expect(MODE_NOTES.participant).toMatch(/future|proactive/i);
    for (const mode of MEETING_MODES) {
      expect(MODE_LABELS[mode].length).toBeGreaterThan(0);
      expect(MODE_NOTES[mode].length).toBeGreaterThan(0);
    }
  });
});
