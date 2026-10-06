import { describe, expect, it } from "vitest";
import {
  formatWorkspaceRulesPrompt,
  parseWorkspaceRules,
  serializeWorkspaceRules,
  WORKSPACE_RULE_TEMPLATES,
  type WorkspaceRules,
} from "../src/workspaceRules.js";

describe("workspaceRules", () => {
  it("provides pre-configured architectural templates", () => {
    expect(WORKSPACE_RULE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    const ids = WORKSPACE_RULE_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("gcp-cloud-native");
    expect(ids).toContain("aws-serverless");
    expect(ids).toContain("modern-fullstack-ts");
    expect(ids).toContain("event-driven-microservices");

    for (const t of WORKSPACE_RULE_TEMPLATES) {
      expect(t.title).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.rules.cloudStack).toBeTruthy();
      expect(t.rules.languagesAndFrameworks).toBeTruthy();
      expect(t.rules.prohibitedPatterns).toBeTruthy();
    }
  });

  it("formats structured rules into clean prompt sections", () => {
    const rules: WorkspaceRules = {
      cloudStack: "AWS",
      languagesAndFrameworks: "Node.js, TypeScript",
      databasesAndStorage: "DynamoDB, S3",
      architecturalPatterns: "Serverless Event-Driven",
      securityAndAuth: "Cognito, IAM",
      namingConventions: "camelCase",
      prohibitedPatterns: "No EC2 instances",
      customInstructions: "Prefer Lambda functions.",
    };

    const formatted = formatWorkspaceRulesPrompt(rules);
    expect(formatted).toContain("Cloud & Infrastructure Stack:\nAWS");
    expect(formatted).toContain("Languages & Frameworks:\nNode.js, TypeScript");
    expect(formatted).toContain("Databases & Storage:\nDynamoDB, S3");
    expect(formatted).toContain("Architectural Patterns:\nServerless Event-Driven");
    expect(formatted).toContain("Security & Authentication:\nCognito, IAM");
    expect(formatted).toContain("Naming Conventions:\ncamelCase");
    expect(formatted).toContain("Prohibited Patterns (STRICTLY FORBIDDEN):\nNo EC2 instances");
    expect(formatted).toContain("Custom Architectural Constraints:\nPrefer Lambda functions.");
  });

  it("formats raw string rules and JSON strings", () => {
    expect(formatWorkspaceRulesPrompt("")).toBe("");
    expect(formatWorkspaceRulesPrompt(null)).toBe("");
    expect(formatWorkspaceRulesPrompt(undefined)).toBe("");

    const plain = "Always use Python 3.12 and FastAPI.";
    expect(formatWorkspaceRulesPrompt(plain)).toBe("Always use Python 3.12 and FastAPI.");

    const json = JSON.stringify({
      cloudStack: "GCP",
      languagesAndFrameworks: "Go",
    });
    const formatted = formatWorkspaceRulesPrompt(json);
    expect(formatted).toContain("Cloud & Infrastructure Stack:\nGCP");
    expect(formatted).toContain("Languages & Frameworks:\nGo");
  });

  it("parses JSON strings and freeform strings", () => {
    expect(parseWorkspaceRules("")).toEqual({});
    expect(parseWorkspaceRules(null)).toEqual({});
    expect(parseWorkspaceRules(undefined)).toEqual({});

    const freeform = "Strictly use PostgreSQL and no MongoDB.";
    expect(parseWorkspaceRules(freeform)).toEqual({
      customInstructions: "Strictly use PostgreSQL and no MongoDB.",
    });

    const structured: WorkspaceRules = {
      cloudStack: "Azure",
      languagesAndFrameworks: "C# .NET 9",
    };
    const parsed = parseWorkspaceRules(JSON.stringify(structured));
    expect(parsed.cloudStack).toBe("Azure");
    expect(parsed.languagesAndFrameworks).toBe("C# .NET 9");
  });

  it("serializes and deserializes cleanly round-trip", () => {
    const original: WorkspaceRules = {
      cloudStack: "AWS",
      languagesAndFrameworks: "TypeScript",
      databasesAndStorage: "PostgreSQL",
      prohibitedPatterns: "No GraphQL",
    };

    const serialized = serializeWorkspaceRules(original);
    const parsed = parseWorkspaceRules(serialized);
    expect(parsed).toEqual(original);
  });
});
