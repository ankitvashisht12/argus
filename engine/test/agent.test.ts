/**
 * Unit tests for the claude CLI adapter. No real `claude` process is ever
 * spawned: a stubbed spawn records argv + stdin and lets each test drive the
 * child's stdout/stderr/close/error events synchronously.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ClaudeAgent,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  REVIEW_TIMEOUT_BASE_MS,
  REVIEW_TIMEOUT_CAP_MS,
  REVIEW_TIMEOUT_PER_HUNK_MS,
  REVIEW_TIMEOUT_PER_KB_MS,
  buildStreamArgs,
  buildStructuredArgs,
  computeReviewTimeoutMs,
  isModelAvailabilityError,
  resolveReviewTimeoutMs,
  type ChatDelta,
  type ChildProcessLike,
  type SpawnLike,
} from '../src/agent/claude.js';

/* -------------------------------------------------------------------------- */
/* Fake child process + spawn recorder                                         */
/* -------------------------------------------------------------------------- */

interface SpawnCall {
  command: string;
  args: string[];
  cwd?: string;
}

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  stdinData = '';
  killed: NodeJS.Signals | number | undefined;
  readonly stdin = {
    on: () => this.stdin,
    end: (chunk: string, cb?: () => void) => {
      this.stdinData = chunk;
      cb?.();
      return this.stdin;
    },
  };

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = signal;
    return true;
  }

  // Test drivers -----------------------------------------------------------
  emitStdout(text: string): void {
    this.stdout.emit('data', text);
  }
  emitStderr(text: string): void {
    this.stderr.emit('data', text);
  }
  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }
  fail(error: Error): void {
    this.emit('error', error);
  }
}

interface Harness {
  spawn: SpawnLike;
  calls: SpawnCall[];
  children: FakeChild[];
  /** Wait a microtask so the adapter's async wiring runs before driving. */
  tick(): Promise<void>;
}

function makeHarness(): Harness {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    const child = new FakeChild();
    children.push(child);
    calls.push({ command, args: [...args], cwd: options.cwd });
    return child;
  };
  return { spawn, calls, children, tick: () => Promise.resolve() };
}

/** Build a valid `--output-format json` envelope string. */
function envelope(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

/* -------------------------------------------------------------------------- */

const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

describe('ClaudeAgent argv construction', () => {
  it('builds exact structured argv (no cwd)', () => {
    expect(buildStructuredArgs(schema, 'claude-opus-4-8')).toEqual([
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--model',
      'claude-opus-4-8',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--tools',
      '',
    ]);
  });

  it('inserts --add-dir when cwd is provided', () => {
    expect(buildStructuredArgs(schema, 'm', '/repo')).toContain('--add-dir');
    const args = buildStructuredArgs(schema, 'm', '/repo');
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/repo');
  });

  it('builds exact stream argv (schema omitted, verbose+partials)', () => {
    expect(buildStreamArgs('claude-sonnet-5')).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'claude-sonnet-5',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--tools',
      '',
    ]);
    expect(buildStreamArgs('m')).not.toContain('--json-schema');
  });
});

describe('runStructured — spawn wiring', () => {
  it('spawns the resolved command with exact argv and writes prompt to stdin', async () => {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: '/bin/claude' });

    const promise = agent.runStructured('review this PR', schema, {
      model: 'claude-opus-4-8',
      cwd: '/repo',
    });
    await h.tick();

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].command).toBe('/bin/claude');
    expect(h.calls[0].args).toEqual(
      buildStructuredArgs(schema, 'claude-opus-4-8', '/repo'),
    );
    expect(h.children[0].stdinData).toBe('review this PR');

    h.children[0].emitStdout(
      envelope({ result: '', structured_output: { ok: true } }),
    );
    h.children[0].finish(0);
    await expect(promise).resolves.toMatchObject({
      data: { ok: true },
      model: 'claude-opus-4-8',
    });
  });

  it('defaults to DEFAULT_MODEL when no model given', async () => {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const promise = agent.runStructured('p', schema);
    await h.tick();
    expect(h.calls[0].args).toContain(DEFAULT_MODEL);
    h.children[0].emitStdout(envelope({ structured_output: { ok: true } }));
    h.children[0].finish(0);
    await promise;
  });
});

describe('runStructured — envelope parsing', () => {
  async function run(stdout: string): Promise<unknown> {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const promise = agent.runStructured('p', schema);
    await h.tick();
    h.children[0].emitStdout(stdout);
    h.children[0].finish(0);
    return promise;
  }

  it('prefers structured_output over result text', async () => {
    const result = await run(
      envelope({
        result: '{"ok":false}',
        structured_output: { ok: true, from: 'structured' },
      }),
    );
    expect(result).toMatchObject({ data: { ok: true, from: 'structured' } });
    expect((result as { raw: string }).raw).toBe(
      JSON.stringify({ ok: true, from: 'structured' }),
    );
  });

  it('falls back to parsing result text when structured_output absent', async () => {
    const result = await run(envelope({ result: '{"ok":true,"via":"result"}' }));
    expect(result).toMatchObject({ data: { ok: true, via: 'result' } });
  });

  it('rejects on malformed (non-JSON) stdout', async () => {
    await expect(run('this is not json at all')).rejects.toThrow(/did not return JSON/);
  });

  it('rejects when neither structured_output nor JSON result is present', async () => {
    await expect(run(envelope({ result: 'plain prose, not json' }))).rejects.toThrow(
      /structured output/i,
    );
  });

  it('rejects when the envelope reports is_error', async () => {
    await expect(
      run(envelope({ is_error: true, result: 'rate limited' })),
    ).rejects.toThrow(/rate limited/);
  });
});

describe('runStructured — process failures', () => {
  it('rejects with stderr on non-zero exit', async () => {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const promise = agent.runStructured('p', schema);
    await h.tick();
    h.children[0].emitStderr('boom: something broke');
    h.children[0].finish(2);
    await expect(promise).rejects.toThrow(/boom: something broke/);
  });

  it('kills the child and rejects on timeout', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
      const promise = agent.runStructured('p', schema, { timeoutMs: 1000 });
      await Promise.resolve();
      const rejection = expect(promise).rejects.toThrow(/timed out/);
      vi.advanceTimersByTime(1001);
      await rejection;
      expect(h.children[0].killed).toBe('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a not-found error when the CLI cannot be located', async () => {
    const agent = new ClaudeAgent({
      spawn: makeHarness().spawn,
      findCommand: () => {
        throw Object.assign(new Error('nope'), { code: 'CLAUDE_NOT_FOUND' });
      },
    });
    await expect(agent.runStructured('p', schema)).rejects.toThrow(/claude` CLI was not found/);
  });

  it('rejects and kills when the abort signal fires', async () => {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const controller = new AbortController();
    const promise = agent.runStructured('p', schema, {
      signal: controller.signal,
    });
    await h.tick();
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/);
    expect(h.children[0].killed).toBe('SIGTERM');
  });
});

describe('runStructured — model fallback', () => {
  it('retries with fallback model on an availability error and fires callback', async () => {
    const h = makeHarness();
    const onModelFallback = vi.fn();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const promise = agent.runStructured('p', schema, {
      model: 'claude-opus-4-8',
      fallbackModel: 'claude-sonnet-5',
      onModelFallback,
    });

    // First attempt: model-availability failure.
    await h.tick();
    expect(h.calls[0].args).toContain('claude-opus-4-8');
    h.children[0].emitStderr('model_not_found: no access to that model');
    h.children[0].finish(1);

    // Second attempt: fallback model succeeds.
    await vi.waitFor(() => expect(h.calls).toHaveLength(2));
    expect(h.calls[1].args).toContain('claude-sonnet-5');
    h.children[1].emitStdout(envelope({ structured_output: { ok: true } }));
    h.children[1].finish(0);

    const result = await promise;
    expect(result.model).toBe('claude-sonnet-5');
    expect(onModelFallback).toHaveBeenCalledWith(
      'claude-sonnet-5',
      'claude-opus-4-8',
    );
    expect(h.calls).toHaveLength(2);
  });

  it('does NOT retry on a non-availability error', async () => {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const promise = agent.runStructured('p', schema, {
      model: 'a',
      fallbackModel: 'b',
    });
    await h.tick();
    h.children[0].emitStderr('unrelated crash');
    h.children[0].finish(1);
    await expect(promise).rejects.toThrow(/unrelated crash/);
    expect(h.calls).toHaveLength(1);
  });

  it('does NOT retry when model already equals fallbackModel', async () => {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const promise = agent.runStructured('p', schema, {
      model: 'same',
      fallbackModel: 'same',
    });
    await h.tick();
    h.children[0].emitStderr('model_not_found');
    h.children[0].finish(1);
    await expect(promise).rejects.toThrow(/model_not_found/);
    expect(h.calls).toHaveLength(1);
  });
});

describe('chatStream — NDJSON parsing', () => {
  function textDelta(text: string): string {
    return JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
  }
  function thinkingDelta(thinking: string): string {
    return JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking },
      },
    });
  }

  it('emits text + thinking deltas across chunk boundaries and returns full text', async () => {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const deltas: ChatDelta[] = [];
    const promise = agent.chatStream('hi', undefined, (d) => deltas.push(d));
    await h.tick();

    // stream argv used, no schema
    expect(h.calls[0].args).toContain('stream-json');
    expect(h.calls[0].args).not.toContain('--json-schema');

    // Split a line across two chunks to exercise the line buffer.
    const line = textDelta('Hello');
    h.children[0].emitStdout(line.slice(0, 5));
    h.children[0].emitStdout(line.slice(5) + '\n');
    h.children[0].emitStdout(thinkingDelta('pondering') + '\n');
    h.children[0].emitStdout(textDelta(' world') + '\n');
    h.children[0].emitStdout(
      JSON.stringify({ type: 'result', result: 'Hello world', is_error: false }) +
        '\n',
    );
    h.children[0].finish(0);

    const full = await promise;
    expect(full).toBe('Hello world');
    expect(deltas.filter((d) => d.type === 'text').map((d) => d.text)).toEqual([
      'Hello',
      ' world',
    ]);
    expect(deltas.find((d) => d.type === 'thinking')?.text).toBe('pondering');
    expect(deltas.at(-1)).toEqual({ type: 'done', text: '' });
  });

  it('falls back to result envelope text when no text deltas stream', async () => {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const deltas: ChatDelta[] = [];
    const promise = agent.chatStream('hi', undefined, (d) => deltas.push(d));
    await h.tick();
    h.children[0].emitStdout(
      JSON.stringify({ type: 'result', result: 'final answer' }) + '\n',
    );
    h.children[0].finish(0);
    expect(await promise).toBe('final answer');
    expect(deltas.some((d) => d.type === 'text' && d.text === 'final answer')).toBe(
      true,
    );
  });

  it('emits an error delta and rethrows on process failure', async () => {
    const h = makeHarness();
    const agent = new ClaudeAgent({ spawn: h.spawn, claudePath: 'claude' });
    const deltas: ChatDelta[] = [];
    const promise = agent.chatStream('hi', undefined, (d) => deltas.push(d));
    await h.tick();
    h.children[0].emitStderr('stream exploded');
    h.children[0].finish(1);
    await expect(promise).rejects.toThrow(/stream exploded/);
    expect(deltas.some((d) => d.type === 'error')).toBe(true);
  });
});

describe('isAvailable', () => {
  it('returns true when the command resolves', async () => {
    const agent = new ClaudeAgent({ claudePath: '/bin/claude' });
    expect(await agent.isAvailable()).toBe(true);
  });

  it('returns false when discovery throws', async () => {
    const agent = new ClaudeAgent({
      findCommand: () => {
        throw new Error('not found');
      },
    });
    expect(await agent.isAvailable()).toBe(false);
  });
});

describe('computeReviewTimeoutMs — scales with digest size', () => {
  it('is the base budget for an (impossibly) empty digest', () => {
    expect(computeReviewTimeoutMs({ hunkCount: 0, digestChars: 0 })).toBe(
      REVIEW_TIMEOUT_BASE_MS,
    );
  });

  it('adds a per-hunk and per-KB increment', () => {
    // 4 hunks, ~4 KB (4096 chars → 4 KB exactly).
    expect(computeReviewTimeoutMs({ hunkCount: 4, digestChars: 4096 })).toBe(
      REVIEW_TIMEOUT_BASE_MS +
        4 * REVIEW_TIMEOUT_PER_HUNK_MS +
        4 * REVIEW_TIMEOUT_PER_KB_MS,
    );
  });

  it('rounds partial kilobytes up (a single char still costs one KB)', () => {
    expect(computeReviewTimeoutMs({ hunkCount: 0, digestChars: 1 })).toBe(
      REVIEW_TIMEOUT_BASE_MS + REVIEW_TIMEOUT_PER_KB_MS,
    );
  });

  it('comfortably exceeds the observed ~75s cost of a small 2-file PR', () => {
    // A 2-file toy PR (say 3 hunks, ~3 KB) took ~75s in the field; the scaled
    // budget must give real headroom over that.
    const ms = computeReviewTimeoutMs({ hunkCount: 3, digestChars: 3072 });
    expect(ms).toBeGreaterThan(75_000);
  });

  it('clamps a very large PR to the cap', () => {
    const ms = computeReviewTimeoutMs({ hunkCount: 500, digestChars: 500_000 });
    expect(ms).toBe(REVIEW_TIMEOUT_CAP_MS);
  });

  it('floors negative / NaN inputs to zero (never below the base budget)', () => {
    expect(computeReviewTimeoutMs({ hunkCount: -5, digestChars: -100 })).toBe(
      REVIEW_TIMEOUT_BASE_MS,
    );
    expect(computeReviewTimeoutMs({ hunkCount: NaN, digestChars: NaN })).toBe(
      REVIEW_TIMEOUT_BASE_MS,
    );
  });
});

describe('resolveReviewTimeoutMs — setting override', () => {
  const digest = { hunkCount: 4, digestChars: 4096 };

  it('honors a positive override (seconds → ms) verbatim', () => {
    expect(resolveReviewTimeoutMs(300, digest)).toBe(300_000);
  });

  it('honors an override above the auto cap (explicit user choice wins)', () => {
    expect(resolveReviewTimeoutMs(900, digest)).toBe(900_000);
    expect(900_000).toBeGreaterThan(REVIEW_TIMEOUT_CAP_MS);
  });

  it.each([undefined, null, 0, -30, NaN])(
    'falls back to the computed timeout for %j',
    (value) => {
      expect(resolveReviewTimeoutMs(value as number | null | undefined, digest)).toBe(
        computeReviewTimeoutMs(digest),
      );
    },
  );
});

describe('isModelAvailabilityError', () => {
  it.each([
    'model_not_found',
    'unknown model foo',
    'you do not have access to model x',
    'HTTP 403 forbidden',
    'error 404',
  ])('classifies %j as availability error', (msg) => {
    expect(isModelAvailabilityError(msg)).toBe(true);
  });

  it.each(['network timeout', 'disk full', 'syntax error'])(
    'does not misclassify %j',
    (msg) => {
      expect(isModelAvailabilityError(msg)).toBe(false);
    },
  );
});
