# @lucent/mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent
read-and-write access to a **Lucent** board — through the **same validated
operation contract the app itself uses**. The tool schema is derived from
Lucent's core Zod operation union, so an agent literally cannot send an
operation the validator would reject, and the board stays an editable
**semantic model** rather than a rendered image or a pile of guessed
coordinates.

This is the agent-facing interface into Lucent's semantic workspace — one of
several front doors (the app, the manual board, this server), not a separate
product.

## Tools

| Tool | What it does |
| --- | --- |
| `get_board` | Read the current board as structured nodes, edges, groups, shapes. |
| `apply_canvas_operations` | Apply validated operations (`CREATE_NODE`, `CONNECT_NODES`, `TRANSFORM_DIAGRAM`, …); anything the validator rejects is refused, never half-applied. |
| `import_mermaid` | Turn a Mermaid flowchart / state / mind-map into validated operations. |
| `export_mermaid` | Emit the board as Mermaid. |
| `list_external_links` | List the board's connected Linear / GitHub / Jira items. |
| `reset_board` | Clear the board (guarded). |

Every write goes through the core validator → pure reducer → inverse-op
history, so an agent's edits are checked, reversible, and never produce an
invalid board.

## Run

```bash
# From source (resolves @lucent/core via the development condition):
npm run dev -w @lucent/mcp

# Or build and run the compiled server:
npm run start -w @lucent/mcp   # runs dist/main.js
```

Remote mode (drive a real board on a running server) reads:

- `LUCENT_MCP_URL` — the Lucent server base URL
- `LUCENT_MCP_TOKEN` — a personal API token (Settings → Security → API tokens)
- `LUCENT_MCP_BOARD_ID` — the board to operate on

Without those it runs against a local in-memory board, so agents can be
developed offline.

## How it fits

The operation schema and the Mermaid converters live in `@lucent/core`
(`operations.ts`, `mermaid.ts`); this package is a thin, deterministic adapter
over them. See the repository's `AGENTS.md` for the architecture rules the
contract rests on.

## License

MIT — see [LICENSE](./LICENSE).
