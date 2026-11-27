import { createHash, type KeyObject } from 'node:crypto';

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

/** Minimal CBOR encoder (RFC 8949): only what a `none` attestation object needs. */
export function cbor(v: Cbor): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1); // shortcut: lengths up to 65535, enough for authData
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

/**
 * authData for a new ES256 credential (flags UP, UV, AT, plus BE+BS when backupEligible, as
 * Bitwarden's authenticator; counter 0; zero AAGUID) and its `none` attestation object.
 */
export function noneAttestation(
  rpId: string,
  credentialId: Buffer,
  publicKey: KeyObject,
  backupEligible: boolean,
): { authData: Buffer; attestationObject: Buffer } {
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = cbor(
    new Map<Cbor, Cbor>([
      [1, 2], // kty EC2
      [3, -7], // alg ES256
      [-1, 1], // crv P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]),
  );
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    Buffer.from([backupEligible ? 0x5d : 0x45]),
    Buffer.alloc(4), // signCount 0
    Buffer.alloc(16), // AAGUID
    idLen,
    credentialId,
    cose,
  ]);
  const attestationObject = cbor(
    new Map<Cbor, Cbor>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  );
  return { authData, attestationObject };
}
