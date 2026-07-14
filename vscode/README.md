# ARGUS — AI PR Review for VS Code

ARGUS fetches a GitHub pull request, generates an AI review with a
**reviewer-skeptic lens**, and presents it inside VS Code using native surfaces —
no separate web UI or TUI.

## Features

- **Changed-files tree** with per-file status, ±line counts, and a reviewed-state
  toggle that persists across window reloads.
- **Native diff** (base vs head) served by a virtual `argus://` document provider.
- **Per-hunk AI notes** as collapsed comment threads: *why this change* and the
  skeptic *look out for*, tagged by importance.
- **Overview panel**: plain-language summary, explicit **intent**, critical things
  to verify, and an understand-the-flow narrative.
- **Sidebar chat**: streaming Q&A about the PR, scoped to the open file.
- **Submit to GitHub**: write review comments on diff lines and submit them as a
  single review — comment, approve, or request changes.

## Requirements

- [`gh`](https://cli.github.com) — the GitHub CLI, installed and authenticated
  (`gh auth login`). Required to fetch PRs and submit reviews.
- [Claude Code](https://claude.com/claude-code) (`claude`) — optional. Without it
  the diff and files still open; the AI review is skipped and can be regenerated
  once `claude` is available.

## Usage

1. Run **ARGUS: Review PR…** and paste a PR URL or `owner/repo#number`.
2. Browse the changed files, open diffs, and read the per-hunk notes.
3. Open **ARGUS: Open Overview** for the summary / intent / critical / flow.
4. Add your own comments on diff lines, then **ARGUS: Submit Review to GitHub**.

Try it without a live PR via **ARGUS: Open Demo Review (fixture)**.

## Commands

| Command | Description |
| --- | --- |
| `ARGUS: Review PR…` | Load a PR by URL or `owner/repo#number`. |
| `ARGUS: Open Overview` | Open the summary / intent / critical / flow panel. |
| `ARGUS: Regenerate Review` | Re-run the AI review, bypassing the cache. |
| `ARGUS: Submit Review to GitHub` | Submit draft comments as a GitHub review. |
| `ARGUS: Open Demo Review (fixture)` | Load the bundled demo fixture offline. |

## License

MIT. See `LICENSE`. Vendored mechanics are attributed in
`THIRD-PARTY-NOTICES.md`.
