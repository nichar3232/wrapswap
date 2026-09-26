// Merkle tree over Unison Pay leaves. Browser-safe: shared by the keeper, the API and the /pay UI.
// leaf  = keccak256(0x00 || owner(32) || keccak256(ciphertext))
// node  = keccak256(0x01 || left || right); an odd node is promoted unchanged; empty tree = 32 zero bytes.
// Leaves are ordered by owner address ascending.
import { concat, keccak256, type Hex } from 'viem';

export const EMPTY_ROOT: Hex = `0x${'00'.repeat(32)}`;

export function leafHash(owner: Hex, ciphertext: Uint8Array): Hex {
  return keccak256(concat(['0x00', owner, keccak256(ciphertext)]));
}

const node = (l: Hex, r: Hex): Hex => keccak256(concat(['0x01', l, r]));

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return EMPTY_ROOT;
  let level = leaves;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? node(level[i], level[i + 1]) : level[i]);
    level = next;
  }
  return level[0];
}

export type PathStep = { sibling: Hex; side: 'left' | 'right' };

/** Sibling path for leaf `index`; steps where the node was promoted are omitted. */
export function merklePath(leaves: Hex[], index: number): PathStep[] {
  const path: PathStep[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    const sib = i ^ 1;
    if (sib < level.length) path.push({ sibling: level[sib], side: sib < i ? 'left' : 'right' });
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(j + 1 < level.length ? node(level[j], level[j + 1]) : level[j]);
    level = next;
    i = Math.floor(i / 2);
  }
  return path;
}

export function verifyPath(leaf: Hex, path: PathStep[], root: Hex): boolean {
  let h = leaf;
  for (const s of path) h = s.side === 'left' ? node(s.sibling, h) : node(h, s.sibling);
  return h.toLowerCase() === root.toLowerCase();
}
