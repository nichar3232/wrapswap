// Shared Sui, Seal and Walrus plumbing for the Unison Pay keeper, probe and demo.
// Secrets never live in the repo: the keeper key is read from the Sui CLI keystore (or SUI_KEEPER_KEY).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SealClient, SessionKey } from '@mysten/seal';
import type { Transaction } from '@mysten/sui/transactions';

// Seal testnet key servers, open mode, from docs.sui.io/sui-stack/seal/pricing (verified 2026-09-26). All three
// answer browser CORS preflights (Studio Mirai's open server does not, so it is not used).
export const SEAL_SERVERS = [
  { name: 'mysten-testnet-1', objectId: '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75', weight: 1 },
  { name: 'mysten-testnet-2', objectId: '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8', weight: 1 },
  { name: 'rubynodes-open', objectId: '0x6068c0acb197dddbacd4746a9de7f025b2ed5a5b6c1b1ab44dade4426d141da2', weight: 1 },
] as const;
export const SEAL_THRESHOLD = 2;

// Walrus testnet public endpoints (docs.wal.app network reference). Unauthenticated uploads are testnet-only.
export const WALRUS_PUBLISHER = process.env.WALRUS_PUBLISHER ?? 'https://publisher.walrus-testnet.walrus.space';
export const WALRUS_AGGREGATOR = process.env.WALRUS_AGGREGATOR ?? 'https://aggregator.walrus-testnet.walrus.space';
export const WALRUS_EPOCHS = Number(process.env.WALRUS_EPOCHS ?? 5);

// Public JSON-RPC is retired on testnet fullnodes; the SDK talks gRPC-web.
export const SUI_RPC = process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443';
export const suiscan = (kind: 'tx' | 'object' | 'account', id: string) =>
  `https://suiscan.xyz/testnet/${kind}/${id}`;
export const walruscan = (blobId: string) => `https://walruscan.com/testnet/blob/${blobId}`;

export type Client = SuiGrpcClient;
export function suiClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: 'testnet', baseUrl: SUI_RPC });
}

export function sealClient(client: SuiGrpcClient): SealClient {
  return new SealClient({
    suiClient: client,
    serverConfigs: SEAL_SERVERS.map(({ objectId, weight }) => ({ objectId, weight })),
    verifyKeyServers: false,
    timeout: 20_000,
  });
}

/** Loads a keypair by address from the Sui CLI keystore, or the keeper from SUI_KEEPER_KEY (suiprivkey...). */
export function loadKeypair(address?: string): Ed25519Keypair {
  if (!address && process.env.SUI_KEEPER_KEY) {
    return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(process.env.SUI_KEEPER_KEY).secretKey);
  }
  const dir = process.env.SUI_CONFIG_DIR ?? join(homedir(), '.sui', 'sui_config');
  const want = address ?? activeAddress(dir);
  const keys: string[] = JSON.parse(readFileSync(join(dir, 'sui.keystore'), 'utf8'));
  for (const k of keys) {
    const raw = Buffer.from(k, 'base64');
    if (raw[0] !== 0) continue; // ed25519 only
    const kp = Ed25519Keypair.fromSecretKey(raw.subarray(1));
    if (kp.toSuiAddress() === want) return kp;
  }
  throw new Error(`no ed25519 key for ${want} in the Sui keystore`);
}

function activeAddress(dir: string): string {
  const yaml = readFileSync(join(dir, 'client.yaml'), 'utf8');
  const m = yaml.match(/active_address:\s*"?(0x[0-9a-f]+)"?/);
  if (!m) throw new Error('no active_address in client.yaml');
  return m[1];
}

export async function sessionKeyFor(client: SuiGrpcClient, kp: Ed25519Keypair, packageId: string, ttlMin = 10) {
  const sk = await SessionKey.create({ address: kp.toSuiAddress(), packageId, ttlMin, suiClient: client });
  const { signature } = await kp.signPersonalMessage(sk.getPersonalMessage());
  await sk.setPersonalMessageSignature(signature);
  return sk;
}

export async function walrusPut(data: Uint8Array): Promise<{ blobId: string; objectId?: string; fresh: boolean }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${WALRUS_PUBLISHER}/v1/blobs?epochs=${WALRUS_EPOCHS}`, { method: 'PUT', body: data as BodyInit });
      if (!res.ok) throw new Error(`walrus PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j: any = await res.json();
      if (j.newlyCreated) return { blobId: j.newlyCreated.blobObject.blobId, objectId: j.newlyCreated.blobObject.id, fresh: true };
      if (j.alreadyCertified) return { blobId: j.alreadyCertified.blobId, fresh: false };
      throw new Error(`walrus PUT: unexpected response ${JSON.stringify(j).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function walrusGet(blobId: string): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);
      if (!res.ok) throw new Error(`walrus GET ${blobId} ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function execute(client: SuiGrpcClient, kp: Ed25519Keypair, tx: Transaction) {
  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    include: { effects: true, events: true, objectTypes: true },
  });
  const t = res.Transaction ?? res.FailedTransaction!;
  if (res.$kind !== 'Transaction' || !t.status.success) {
    throw new Error(`tx ${t.digest} failed: ${JSON.stringify(t.status.error)}`);
  }
  await client.waitForTransaction({ digest: t.digest });
  return t;
}

export const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const fromHex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ''), 'hex'));
