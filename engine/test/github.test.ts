/**
 * Unit tests for the `gh` CLI wrapper (contract item 7). A stubbed exec records
 * exact argv + stdin and returns canned output; no real process is spawned and
 * no network is touched.
 */

import { describe, expect, it } from 'vitest';

import {
  BlobNotFoundError,
  GhClient,
  GhError,
  PendingReviewError,
  type GhExec,
  type GhExecOptions,
  type GhExecResult,
} from '../src/github/gh.js';
import type { SubmitReviewInput } from '../src/types.js';

interface RecordedCall {
  readonly args: string[];
  readonly stdin: string | undefined;
}

type Responder = (
  args: readonly string[],
  options?: GhExecOptions,
) => Partial<GhExecResult>;

/** Build a stub exec that returns queued responses and records every call. */
function stubExec(
  responses: Array<Partial<GhExecResult> | Responder>,
): { exec: GhExec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  const exec: GhExec = async (args, options) => {
    calls.push({ args: [...args], stdin: options?.stdin });
    const next = responses[index++];
    const partial =
      typeof next === 'function' ? next(args, options) : next ?? {};
    return {
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      code: partial.code ?? 0,
    };
  };
  return { exec, calls };
}

describe('GhClient.prMeta', () => {
  it('calls the pulls endpoint and maps the metadata', async () => {
    const { exec, calls } = stubExec([
      {
        stdout: JSON.stringify({
          title: 'Add feature',
          body: 'Body text',
          base: { ref: 'main', sha: 'basesha' },
          head: { ref: 'feature/x', sha: 'headsha' },
          user: { login: 'octocat' },
        }),
      },
    ]);
    const gh = new GhClient(exec);
    const meta = await gh.prMeta('acme', 'widgets', 42);

    expect(calls[0]!.args).toEqual(['api', 'repos/acme/widgets/pulls/42']);
    expect(meta).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      title: 'Add feature',
      body: 'Body text',
      baseSha: 'basesha',
      headSha: 'headsha',
      baseRef: 'main',
      headRef: 'feature/x',
      author: 'octocat',
    });
  });

  it('tolerates a null body', async () => {
    const { exec } = stubExec([
      {
        stdout: JSON.stringify({
          title: 't',
          body: null,
          base: { ref: 'main', sha: 'b' },
          head: { ref: 'h', sha: 'h' },
          user: { login: 'u' },
        }),
      },
    ]);
    const meta = await new GhClient(exec).prMeta('o', 'r', 1);
    expect(meta.body).toBe('');
  });
});

describe('GhClient.prDiff', () => {
  it('uses `gh pr diff` and returns the raw diff text', async () => {
    const diff = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n';
    const { exec, calls } = stubExec([{ stdout: diff }]);
    const out = await new GhClient(exec).prDiff('acme', 'widgets', 42);

    expect(calls[0]!.args).toEqual([
      'pr',
      'diff',
      '42',
      '--repo',
      'acme/widgets',
    ]);
    expect(out).toBe(diff);
  });
});

describe('GhClient.prFiles', () => {
  it('paginates, flattens, and normalizes file status', async () => {
    const pages = [
      [
        { filename: 'a.ts', status: 'modified', additions: 3, deletions: 1 },
        { filename: 'b.ts', status: 'added', additions: 10, deletions: 0 },
      ],
      [
        {
          filename: 'c.ts',
          previous_filename: 'old-c.ts',
          status: 'renamed',
          additions: 0,
          deletions: 0,
        },
        { filename: 'd.ts', status: 'removed', additions: 0, deletions: 8 },
      ],
    ];
    const { exec, calls } = stubExec([{ stdout: JSON.stringify(pages) }]);
    const files = await new GhClient(exec).prFiles('acme', 'widgets', 42);

    expect(calls[0]!.args).toEqual([
      'api',
      '--paginate',
      '--slurp',
      'repos/acme/widgets/pulls/42/files?per_page=100',
    ]);
    expect(files).toEqual([
      { path: 'a.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'b.ts', status: 'added', additions: 10, deletions: 0 },
      {
        path: 'c.ts',
        previousPath: 'old-c.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
      },
      { path: 'd.ts', status: 'deleted', additions: 0, deletions: 8 },
    ]);
  });
});

describe('GhClient.fetchBlob', () => {
  it('fetches contents by path@ref and base64-decodes', async () => {
    const content = Buffer.from('hello world\n', 'utf8').toString('base64');
    const { exec, calls } = stubExec([
      { stdout: JSON.stringify({ encoding: 'base64', content, sha: 'abc' }) },
    ]);
    const out = await new GhClient(exec).fetchBlob(
      'acme',
      'widgets',
      'src/dir/file name.ts@feature/x',
    );

    expect(calls[0]!.args).toEqual([
      'api',
      'repos/acme/widgets/contents/src/dir/file%20name.ts?ref=feature%2Fx',
    ]);
    expect(out).toBe('hello world\n');
  });

  it('falls back to the blob endpoint for >1MB files', async () => {
    const content = Buffer.from('big file body', 'utf8').toString('base64');
    const { exec, calls } = stubExec([
      // contents API: empty body but carries a sha
      {
        stdout: JSON.stringify({ encoding: 'none', content: '', sha: 'blobsha' }),
      },
      // blob endpoint returns the real base64
      { stdout: JSON.stringify({ encoding: 'base64', content }) },
    ]);
    const out = await new GhClient(exec).fetchBlob(
      'acme',
      'widgets',
      'big.bin@main',
    );

    expect(calls[0]!.args).toEqual([
      'api',
      'repos/acme/widgets/contents/big.bin?ref=main',
    ]);
    expect(calls[1]!.args).toEqual([
      'api',
      'repos/acme/widgets/git/blobs/blobsha',
    ]);
    expect(out).toBe('big file body');
  });

  it('fetches by bare blob SHA (no @)', async () => {
    const content = Buffer.from('blob contents', 'utf8').toString('base64');
    const { exec, calls } = stubExec([
      { stdout: JSON.stringify({ encoding: 'base64', content }) },
    ]);
    const out = await new GhClient(exec).fetchBlob('acme', 'widgets', 'deadbeef');

    expect(calls[0]!.args).toEqual([
      'api',
      'repos/acme/widgets/git/blobs/deadbeef',
    ]);
    expect(out).toBe('blob contents');
  });

  it('throws BlobNotFoundError on 404 (file absent on that side)', async () => {
    const { exec } = stubExec([
      { code: 1, stderr: 'gh: Not Found (HTTP 404)' },
    ]);
    await expect(
      new GhClient(exec).fetchBlob('acme', 'widgets', 'added.ts@main'),
    ).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it('propagates non-404 errors as GhError', async () => {
    const { exec } = stubExec([{ code: 1, stderr: 'gh: Server Error (HTTP 500)' }]);
    await expect(
      new GhClient(exec).fetchBlob('acme', 'widgets', 'x.ts@main'),
    ).rejects.toBeInstanceOf(GhError);
  });
});

describe('GhClient.submitReview', () => {
  it('POSTs the review with exact argv and stdin payload', async () => {
    const { exec, calls } = stubExec([{ stdout: '{}' }]);
    const input: SubmitReviewInput = {
      event: 'REQUEST_CHANGES',
      body: 'Please fix.',
      comments: [
        {
          path: 'a.ts',
          line: 12,
          side: 'RIGHT',
          body: 'Nit here',
        },
        {
          path: 'b.ts',
          line: 20,
          side: 'RIGHT',
          startLine: 18,
          startSide: 'RIGHT',
          body: 'Range comment',
        },
      ],
    };
    await new GhClient(exec).submitReview('acme', 'widgets', 42, input);

    expect(calls[0]!.args).toEqual([
      'api',
      '--method',
      'POST',
      'repos/acme/widgets/pulls/42/reviews',
      '--input',
      '-',
    ]);
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({
      event: 'REQUEST_CHANGES',
      body: 'Please fix.',
      comments: [
        { path: 'a.ts', line: 12, body: 'Nit here', side: 'RIGHT' },
        {
          path: 'b.ts',
          line: 20,
          body: 'Range comment',
          side: 'RIGHT',
          start_line: 18,
          start_side: 'RIGHT',
        },
      ],
    });
  });

  it('rejects an empty COMMENT review before spawning gh', async () => {
    const { exec, calls } = stubExec([]);
    await expect(
      new GhClient(exec).submitReview('acme', 'widgets', 42, {
        event: 'COMMENT',
        comments: [],
      }),
    ).rejects.toThrow(/inline comment or a body/);
    expect(calls).toHaveLength(0);
  });

  it('diagnoses a 422 as an existing pending review', async () => {
    const { exec, calls } = stubExec([
      // POST fails with 422
      { code: 1, stderr: 'gh: Validation Failed (HTTP 422)' },
      // reviews listing shows a PENDING review
      { stdout: JSON.stringify([[{ state: 'PENDING' }, { state: 'APPROVED' }]]) },
    ]);
    await expect(
      new GhClient(exec).submitReview('acme', 'widgets', 42, {
        event: 'APPROVE',
        comments: [],
      }),
    ).rejects.toBeInstanceOf(PendingReviewError);

    expect(calls[1]!.args).toEqual([
      'api',
      '--paginate',
      '--slurp',
      'repos/acme/widgets/pulls/42/reviews?per_page=100',
    ]);
  });

  it('rethrows a 422 that is not a pending review', async () => {
    const { exec } = stubExec([
      { code: 1, stderr: 'gh: Validation Failed (HTTP 422)' },
      { stdout: JSON.stringify([[{ state: 'APPROVED' }]]) },
    ]);
    await expect(
      new GhClient(exec).submitReview('acme', 'widgets', 42, {
        event: 'APPROVE',
        comments: [],
      }),
    ).rejects.toBeInstanceOf(GhError);
  });
});

describe('GhClient availability', () => {
  it('isAvailable reflects `gh --version` exit code', async () => {
    const okClient = new GhClient(
      stubExec([{ code: 0, stdout: 'gh version 2.x' }]).exec,
    );
    expect(await okClient.isAvailable()).toBe(true);

    const failClient = new GhClient(async () => {
      throw new Error('ENOENT');
    });
    expect(await failClient.isAvailable()).toBe(false);
  });

  it('isAuthed reflects `gh auth status` exit code', async () => {
    const authed = stubExec([{ code: 0 }]);
    expect(await new GhClient(authed.exec).isAuthed()).toBe(true);
    expect(authed.calls[0]!.args).toEqual(['auth', 'status']);

    const unauthed = new GhClient(stubExec([{ code: 1, stderr: 'not logged in' }]).exec);
    expect(await unauthed.isAuthed()).toBe(false);
  });
});
