# Memory Distillation

You are given the material of **one day** of work (session summaries and/or dialogue excerpts) and the
list of memories that already exist. Extract the few facts worth remembering in future sessions.

The output is stored as long-term memory: it is injected into every new session, so a wrong entry
pollutes every later conversation. Precision matters far more than coverage.

## What to keep

- Projects the user worked on, and what actually changed (features, modules, files).
- The user's preferences, constraints and explicit requirements (language, style, workflow, tools).
- Decisions and conclusions that will still matter next week.
- Stable facts about the user's environment or stack once they are clearly established.

## What to drop

- Anything that only mattered that day (temporary debugging, dead ends, retries, experiments).
- Restatements of the process: write "The API was migrated to v2", never "The user asked X and you
  answered Y".
- Secrets, credentials, tokens and personal identifiers.
- Anything you cannot ground in the material. **Never invent.** If the material is thin, return fewer
  memories — an empty list is a perfectly good answer.

## Rules

1. `summary` is ONE self-contained sentence of at most 120 characters (hard limit 150) that still
   makes sense without the material.
2. Write `summary` in the SAME language as the material (Chinese material → Chinese summary).
3. `kind` is one of `user` (preferences, traits), `project` (work done), `decision` (a chosen
   approach) or `fact` (stable facts).
4. For `kind: "project"` items, also set `projectPath` to the **exact** `workspace:` string shown in
the material this fact comes from (copy it character by character, do not normalize or invent it).
   Memories with a `projectPath` are only injected into sessions working inside that directory, so a
   wrong path hides the memory from everyone. Omit `projectPath` when the material shows no
   `workspace:`, when several projects are involved and the item is not clearly about one of them, or
   for every other `kind`.
5. `level` is `normal` by default. Use `permanent` only for what must shape **every** future session
   (strong preferences, standing requirements); everything else stays `normal`.
6. Skip anything already covered by the existing memories below, including near-duplicates.
7. `tags` holds 0-3 short labels (project or topic names), never sentences.
8. If an item matters but does not fit in one line, set `needs_detail` to true and provide
   `detail_title` plus `detail_body` (the full detail, up to about 8000 characters). Otherwise omit
   both fields.
9. Return at most 10 memories. Few sharp memories beat many vague ones.

## Output format

Reply with strict JSON only — no markdown fences, no commentary:

{"memories":[{"summary":"...","kind":"project","level":"normal","projectPath":"C:/code/app","tags":["virlen-app"],"needs_detail":false}]}

## Existing memories (do not repeat)

{{existing}}

## Material of the day

{{material}}
