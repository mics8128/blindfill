import { spawn } from 'node:child_process';
import { BlindfillError } from '../core/types.js';
import { globalScrubber } from '../core/scrubber.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}
export interface RunOpts {
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs?: number;
}
/** Injectable so backends can be contract-tested against recorded fixtures. */
export type Runner = (bin: string, args: string[], opts?: RunOpts) => Promise<RunResult>;

/** A configured Node script (.js/.mjs/.cjs) runs under this Node: Windows cannot exec a shebang file. */
export function viaNode(bin: string, args: string[]): [string, string[]] {
  return /\.[cm]?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

export const execRunner: Runner = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(...viaNode(bin, args), {
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new BlindfillError(
          'BACKEND',
          e.code === 'ENOENT' ? `executable not found: ${bin}` : `failed to run ${bin}: ${e.code ?? 'error'}`,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
  });

/** Make vendor-CLI stderr safe to show: first line, no session tokens, scrubbed. */
export function safeErr(stderr: string, extraSecrets: (string | undefined)[] = []): string {
  let s = stderr.split('\n').find((l) => l.trim()) ?? 'unknown error';
  for (const x of extraSecrets) if (x && x.length >= 4) s = s.split(x).join('[REDACTED]');
  s = globalScrubber.scrub(s);
  return s.slice(0, 200);
}

export function parseJson<T>(s: string, what: string): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    // never echo the payload: it may contain secrets
    throw new BlindfillError('BACKEND', `${what}: output was not valid JSON`);
  }
}
