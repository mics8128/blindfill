#!/usr/bin/env node
// Fake `adb` for tests: records each call as one JSON line in FAKE_ADB_LOG; one device is attached.
// The installed companion is the file FAKE_ADB_APK (unset: not installed); its install path and
// lastUpdateTime follow the file, as they change on a real reinstall.
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(args) + '\n');
const apk = process.env.FAKE_ADB_APK;
if (args.includes('get-state')) console.log(process.env.FAKE_ADB_STATE ?? 'device');
else if (args.includes('pm') && args.includes('path')) {
  if (!apk) process.exit(1);
  console.log(`package:/data/app/~~${basename(apk, '.apk')}==/io.github.mics8128.blindfill-x==/base.apk`);
} else if (args.includes('dumpsys')) {
  if (apk) console.log(`    lastUpdateTime=${statSync(apk).mtimeMs}`);
} else if (args.includes('exec-out')) process.stdout.write(readFileSync(apk));
