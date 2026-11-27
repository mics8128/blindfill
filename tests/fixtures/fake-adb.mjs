#!/usr/bin/env node
// Fake `adb` for tests: records each call as one JSON line in FAKE_ADB_LOG; one device is attached.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(args) + '\n');
if (args.includes('get-state')) console.log(process.env.FAKE_ADB_STATE ?? 'device');
