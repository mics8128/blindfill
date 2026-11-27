// Child process for tests/session.test.ts: writes a stale policy snapshot `n` times.
import { saveSession } from '../../src/actuators/web/session.js';

const [locked, entry, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++)
  saveSession({
    cdp: 'http://127.0.0.1:9222',
    owned: false,
    policy: { locked: locked === 'true', filled: [entry] },
  });
