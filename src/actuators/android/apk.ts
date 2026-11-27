import { createHash } from 'node:crypto';
import { BlindfillError } from '../../core/types.js';

/** APK Signature Scheme block ids: v2, v3, v3.1 (https://source.android.com/docs/security/features/apksigning) */
const SCHEMES = [0x7109871a, 0xf05368c0, 0x1b93ad61];
const MAGIC = Buffer.from('APK Sig Block 42', 'latin1');

const bad = (why: string): never => {
  throw new BlindfillError('ACTUATOR', `not a signed APK: ${why}`);
};

/** Split a sequence of uint32-length-prefixed values. */
function seq(b: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let o = 0; o < b.length;) {
    if (o + 4 > b.length) bad('truncated sequence');
    const n = b.readUInt32LE(o);
    if (o + 4 + n > b.length) bad('truncated sequence');
    out.push(b.subarray(o + 4, o + 4 + n));
    o += 4 + n;
  }
  return out;
}
/** One uint32-length-prefixed value at the start of b. */
const lp = (b: Buffer): Buffer => {
  if (b.length < 4 || 4 + b.readUInt32LE(0) > b.length) bad('truncated value');
  return b.subarray(4, 4 + b.readUInt32LE(0));
};

/**
 * Signing certificates of an APK, as upper-case hex SHA-256 of each signer's certificate (the value
 * apksigner prints). Reads the v2/v3/v3.1 APK Signing Block only; the signatures themselves are
 * not checked here (PackageManager verified them at install, and apksigner does at build).
 * Returns the distinct signers across all schemes present; throws when there is no signing block.
 */
export function apkSigners(apk: Buffer): string[] {
  // End of central directory: last 22..65557 bytes
  let eocd = -1;
  for (let i = apk.length - 22; i >= Math.max(0, apk.length - 65_557); i--)
    if (apk.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) bad('no end of central directory');
  const cd = apk.readUInt32LE(eocd + 16);
  if (cd < 32 || cd > eocd || !apk.subarray(cd - 16, cd).equals(MAGIC)) bad('no APK Signing Block');
  const size = Number(apk.readBigUInt64LE(cd - 24));
  const start = cd - size - 8;
  if (start < 0 || Number(apk.readBigUInt64LE(start)) !== size) bad('corrupt APK Signing Block');
  const signers = new Set<string>();
  for (let o = start + 8; o < cd - 24;) {
    const len = Number(apk.readBigUInt64LE(o));
    if (len < 4 || o + 8 + len > cd - 24) bad('corrupt APK Signing Block');
    const id = apk.readUInt32LE(o + 8);
    if (SCHEMES.includes(id))
      for (const signer of seq(lp(apk.subarray(o + 12, o + 8 + len)))) {
        // signer = signed data (digests, certificates, ...) | ...; first certificate is the signer's
        const signedData = lp(signer);
        const certs = seq(lp(signedData.subarray(4 + lp(signedData).length)));
        if (certs.length === 0) bad('signer without certificate');
        signers.add(createHash('sha256').update(certs[0]).digest('hex').toUpperCase());
      }
    o += 8 + len;
  }
  if (signers.size === 0) bad('no v2/v3 signature');
  return [...signers];
}
