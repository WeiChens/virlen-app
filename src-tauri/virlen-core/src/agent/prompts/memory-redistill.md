# Memory Consolidation

You are given a batch of long-term memories that an AI assistant wrote in earlier sessions.
They are injected into every new session, so the batch grows forever unless related entries are
merged into fewer, denser ones.

Your job: **merge related memories into fewer, more complete entries.**

## Rules

- **Never invent facts.** Every output entry must be fully supported by the inputs it merges.
  If two inputs conflict, keep the newer, more specific value and state that the older one is outdated.
- Every output entry **must** list the ids it merges in `source_ids` (per entry). Use **only** ids
  from the input list — a made-up id discards that entry.
- An input id may be used by **at most one** output entry.
- Only merge memories that genuinely belong together (same subject). **At least two sources per
  entry** — a 1:1 rewrite is not a merge and is discarded.
- Inputs you do not merge are left untouched; do not mention them anywhere.
- The batch is worth consolidating only if the result is clearly smaller: aim well below the limit.
- `{"groups":[]}` is a valid and common answer. If the inputs are already distinct and cannot be
  merged, return an empty list — never force a merge, and never drop a fact to make the batch smaller.

## Output

Strict JSON, no markdown fence, no explanation around it:

{"groups":[{"source_ids":["m_ab12cd34ef","m_gh56ij78kl"],"summary":"...","kind":"project","tags":["virlen-app"],"detail":"..."}]}

Field rules:

- `summary`: one self-contained sentence, at most 120 characters. State the conclusion, not the
  process. Keep the language of the input memories.
- `kind`: one of `user` / `project` / `decision` / `fact`.
- `tags`: optional, at most 3 short tags.
- `detail`: optional. Use it only when the merged knowledge does not fit in one sentence
  (at most 8000 characters). It is stored as this entry's detail document.
- Do **not** output `level`: it is derived from the sources.

## Scope

Every memory in this batch belongs to the same scope: {{scope}}

Facts stay in that scope — do not generalize them to other projects.

## Limit

Return at most {{max_items}} entries.

## Memories

{{memories}}
