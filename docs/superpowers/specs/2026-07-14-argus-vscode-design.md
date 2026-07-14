# ARGUS VS Code Extension — v1 Design

Date: 2026-07-14. Status: approved for autonomous implementation (Ankit delegated).

## What

ARGUS is an AI-first PR review extension for VS Code. It fetches a GitHub PR,
generates an AI review with a **reviewer-skeptic lens**, and presents it inside
VS Code using native surfaces:

- **File tree** (primary sidebar TreeView): changed files, reviewed-state toggle.
- **Diff** (native VS Code diff editor): base vs head content served by a
  `TextDocumentContentProvider`.
- **Per-hunk notes** (Comments API): each hunk gets a thread with two AI notes —
  *why this change* and *look out for* (the skeptic note).
- **Overview tab** (webview panel): PR summary, **intent**, critical things to
  know, understand-the-flow narrative.
- **Chat + details** (secondary-sidebar webview): streaming chat about the PR /
  open file, per-file summary.
- **Reviewer comments → GitHub**: user writes comments in threads; submit as a
  GitHub review (comment / approve / request changes) via `gh api`.

v1 scope: **GitHub PRs only** (no local branch mode — fast-follow). English UI.
Open-source under MIT.

## Why these pieces (provenance)

- VS Code is the battle-tested UI engine (diff rendering, comment threads,
  distribution) — replaces argus-go's hand-rolled TUI/web.
- **Vendored from codiff (MIT, github.com/nkzw-tech/codiff)** — mechanics only,
  adapted with attribution in THIRD-PARTY-NOTICES:
  - claude CLI adapter pattern: `spawn claude -p --output-format json
    --json-schema <schema> --tools '' --permission-mode dontAsk
    --no-session-persistence`, prompt on stdin, structured_output envelope,
    stream-json for progress, timeouts + model fallback.
  - **Hunk-ID anchoring**: the LLM returns hunk IDs (`h1, h2, …` request-local
    aliases), never line numbers; a normalizer resolves IDs against the parsed
    diff and computes line anchors. Unresolvable IDs are dropped, unreferenced
    hunks swept into a "support" bucket so coverage is honest.
  - `gh api` posting shapes for PR review comments and reviews.
- **NOT copied**: codiff's prompts, walkthrough schema, digest wording — that's
  their product (author-narrative). Ours is reviewer-skeptic + explicit intent.
  Prompt lineage instead comes from argus-go's brief/intent/per-file pipeline.

## Repo layout

```
argus/
  engine/          # @argus/engine — pure Node/TS library, no vscode imports
    src/
      agent/       # claude CLI adapter (vendored mechanics, TS)
      github/      # gh CLI wrapper: PR meta, files, blobs, post review
      diff/        # unified-diff parse → files/hunks with stable hunk IDs
      review/      # digest builder, prompts, schemas, normalizer (anchoring)
      store/       # on-disk cache: review results keyed by content hash
    test/          # vitest unit tests (fixtures, no network/claude needed)
  vscode/          # the extension (depends on engine via workspace)
    src/
      extension.ts       # activation, commands
      prSession.ts       # loaded-PR state machine
      tree.ts            # changed-files TreeView + reviewed state
      contentProvider.ts # argus:// base/head virtual documents for diff editor
      comments.ts        # Comments API: AI hunk threads + user draft threads
      overviewPanel.ts   # webview: summary/intent/critical/flow
      sidebar.ts         # secondary-sidebar webview: chat + file details
      github.ts          # submit review flow (calls engine)
    media/         # webview assets (self-contained, CSP-safe)
  landing-page/
  docs/
```

## Data flow

1. Command `ARGUS: Review PR…` → pick repo/PR (or paste URL/number).
2. Engine: `gh` fetches PR meta (title, body, head sha), diff, and base/head
   file contents (blobs, cached under globalStorage).
3. Diff parser produces `FileChange[]` with `Hunk{id, oldRange, newRange,
   patch}` — IDs are `<path>:<headSha>:h<n>`.
4. Review pipeline (one structured claude call, chunked if digest exceeds
   budget): input = PR title/body (intent source) + budgeted digest of all
   hunks with aliases; output schema:
   ```
   { version, summary, intent, critical[], flow[],           // overview
     files[{path, role, note}],                              // per-file
     hunks[{hunkId, why, lookout, importance}] }             // per-hunk
   ```
5. Normalizer resolves hunkIds → line anchors; drops bad IDs; unreferenced
   hunks listed as uncovered.
6. UI renders: tree, comment threads at anchors, overview panel, sidebar.
7. Chat: streaming claude call scoped to PR digest + open file.
8. User comment threads → `gh api` POST review with comments + event.

Result cached by content hash so reopening a PR is instant; regenerate command
bypasses cache.

## Error handling

- `gh`/`claude` missing or unauthed → actionable error with install/login hint;
  extension still opens the diff without AI (mirrors argus-go's degrade path).
- claude timeout/malformed JSON → retry once, then surface per-surface error
  state (never render an errored review as "no findings" — argus-go lesson).
- Oversized PRs → digest budgeter truncates per-hunk excerpts, notes coverage.

## Testing

- Engine: vitest unit tests on fixtures (diff parsing, ID normalization against
  crafted digests, prompt building, gh arg construction, cache). No network.
- Extension: unit tests for pure logic (anchor mapping, state). Compile gate
  (`tsc`), lint, `vsce package` gate.
- Evaluator passes (separate contexts) per loops.md: adversarial review of each
  phase; final smoke test drives a real PR read-only with the user's gh/claude.

## Non-goals (v1)

Local branch diffs, GitLab, multi-agent backends (codex etc.), web/TUI faces,
settings UI beyond model pick, comment thread sync from GitHub.
