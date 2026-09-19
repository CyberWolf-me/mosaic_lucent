import { describe, it, expect } from "vitest";
import { parseExplicitImageIntent, enrichImagePromptWithContext } from "../src/views/CanvasView.js";

describe("parseExplicitImageIntent", () => {
  it("never intercepts diagramming, flowcharts, mind maps, or architecture intents", () => {
    expect(parseExplicitImageIntent("create a flowchart for the login flow")).toBeNull();
    expect(
      parseExplicitImageIntent("generate an architecture diagram for aws microservices"),
    ).toBeNull();
    expect(parseExplicitImageIntent("make a mind map about product ideas")).toBeNull();
    expect(parseExplicitImageIntent("create a user journey for onboarding")).toBeNull();
    expect(parseExplicitImageIntent("generate a wireframe of the profile settings")).toBeNull();
    expect(parseExplicitImageIntent("draw a sequence diagram for payment webhook")).toBeNull();
    expect(parseExplicitImageIntent("add a node called Database")).toBeNull();
    expect(parseExplicitImageIntent("explain the auth flow")).toBeNull();
    expect(parseExplicitImageIntent("")).toBeNull();
  });

  it("detects explicit user requests for reference images, logos, and illustrations", () => {
    expect(parseExplicitImageIntent("create a reference image for our logo")).toBe("our logo");
    expect(parseExplicitImageIntent("generate an image of a cyber cat with neon eyes")).toBe(
      "a cyber cat with neon eyes",
    );
    expect(parseExplicitImageIntent("please draw a reference picture for the checkout page")).toBe(
      "the checkout page",
    );
    expect(parseExplicitImageIntent("create a logo for Lucent visual workspace")).toBe(
      "Lucent visual workspace",
    );
    expect(parseExplicitImageIntent("generate a logo of a sleek glowing hexagon")).toBe(
      "a sleek glowing hexagon",
    );
    expect(parseExplicitImageIntent("imagine a futuristic floating cloud datacenter")).toBe(
      "a futuristic floating cloud datacenter",
    );
  });

  it("detects conversational redirects and follow-up requests for images and logos", () => {
    expect(parseExplicitImageIntent("nope use image generation")).toBe(
      "reference image or logo for the current board",
    );
    expect(parseExplicitImageIntent("use image generation")).toBe(
      "reference image or logo for the current board",
    );
    expect(parseExplicitImageIntent("generate an image instead")).toBe(
      "reference image or logo for the current board",
    );
    expect(parseExplicitImageIntent("can you make a logo for the brand we discussed")).toBe(
      "the brand we discussed",
    );
    expect(parseExplicitImageIntent("make a logo for Mosaic")).toBe("Mosaic");
  });
});

describe("enrichImagePromptWithContext", () => {
  it("leaves detailed and specific prompts alone", () => {
    const detailed = "a sleek futuristic glowing hexagon logo with cyan neon circuit patterns on black background";
    expect(enrichImagePromptWithContext(detailed)).toBe(detailed);
  });

  it("enriches conversational and relative prompts using board entities and conversation context", () => {
    const chat = [
      { role: "user", text: "i want to create a reservation platform for my restaurant name Mosaic" },
      { role: "ai", text: "Created reservation platform architecture for Mosaic with full stack" },
    ];
    const workspace = {
      nodes: {
        "api-gw": { label: "API Gateway" },
        "db": { label: "PostgreSQL" },
      },
    };

    const prompt1 = "nope use image generation";
    const enriched1 = enrichImagePromptWithContext(
      parseExplicitImageIntent(prompt1)!,
      workspace,
      chat,
      "Mosaic",
    );
    expect(enriched1).toContain("Mosaic");
    expect(enriched1).toContain("logo");

    const prompt2 = "can you make a logo for the brand we discussed";
    const enriched2 = enrichImagePromptWithContext(
      parseExplicitImageIntent(prompt2)!,
      workspace,
      chat,
      "Mosaic",
    );
    expect(enriched2).toContain("Mosaic");
  });
});
