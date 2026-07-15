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
  buildStreamArgs,
  buildStructuredArgs,
  isModelAvailabilityError,
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
