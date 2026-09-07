# Evidence: shared-memory handoff experiment (2026-09-07)

- Date: 2026-09-07
- Path: managed production path
  (Codex -> installed PickleShell Memory MCP -> scoped broker
  `127.0.0.1:8767` -> production Mem0 backend `127.0.0.1:8766`)
- Scope: `codex-bos-v1`
- Marker stored by Agent A: `PICKLESHELL_SHARED_MEMORY_HANDOFF_20260907_A`
- Memory ID recovered by Agent B: `6a293b43-afe6-4b1c-9641-663c8896a58c`

## Procedure

1. Agent A (Codex session) stored architectural knowledge plus the marker
   into shared memory via the installed Memory MCP.
2. Agent B (completely fresh independent Codex session) received no
   transcript, no context from Agent A, and no memory ID.
3. Agent B performed a semantic search over the shared memory and located the
   memory by content.

## Result

- Agent B recovered the stored architecture and the marker.
- Verdict: **AGENT A -> SHARED MEM0 -> AGENT B HANDOFF PASS**.

## Interpretation and limits

- Proven: cross-session / independent-agent-session handoff using Codex
  through the managed production memory path.
- Not proven: cross-runtime handoff (for example, Codex -> OpenCode).
- This file is sanitized evidence only; no credentials, raw audit trails, or
  raw operator reports are reproduced here.
