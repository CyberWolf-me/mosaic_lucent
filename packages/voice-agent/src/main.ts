import { cli, ServerOptions } from "@livekit/agents";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load environment variables from packages/server/.env, .env.local, and root .env
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const envPaths = [
  path.resolve(currentDir, "../.env"),
  path.resolve(currentDir, "../../server/.env"),
  path.resolve(currentDir, "../../../.env"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "packages/server/.env"),
];

for (const p of envPaths) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override: false });
  }
}

// Ensure LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are mapped from LUCENT_*
if (!process.env.LIVEKIT_URL && process.env.LUCENT_LIVEKIT_URL) {
  process.env.LIVEKIT_URL = process.env.LUCENT_LIVEKIT_URL;
}
if (!process.env.LIVEKIT_API_KEY && process.env.LUCENT_LIVEKIT_API_KEY) {
  process.env.LIVEKIT_API_KEY = process.env.LUCENT_LIVEKIT_API_KEY;
}
if (!process.env.LIVEKIT_API_SECRET && process.env.LUCENT_LIVEKIT_API_SECRET) {
  process.env.LIVEKIT_API_SECRET = process.env.LUCENT_LIVEKIT_API_SECRET;
}
if (!process.env.DEEPGRAM_API_KEY && process.env.LUCENT_STT_KEY) {
  process.env.DEEPGRAM_API_KEY = process.env.LUCENT_STT_KEY;
}
if (!process.env.OPENAI_API_KEY && process.env.LUCENT_AI_KEY) {
  process.env.OPENAI_API_KEY = process.env.LUCENT_AI_KEY;
}

// Find agent entry file (supports both tsx runtime and compiled js)
const tsAgentPath = path.resolve(currentDir, "agent.ts");
const jsAgentPath = path.resolve(currentDir, "agent.js");
const agentEntryPath = fs.existsSync(tsAgentPath) ? tsAgentPath : jsAgentPath;

cli.runApp(
  new ServerOptions({
    agent: agentEntryPath,
    agentName: "lucent-voice-agent",
  }),
);
