// Step-1 Seal probe: time-gated identity, 2-of-3 testnet key servers, ciphertext round-tripped through Walrus.
// Usage: PROBE_PACKAGE=0x... tsx services/crank/sui/probe.ts
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { SEAL_THRESHOLD, loadKeypair, sealClient, sessionKeyFor, suiClient, toHex, walrusGet, walrusPut, walruscan } from './lib.ts';

const pkg = process.env.PROBE_PACKAGE;
if (!pkg) throw new Error('PROBE_PACKAGE unset');
const client = suiClient();
const seal = sealClient(client);
const kp = loadKeypair();

const unlockMs = Date.now() + 45_000;
const id = new Uint8Array([...bcs.u64().serialize(BigInt(unlockMs)).toBytes(), ...crypto.getRandomValues(new Uint8Array(8))]);
const idHex = toHex(id);
const plaintext = new TextEncoder().encode(`unison seal probe ${new Date().toISOString()}`);

const { encryptedObject } = await seal.encrypt({ threshold: SEAL_THRESHOLD, packageId: pkg, id: idHex, data: plaintext });
const put = await walrusPut(encryptedObject);
console.log(`encrypted ${encryptedObject.length}B, walrus blob ${put.blobId} ${walruscan(put.blobId)}`);
const fetched = await walrusGet(put.blobId);
if (toHex(fetched) !== toHex(encryptedObject)) throw new Error('walrus round trip mismatch');
console.log('walrus round trip: bytes identical');

const sessionKey = await sessionKeyFor(client, kp, pkg);
const approveTx = async () => {
  const tx = new Transaction();
  tx.moveCall({ target: `${pkg}::time_gate::seal_approve`, arguments: [tx.pure.vector('u8', id), tx.object.clock()] });
  return tx.build({ client, onlyTransactionKind: true });
};

try {
  await seal.decrypt({ data: fetched, sessionKey, txBytes: await approveTx() });
  console.log('BEFORE gate: decrypted — UNEXPECTED');
  process.exitCode = 1;
} catch (e: any) {
  console.log(`BEFORE gate (now=${Date.now()} < unlock=${unlockMs}): denied — ${e.constructor.name}: ${String(e.message).slice(0, 120)}`);
}

const wait = unlockMs - Date.now() + 8_000;
console.log(`waiting ${Math.ceil(wait / 1000)}s for the gate`);
await new Promise((r) => setTimeout(r, wait));
const out = await seal.decrypt({ data: fetched, sessionKey, txBytes: await approveTx() });
const text = new TextDecoder().decode(out);
if (text !== new TextDecoder().decode(plaintext)) throw new Error('plaintext mismatch');
console.log(`AFTER gate: decrypted "${text}"`);
