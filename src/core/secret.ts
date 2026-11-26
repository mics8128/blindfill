import { inspect } from 'node:util';
import { BlindfillError } from './types.js';

export type SecretSink = (value: Buffer) => void | Promise<void>;

/**
 * Write-only container for a Secret-class value.
 *
 * - toString / toJSON throw; util.inspect and console.log print a fixed marker.
 * - `into(sink)` can be called once. The buffer handed to the sink is zero-filled
 *   after the sink returns (sinks must not retain it).
 * - No getter exists. The value lives in an ES private field.
 */
export class SecretHandle {
  #buf: Buffer | null;
  readonly label: string;

  constructor(value: Buffer | string, label = 'secret') {
    this.#buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    // the caller's Buffer copy is theirs to wipe; strings cannot be wiped.
    this.label = label;
  }

  get length(): number {
    return this.#buf ? this.#buf.length : 0;
  }

  get consumed(): boolean {
    return this.#buf === null;
  }

  async into(sink: SecretSink): Promise<void> {
    const buf = this.#buf;
    if (!buf) throw new BlindfillError('SECRET_ACCESS', 'SecretHandle already consumed');
    this.#buf = null;
    try {
      await sink(buf);
    } finally {
      buf.fill(0);
    }
  }

  /** Discard without using. */
  destroy(): void {
    this.#buf?.fill(0);
    this.#buf = null;
  }

  toString(): never {
    throw new BlindfillError('SECRET_ACCESS', 'SecretHandle cannot be converted to a string');
  }
  toJSON(): never {
    throw new BlindfillError('SECRET_ACCESS', 'SecretHandle cannot be serialised');
  }
  [Symbol.toPrimitive](): never {
    throw new BlindfillError('SECRET_ACCESS', 'SecretHandle cannot be converted to a primitive');
  }
  [inspect.custom](): string {
    return `[SecretHandle ${this.label}]`;
  }
}
