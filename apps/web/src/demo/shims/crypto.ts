// The node:crypto functions the server uses, for the in-browser demo. scryptSync uses Node's defaults
// (N=16384, r=8, p=1) so the seeded demo passwords still check out.
import { scrypt } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha256';
import { Buffer } from 'buffer';

// The `buffer` package predates 'base64url', which the server uses for tokens.
const toString = Buffer.prototype.toString;
Buffer.prototype.toString = function (this: Buffer, encoding?: string, ...rest: number[]) {
  if (encoding !== 'base64url') return toString.call(this, encoding as 'utf8', ...rest);
  return toString.call(this, 'base64', ...rest).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
} as typeof toString;

const bytes = (v: string | Uint8Array) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);

export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw new Error(`The demo only supports sha256, not ${algorithm}.`);
  const h = sha256.create();
  const api = {
    update(v: string | Uint8Array) {
      h.update(bytes(v));
      return api;
    },
    digest(enc?: 'hex' | 'base64' | 'base64url') {
      const out = Buffer.from(h.digest());
      return enc ? out.toString(enc) : out;
    },
  };
  return api;
}

export function randomBytes(n: number) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
}

export function scryptSync(password: string | Uint8Array, salt: string | Uint8Array, keylen: number) {
  return Buffer.from(scrypt(bytes(password), bytes(salt), { N: 16384, r: 8, p: 1, dkLen: keylen }));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const randomUUID = () => crypto.randomUUID();
