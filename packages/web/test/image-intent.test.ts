import { describe, it, expect } from "vitest";
import { parseExplicitImageIntent } from "../src/views/CanvasView.js";

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
    expect(parseExplicitImageIntent("create reference image: a modern sleek gradient badge")).toBe(
      "a modern sleek gradient badge",
    );
  });
});
