# Contract — ARGUS VS Code extension v1 production-ready

Definition of done. Every box checked by an evaluator (fresh context), never by
the generator that wrote the code.

## Engine (`engine/`)

- [x] 1. `npm test` green in engine/ (vitest), no network/claude/gh needed.
- [x] 2. Diff parser: fixture unified diffs (add/delete/modify/rename/binary)
      parse to files+hunks with stable IDs `<path>:<sha>:h<n>`.
- [x] 3. Claude adapter builds exact CLI args (schema-forced, tools disabled,
      no session persistence), feeds prompt via stdin, parses structured_output
      envelope, enforces timeout, falls back model on availability error —
      all unit-tested with a stubbed spawn.
- [x] 4. Chat adapter streams (stream-json NDJSON) and surfaces deltas.
- [x] 5. Review normalizer: unknown hunkIds dropped, duplicates deduped,
      anchors computed from real hunks, unreferenced hunks reported as
      uncovered — unit-tested.
- [x] 6. Digest builder enforces per-hunk and total char budgets; truncation is
      reported, never silent.
- [x] 7. gh wrapper constructs correct `gh api` calls for: PR meta, PR files,
      blob fetch, POST review (comments[], event) — unit-tested against
      recorded arg expectations.
- [x] 8. Review result cached by content hash; cache hit skips claude.
- [x] 9. No `vscode` import anywhere in engine/ (grep gate).

## Extension (`vscode/`)

- [x] 10. `tsc --noEmit` clean across workspace; eslint clean.
- [x] 11. `vsce package` produces a .vsix with no errors/warnings that block.
- [x] 12. Command "ARGUS: Review PR" accepts a PR URL or number+repo.
- [x] 13. Changed-files TreeView lists PR files with status/±counts; clicking
      opens native diff (argus:// base vs head); reviewed toggle persists
      across window reload (globalStorage).
- [x] 14. Per-hunk AI notes render as collapsed comment threads at correct
      lines: "why this" + "look out for", importance-tagged.
- [x] 15. Overview webview shows summary, intent, critical[], flow — renders
      from a fixture payload in dev mode without claude.
- [x] 16. Sidebar webview: streaming chat works; per-file details update on
      active editor change.
- [x] 17. User can add a comment thread on a diff line, edit, delete, and
      submit all as a GitHub review (comment/approve/request-changes).
- [x] 18. Missing gh/claude → clear actionable message; diff viewing still
      works without AI.
- [x] 19. Errored AI call renders as error state with retry — never as an
      empty "no findings" success.
- [x] 20. Webviews pass CSP (no external resources), work in light+dark themes.

## Repo / release

- [x] 21. THIRD-PARTY-NOTICES with codiff MIT license + copyright for vendored
      mechanics; LICENSE (MIT) at root; README with install/usage/screens.
- [x] 22. Adversarial review pass (fresh context) on final code found no
      unresolved critical/high findings.
- [x] 23. Live smoke test: load a real PR read-only end-to-end (fetch → review
      → threads render → overview) with user's gh/claude; result logged.
- [x] 24. Git history: phased commits, each compiles; final tag v0.1.0.
