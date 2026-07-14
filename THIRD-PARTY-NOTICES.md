# Third-Party Notices

ARGUS incorporates or adapts material from third-party open-source projects.
The projects and their license terms are reproduced below.

---

## codiff — github.com/nkzw-tech/codiff

ARGUS adapts **mechanics only** from codiff (not its prompts, review/walkthrough
schema, digest wording, or any product-facing text — those remain codiff's own
product identity). Specifically, ARGUS adapts:

- the **claude CLI adapter pattern**: spawning the `claude` CLI in headless mode
  (`-p --output-format json/stream-json --json-schema <schema>
  --permission-mode dontAsk --no-session-persistence --tools ''`), feeding the
  prompt on stdin, parsing the `structured_output` envelope, and consuming
  `stream-json` NDJSON events for progress, with timeouts and model fallback;
- the **hunk-ID anchoring approach**: the model returns request-local hunk-ID
  aliases (never line numbers), and a normalizer resolves those IDs against the
  parsed diff to compute line anchors, dropping unresolvable IDs and sweeping
  unreferenced hunks into a coverage bucket;
- the **`gh api` call shapes** used to fetch PR metadata/files/blobs and to POST
  a pull-request review with inline comments.

ARGUS's prompts, review schema, reviewer-skeptic framing, and intent pipeline
are original and derive from the argus-go lineage, not from codiff.

Original copyright and license:

```
The MIT License (MIT)

Copyright (c) 2026 Nakazawa Tech

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
