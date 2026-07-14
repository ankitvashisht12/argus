# Contract — ARGUS VS Code extension v1 production-ready

Definition of done. Every box checked by an evaluator (fresh context), never by
the generator that wrote the code.

## Engine (`engine/`)

- [ ] 1. `npm test` green in engine/ (vitest), no network/claude/gh needed.
- [ ] 2. Diff parser: fixture unified diffs (add/delete/modify/rename/binary)
      parse to files+hunks with stable IDs `<path>:<sha>:h<n>`.
- [ ] 3. Claude adapter builds exact CLI args (schema-forced, tools disabled,
      no session persistence), feeds prompt via stdin, parses structured_output
      envelope, enforces timeout, falls back model on availability error —
      all unit-tested with a stubbed spawn.
- [ ] 4. Chat adapter streams (stream-json NDJSON) and surfaces deltas.
- [ ] 5. Review normalizer: unknown hunkIds dropped, duplicates deduped,
      anchors computed from real hunks, unreferenced hunks reported as
      uncovered — unit-tested.
- [ ] 6. Digest builder enforces per-hunk and total char budgets; truncation is
      reported, never silent.
- [ ] 7. gh wrapper constructs correct `gh api` calls for: PR meta, PR files,
      blob fetch, POST review (comments[], event) — unit-tested against
      recorded arg expectations.
- [ ] 8. Review result cached by content hash; cache hit skips claude.
- [ ] 9. No `vscode` import anywhere in engine/ (grep gate).

## Extension (`vscode/`)

- [ ] 10. `tsc --noEmit` clean across workspace; eslint clean.
- [ ] 11. `vsce package` produces a .vsix with no errors/warnings that block.
- [ ] 12. Command "ARGUS: Review PR" accepts a PR URL or number+repo.
- [ ] 13. Changed-files TreeView lists PR files with status/±counts; clicking
      opens native diff (argus:// base vs head); reviewed toggle persists
      across window reload (globalStorage).
- [ ] 14. Per-hunk AI notes render as collapsed comment threads at correct
      lines: "why this" + "look out for", importance-tagged.
- [ ] 15. Overview webview shows summary, intent, critical[], flow — renders
      from a fixture payload in dev mode without claude.
- [ ] 16. Sidebar webview: streaming chat works; per-file details update on
      active editor change.
- [ ] 17. User can add a comment thread on a diff line, edit, delete, and
      submit all as a GitHub review (comment/approve/request-changes).
- [ ] 18. Missing gh/claude → clear actionable message; diff viewing still
      works without AI.
- [ ] 19. Errored AI call renders as error state with retry — never as an
      empty "no findings" success.
- [ ] 20. Webviews pass CSP (no external resources), work in light+dark themes.

## Repo / release

- [ ] 21. THIRD-PARTY-NOTICES with codiff MIT license + copyright for vendored
      mechanics; LICENSE (MIT) at root; README with install/usage/screens.
- [ ] 22. Adversarial review pass (fresh context) on final code found no
      unresolved critical/high findings.
- [ ] 23. Live smoke test: load a real PR read-only end-to-end (fetch → review
      → threads render → overview) with user's gh/claude; result logged.
- [ ] 24. Git history: phased commits, each compiles; final tag v0.1.0.
