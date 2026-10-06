/**
 * Workspace Architectural Rules & Durable Context (Initiative 2).
 *
 * Provides persistent .cursorrules-style technical stack and architectural
 * constraints that steer AI generation and diagram construction without
 * requiring the user to repeat tech stack details on every prompt.
 *
 * Pure and deterministic (no React/DOM/network dependencies).
 */

export interface WorkspaceRules {
  /** Cloud provider and infrastructure environment (e.g. "GCP", "AWS", "On-Premises Kubernetes"). */
  cloudStack?: string;
  /** Primary languages, runtimes, and frameworks (e.g. "TypeScript, Next.js 15, Go 1.22"). */
  languagesAndFrameworks?: string;
  /** Primary databases, caches, and storage systems (e.g. "PostgreSQL 16, Redis 7, S3"). */
  databasesAndStorage?: string;
  /** Core architectural patterns to adhere to (e.g. "Event-Driven Microservices, CQRS, Hexagonal"). */
  architecturalPatterns?: string;
  /** Security, identity, and auth requirements (e.g. "OAuth 2.0, mTLS, Zero Trust, JWT"). */
  securityAndAuth?: string;
  /** Naming conventions for services, databases, topics, and APIs. */
  namingConventions?: string;
  /** Prohibited technologies, antipatterns, and patterns the AI must NEVER use. */
  prohibitedPatterns?: string;
  /** Freeform custom instructions and domain-specific rules. */
  customInstructions?: string;
}

export interface WorkspaceRuleTemplate {
  id: string;
  title: string;
  description: string;
  rules: WorkspaceRules;
}

export const WORKSPACE_RULE_TEMPLATES: readonly WorkspaceRuleTemplate[] = [
  {
    id: "gcp-cloud-native",
    title: "GCP Cloud-Native",
    description: "Google Cloud Platform microservices with Cloud Run, Pub/Sub, and Cloud Spanner.",
    rules: {
      cloudStack: "Google Cloud Platform (GCP)",
      languagesAndFrameworks: "Go 1.22, TypeScript, gRPC",
      databasesAndStorage: "Cloud Spanner (relational), Firestore (documents), Cloud Storage (blobs)",
      architecturalPatterns: "Event-Driven Microservices, CQRS, Cloud Run services behind Cloud Load Balancing",
      securityAndAuth: "Google Cloud IAM, OAuth 2.0 / OIDC, Workload Identity Federation, mTLS",
      namingConventions: "kebab-case services (auth-service), proto3 snake_case fields",
      prohibitedPatterns: "No direct cross-service database access; no unauthenticated endpoints; no monolithic architectures",
      customInstructions: "Prefer Google Cloud managed services and serverless containers over raw VMs. Every asynchronous flow must use Pub/Sub.",
    },
  },
  {
    id: "aws-serverless",
    title: "AWS Serverless",
    description: "Event-driven serverless architecture using AWS Lambda, EventBridge, and DynamoDB.",
    rules: {
      cloudStack: "Amazon Web Services (AWS)",
      languagesAndFrameworks: "Node.js / TypeScript, Python 3.12",
      databasesAndStorage: "Amazon DynamoDB (single-table design), Amazon S3, Amazon Aurora Serverless v2",
      architecturalPatterns: "Event-Driven Serverless, Hexagonal Architecture, CQRS with DynamoDB Streams",
      securityAndAuth: "AWS IAM with least privilege, Amazon Cognito, API Gateway JWT Authorizers",
      namingConventions: "camelCase functions and fields, PascalCase DynamoDB tables",
      prohibitedPatterns: "No persistent long-running servers or EC2 instances; avoid relational DBs unless strictly necessary",
      customInstructions: "Favor Lambda and Step Functions for orchestration. Use EventBridge for domain events and SQS for decoupling buffers.",
    },
  },
  {
    id: "modern-fullstack-ts",
    title: "Full-Stack TypeScript",
    description: "Type-safe end-to-end fullstack with Next.js, Fastify/Node, PostgreSQL, and Redis.",
    rules: {
      cloudStack: "Modern Cloud (AWS / Vercel / Railway)",
      languagesAndFrameworks: "TypeScript (Strict), Next.js App Router, Node.js / Fastify, React 19",
      databasesAndStorage: "PostgreSQL 16, Redis 7 (caching/queues), S3-compatible object storage",
      architecturalPatterns: "Modular Monolith evolving to Service-Oriented, REST + SSE for realtime updates",
      securityAndAuth: "HTTP-only secure cookies, OAuth 2.0 / Session tokens, CSRF protection, RBAC",
      namingConventions: "camelCase TS identifiers, snake_case PostgreSQL tables and columns",
      prohibitedPatterns: "No loose any types; no raw unparameterized SQL queries; no client-side API secret exposure",
      customInstructions: "End-to-end type safety with shared Zod schemas. Keep business logic separate from transport controllers.",
    },
  },
  {
    id: "event-driven-microservices",
    title: "Event-Driven Microservices",
    description: "High-throughput distributed systems with Apache Kafka, Go/Java, and Kubernetes.",
    rules: {
      cloudStack: "Multi-Cloud / Kubernetes (EKS, GKE)",
      languagesAndFrameworks: "Go, Kotlin / Spring Boot, gRPC, Protobuf",
      databasesAndStorage: "PostgreSQL per service, Apache Kafka (event log), Redis cluster",
      architecturalPatterns: "Event-Driven, Saga Pattern for distributed transactions, Outbox Pattern, CQRS",
      securityAndAuth: "mTLS via service mesh (Istio/Linkerd), OAuth 2.0 / JWT tokens with SPIFFE/SPIRE IDs",
      namingConventions: "kebab-case services, PascalCase protobuf messages, dot.delimited kafka topics",
      prohibitedPatterns: "No dual-writes without outbox pattern; no synchronous chains exceeding 3 service hops",
      customInstructions: "All state-changing operations emit domain events. Services must own private data stores.",
    },
  },
];

/**
 * Format structured or raw workspace rules into a clean prompt string for <workspace-rules>.
 */
export function formatWorkspaceRulesPrompt(rules: WorkspaceRules | string | undefined | null): string {
  if (!rules) return "";
  if (typeof rules === "string") {
    const trimmed = rules.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as WorkspaceRules;
        if (typeof parsed === "object" && parsed !== null) {
          return formatWorkspaceRulesPrompt(parsed);
        }
      } catch {
        // fallback to freeform text
      }
    }
    return trimmed;
  }

  const lines: string[] = [];
  if (rules.cloudStack?.trim()) {
    lines.push(`Cloud & Infrastructure Stack:\n${rules.cloudStack.trim()}`);
  }
  if (rules.languagesAndFrameworks?.trim()) {
    lines.push(`Languages & Frameworks:\n${rules.languagesAndFrameworks.trim()}`);
  }
  if (rules.databasesAndStorage?.trim()) {
    lines.push(`Databases & Storage:\n${rules.databasesAndStorage.trim()}`);
  }
  if (rules.architecturalPatterns?.trim()) {
    lines.push(`Architectural Patterns:\n${rules.architecturalPatterns.trim()}`);
  }
  if (rules.securityAndAuth?.trim()) {
    lines.push(`Security & Authentication:\n${rules.securityAndAuth.trim()}`);
  }
  if (rules.namingConventions?.trim()) {
    lines.push(`Naming Conventions:\n${rules.namingConventions.trim()}`);
  }
  if (rules.prohibitedPatterns?.trim()) {
    lines.push(`Prohibited Patterns (STRICTLY FORBIDDEN):\n${rules.prohibitedPatterns.trim()}`);
  }
  if (rules.customInstructions?.trim()) {
    lines.push(`Custom Architectural Constraints:\n${rules.customInstructions.trim()}`);
  }

  return lines.join("\n\n");
}

/**
 * Parse a raw string into WorkspaceRules. If raw string is JSON, parses fields;
 * otherwise puts the text into `customInstructions`.
 */
export function parseWorkspaceRules(raw: string | undefined | null): WorkspaceRules {
  if (!raw || !raw.trim()) {
    return {};
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        return {
          cloudStack: typeof parsed.cloudStack === "string" ? parsed.cloudStack : undefined,
          languagesAndFrameworks:
            typeof parsed.languagesAndFrameworks === "string" ? parsed.languagesAndFrameworks : undefined,
          databasesAndStorage:
            typeof parsed.databasesAndStorage === "string" ? parsed.databasesAndStorage : undefined,
          architecturalPatterns:
            typeof parsed.architecturalPatterns === "string" ? parsed.architecturalPatterns : undefined,
          securityAndAuth:
            typeof parsed.securityAndAuth === "string" ? parsed.securityAndAuth : undefined,
          namingConventions:
            typeof parsed.namingConventions === "string" ? parsed.namingConventions : undefined,
          prohibitedPatterns:
            typeof parsed.prohibitedPatterns === "string" ? parsed.prohibitedPatterns : undefined,
          customInstructions:
            typeof parsed.customInstructions === "string" ? parsed.customInstructions : undefined,
        };
      }
    } catch {
      // fallback
    }
  }
  return { customInstructions: trimmed };
}

/**
 * Serialize WorkspaceRules to string (JSON).
 */
export function serializeWorkspaceRules(rules: WorkspaceRules): string {
  return JSON.stringify(rules);
}
