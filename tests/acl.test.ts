import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aclIsPrivate, mkdirPrivate, windowsPathsPrivate } from '../src/core/acl.js';

const ME = 'S-1-5-21-1-2-3-1001';

describe('aclIsPrivate (owner + allow ACE SIDs)', () => {
  it('accepts only me, SYSTEM, Administrators and the creator placeholders', () => {
    expect(aclIsPrivate(`${ME}\r\n${ME} ${ME} S-1-5-18 S-1-5-32-544 S-1-3-0\r\n`, 1)).toBe(true);
    expect(aclIsPrivate(`${ME}\nS-1-5-32-544 S-1-5-18\n${ME}\n`, 2)).toBe(true);
  });
  it('refuses Users, Everyone, Authenticated Users, other accounts and foreign owners', () => {
    for (const other of ['S-1-5-32-545', 'S-1-1-0', 'S-1-5-11', 'S-1-5-21-1-2-3-1002'])
      expect(aclIsPrivate(`${ME}\n${ME} ${ME} ${other}\n`, 1)).toBe(false);
    expect(aclIsPrivate(`${ME}\nS-1-5-21-9-9-9-500 ${ME}\n`, 1)).toBe(false);
  });
  it('fails closed on malformed or short output', () => {
    expect(aclIsPrivate('', 1)).toBe(false);
    expect(aclIsPrivate(`${ME}\n`, 1)).toBe(false);
    expect(aclIsPrivate(`${ME}\n${ME}\n`, 2)).toBe(false);
    expect(aclIsPrivate(`oops ${ME}\n${ME}\n`, 1)).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('windowsPathsPrivate on a real NTFS path', () => {
  it('mkdirPrivate makes a private dir even in a shared parent; Users read on a file breaks it; missing fails closed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bf-acl-'));
    try {
      const dir = join(tmp, 'p');
      mkdirPrivate(dir);
      const f = join(dir, 'f.json');
      writeFileSync(f, '{}');
      expect(windowsPathsPrivate([dir, f])).toBe(true);
      execFileSync('icacls', [f, '/grant', '*S-1-5-32-545:(R)']);
      expect(windowsPathsPrivate([dir, f])).toBe(false);
      expect(windowsPathsPrivate([dir])).toBe(true);
      expect(windowsPathsPrivate([dir, join(dir, 'missing')])).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
