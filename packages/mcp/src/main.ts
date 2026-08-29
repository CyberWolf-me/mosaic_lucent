#!/usr/bin/env node
import { serveStdio } from "./server.js";
import { BoardSession } from "./tools.js";
import { RemoteBoardSession, remoteConfigFromEnv } from "./remote.js";

/**
 * Entry point for the Lucent MCP server, so an agent can build Lucent boards
 * through the validated operation contract. Add to an MCP client config as
 *   { "command": "node", "args": ["packages/mcp/dist/main.js"] }
 * after `npm run build -w @lucent/core -w @lucent/mcp`, or while developing
 *   { "command": "npx",
 *     "args": ["tsx", "--conditions=development", "packages/mcp/src/main.ts"] }
 *
 * The `development` condition is not optional: without it @lucent/core resolves
 * to its built `dist/`, so a clean clone fails with ERR_MODULE_NOT_FOUND.
 *
 * E3/R1 — which board the session talks to, decided at boot:
 *   - `LUCENT_MCP_URL` + `LUCENT_MCP_TOKEN` + `LUCENT_MCP_BOARD` all set →
 *     RemoteBoardSession: every tool call hits the real server over HTTP
 *     (bearer auth, the agent-ops route). This is the "agent access" mode.
 *   - Otherwise → BoardSession: the process-local sandbox this package has
 *     always had. Still the default, because an MCP client should be able
 *     to try the tool surface with zero server setup.
 */
const remote = remoteConfigFromEnv();
serveStdio(remote ? new RemoteBoardSession(remote) : new BoardSession());
