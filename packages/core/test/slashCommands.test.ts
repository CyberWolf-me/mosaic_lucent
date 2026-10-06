import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  filterSlashCommands,
  parseSlashCommand,
  expandSlashCommandPrompt,
} from "../src/slashCommands.js";

describe("Slash Commands System", () => {
  describe("parseSlashCommand", () => {
    it("returns null for non-command inputs", () => {
      expect(parseSlashCommand("Build an e-commerce flow")).toBeNull();
      expect(parseSlashCommand("")).toBeNull();
      expect(parseSlashCommand("   ")).toBeNull();
      expect(parseSlashCommand("some /decompose inside text")).toBeNull();
    });

    it("parses command without arguments", () => {
      const parsed = parseSlashCommand("/threat-model");
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe("threat-model");
      expect(parsed?.args).toBe("");
      expect(parsed?.definition?.id).toBe("threat-model");
      expect(parsed?.definition?.title).toBe("Threat Model & Security Audit");
    });

    it("parses command with trailing arguments", () => {
      const parsed = parseSlashCommand("/decompose Auth Service");
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe("decompose");
      expect(parsed?.args).toBe("Auth Service");
      expect(parsed?.definition?.id).toBe("decompose");
    });

    it("is case-insensitive for command name but preserves args casing", () => {
      const parsed = parseSlashCommand("/TRANSLATE Spanish");
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe("translate");
      expect(parsed?.args).toBe("Spanish");
    });

    it("handles unknown slash commands gracefully", () => {
      const parsed = parseSlashCommand("/custom-action something");
      expect(parsed).not.toBeNull();
      expect(parsed?.command).toBe("custom-action");
      expect(parsed?.args).toBe("something");
      expect(parsed?.definition).toBeUndefined();
    });
  });

  describe("filterSlashCommands", () => {
    it("returns all commands on empty or slash-only query", () => {
      expect(filterSlashCommands("").length).toBe(SLASH_COMMANDS.length);
      expect(filterSlashCommands("/").length).toBe(SLASH_COMMANDS.length);
    });

    it("filters commands matching prefix", () => {
      const filtered = filterSlashCommands("/threat");
      expect(filtered.length).toBe(1);
      expect(filtered[0]?.id).toBe("threat-model");
    });

    it("filters commands matching partial keywords or descriptions", () => {
      const filtered = filterSlashCommands("error");
      expect(filtered.some((c) => c.id === "edge-cases")).toBe(true);
    });
  });

  describe("expandSlashCommandPrompt", () => {
    it("expands /decompose with component name", () => {
      const parsed = parseSlashCommand("/decompose Payment Gateway")!;
      const expanded = expandSlashCommandPrompt(parsed);
      expect(expanded).toContain("[Mode: Component Decomposition]");
      expect(expanded).toContain('"Payment Gateway"');
      expect(expanded).toContain("3 to 5 granular, connected sub-process nodes");
    });

    it("expands /threat-model with focus", () => {
      const parsed = parseSlashCommand("/threat-model Auth flow")!;
      const expanded = expandSlashCommandPrompt(parsed);
      expect(expanded).toContain("[Mode: Threat Model & Security Audit]");
      expect(expanded).toContain('focus on "Auth flow"');
      expect(expanded).toContain("STRIDE");
    });

    it("expands /edge-cases", () => {
      const parsed = parseSlashCommand("/edge-cases checkout")!;
      const expanded = expandSlashCommandPrompt(parsed);
      expect(expanded).toContain("[Mode: Edge Cases & Error Handling]");
      expect(expanded).toContain("decision diamonds");
      expect(expanded).toContain("timeout/failure branches");
    });

    it("expands /sequence", () => {
      const parsed = parseSlashCommand("/sequence checkout process")!;
      const expanded = expandSlashCommandPrompt(parsed);
      expect(expanded).toContain("[Mode: Sequence Diagram Generation]");
      expect(expanded).toContain("actor-to-actor sequence flow");
    });

    it("expands /simplify", () => {
      const parsed = parseSlashCommand("/simplify")!;
      const expanded = expandSlashCommandPrompt(parsed);
      expect(expanded).toContain("[Mode: Architecture Simplification]");
      expect(expanded).toContain("consolidate redundant nodes");
    });

    it("expands /translate with target language", () => {
      const parsed = parseSlashCommand("/translate German")!;
      const expanded = expandSlashCommandPrompt(parsed);
      expect(expanded).toContain("[Mode: Diagram Translation]");
      expect(expanded).toContain("German");
      expect(expanded).toContain("strictly preserving all node IDs");
    });

    it("returns raw text for unrecognized command", () => {
      const parsed = parseSlashCommand("/unknown custom command")!;
      const expanded = expandSlashCommandPrompt(parsed);
      expect(expanded).toBe("/unknown custom command");
    });
  });
});
