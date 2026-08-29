# 0012 — The response cache is keyed on prompt identity, and it is opt-in

- Status: Accepted
- Date: 2026-08-28

## Context

Identical AI requests recur: a client retry after a dropped socket, a demo
replaying the same ask, an eval run over the same golden set. Each pays tokens
and latency. But real providers sample — the same prompt can legitimately answer
differently — and a cache that silently serves stale-shaped answers to an edited
prompt is a bug factory.

## Decision

`ResponseCache` (packages/ai/src/cache.ts) is an in-process LRU with TTL,
opt-in per call site. The key is a sha256 over a canonical (stable-stringified)
tuple of: provider name, prompt id, prompt version, hash of the rendered prompt
text, and the full request — so a prompt bump or a hand-edit of prompt text
invalidates every key minted before it, by construction. Requests carrying
images or documents are not cacheable: their bytes do not belong in a key, and
truncating them to fit would collide different attachments. Hits are indistinguishable
from misses to the caller's validation path — cached output passes through the
same schema parse and semantic validation as fresh output.

## Consequences

- Retries and replays are free; the sampling behaviour of a live provider is
  unaffected for deployments that do not opt in.
- A multi-instance deployment shares no cache; a miss costs one provider call,
  which is the un-cached baseline — so the cache can only ever help, never
  become load-bearing correctness.
- Cache entries are answers, not truth: the board store never reads from the
  cache, and clearing it is always safe.
