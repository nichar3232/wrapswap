// Unison Pay wire formats. Browser-safe: shared by the keeper, the API, the demo and the /pay UI.
import { keccak256, toHex, type Hex } from 'viem';
import { EMPTY_ROOT, leafHash, merklePath, merkleRoot, type PathStep } from './merkle.js';

/** Plaintext instruction a payer Seal-encrypts to the batch identity. The payer is the Sui tx sender, never a field. */
export type Instruction =
  | { v: 1; kind: 'pay'; to: string; shares: string; memo?: string; nonce: string }
  | { v: 1; kind: 'withdraw'; recipient: Hex; target: Hex; shares: string; maxFeeBps: number; nonce: string };

/** Plaintext leaf the keeper Seal-encrypts to its owner's identity. Absent leaf = zero balance. */
export type Leaf = { v: 1; pool: string; owner: string; balance: string; nonce: string; seq: number };

export type ManifestEntry = { owner: Hex; ct: string /* base64 Seal ciphertext */; hash: Hex };
export type Manifest = { v: 1; pool: string; seq: number; root: Hex; totalShares: string; leaves: ManifestEntry[] };

export const encodeJson = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
export const decodeJson = <T>(b: Uint8Array): T => JSON.parse(new TextDecoder().decode(b)) as T;
export const commitmentOf = (plaintext: Uint8Array): Hex => keccak256(plaintext);

const hexBytes = (h: string) => {
  const s = h.replace(/^0x/, '').padStart(64, '0');
  return Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
};
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Instruction identity: batch object id (32) || nonce (16). Matches unison_pay::pay::seal_approve_batch. */
export const batchIdentity = (batchId: string) => hex(new Uint8Array([...hexBytes(batchId), ...randomBytes(16)]));

/** Leaf identity: owner (32) || pool id (32) || nonce (16). Matches unison_pay::pay::seal_approve_leaf. */
export const leafIdentity = (owner: string, poolId: string) =>
  hex(new Uint8Array([...hexBytes(owner), ...hexBytes(poolId), ...randomBytes(16)]));

export const normalizeSuiAddress = (a: string) => `0x${a.replace(/^0x/, '').toLowerCase().padStart(64, '0')}` as Hex;

export const b64 = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function buildManifest(pool: string, seq: number, totalShares: bigint, cts: Map<string, Uint8Array>): Manifest {
  const leaves = [...cts.entries()]
    .map(([owner, ct]) => ({ owner: normalizeSuiAddress(owner), ct }))
    .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
    .map(({ owner, ct }) => ({ owner, ct: b64(ct), hash: leafHash(owner, ct) }));
  return { v: 1, pool, seq, root: merkleRoot(leaves.map((l) => l.hash)), totalShares: totalShares.toString(), leaves };
}

/** Looks up an owner's ciphertext and proof in a manifest. null = no leaf = zero balance. */
export function leafProof(m: Manifest, owner: string): { ct: string; hash: Hex; path: PathStep[]; root: Hex } | null {
  const o = normalizeSuiAddress(owner);
  const i = m.leaves.findIndex((l) => l.owner === o);
  if (i < 0) return null;
  return { ct: m.leaves[i].ct, hash: m.leaves[i].hash, path: merklePath(m.leaves.map((l) => l.hash), i), root: m.root };
}

export const rootBytes = (root: Hex) => hexBytes(root);
export { EMPTY_ROOT, toHex };

/** Canonical-share formatting: 1e18 = one share. */
export function formatShares(raw: bigint | string, dp = 4): string {
  const v = BigInt(raw);
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').slice(0, dp);
  return `${whole}.${frac}`;
}
export function parseShares(s: string): bigint {
  const [w, f = ''] = s.trim().split('.');
  return BigInt(w || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
