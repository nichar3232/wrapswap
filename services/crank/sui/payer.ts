// Payer and holder operations. Browser-safe: used by the demo script and the /pay UI.
import type { SealClient, SessionKey } from '@mysten/seal';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { submitTx, sealApproveLeafTx } from './chain.js';
import { normalizeSuiAddress, batchIdentity, commitmentOf, decodeJson, encodeJson, leafProof, unb64, type Instruction, type Leaf, type Manifest } from './protocol.js';
import { leafHash, verifyPath } from './merkle.js';

export const SEAL_THRESHOLD = 2;

/** Encrypts an instruction to the open batch's identity, stores it on Walrus and returns the submit transaction. */
export async function prepareInstruction(opts: {
  seal: SealClient;
  packageId: string;
  poolId: string;
  batchId: string;
  instruction: Instruction;
  walrusPut: (b: Uint8Array) => Promise<{ blobId: string }>;
}) {
  const plain = encodeJson(opts.instruction);
  const commitment = commitmentOf(plain);
  const { encryptedObject } = await opts.seal.encrypt({
    threshold: SEAL_THRESHOLD,
    packageId: opts.packageId,
    id: batchIdentity(opts.batchId),
    data: plain,
  });
  const { blobId } = await opts.walrusPut(encryptedObject);
  return { commitment, blobId, tx: submitTx(opts.packageId, opts.poolId, opts.batchId, commitment, blobId) };
}

export type BalanceView = { balance: bigint; seq: number; verified: boolean; present: boolean };

/** Decrypts the holder's own leaf with Seal and checks its Merkle path against the on-chain root. */
export async function readOwnBalance(opts: {
  client: ClientWithCoreApi;
  seal: SealClient;
  sessionKey: SessionKey;
  packageId: string;
  poolId: string;
  owner: string;
  manifest: Manifest;
  onchainRoot: string;
}): Promise<BalanceView> {
  const proof = leafProof(opts.manifest, opts.owner);
  if (!proof) return { balance: 0n, seq: opts.manifest.seq, verified: opts.manifest.root === opts.onchainRoot, present: false };
  const ct = unb64(proof.ct);
  const { EncryptedObject } = await import('@mysten/seal');
  const { id } = EncryptedObject.parse(ct);
  const txBytes = await sealApproveLeafTx(opts.packageId, opts.poolId, id).build({ client: opts.client, onlyTransactionKind: true });
  const leaf = decodeJson<Leaf>(await opts.seal.decrypt({ data: ct, sessionKey: opts.sessionKey, txBytes }));
  const hash = leafHash(normalizeSuiAddress(opts.owner), ct);
  const verified =
    hash === proof.hash && verifyPath(hash, proof.path, proof.root) && proof.root.toLowerCase() === opts.onchainRoot.toLowerCase();
  return { balance: BigInt(leaf.balance), seq: leaf.seq, verified, present: true };
}
