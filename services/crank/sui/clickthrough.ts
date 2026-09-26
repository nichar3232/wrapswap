// Browser click-through of the Send panel (/app?tab=send) on live Sui testnet + Unichain Sepolia, screenshotted at
// each step: deposit (Unichain) -> sealed send (Sui) -> recipient decrypts -> recipient withdraws to another platform.
//
// Headless Chromium cannot drive the Slush or MetaMask extensions, so this harness injects stand-ins that sign with the
// documented demo keys: an EIP-1193 provider (window.ethereum) and a wallet-standard Sui wallet named
// "Demo Wallet (test harness)". Every other part is real: the page, both chains, Seal, Walrus and the keeper daemon
// (`pnpm dev:sui-keeper` must be running).
//
// Usage: PAY_URL=http://127.0.0.1:5402/pay tsx services/crank/sui/clickthrough.ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { fromBase64 } from '@mysten/sui/utils';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { http, createWalletClient, createPublicClient, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { unichainSepolia } from 'viem/chains';
import { RUN_DIR, evmRpcUrl, loadDeployment } from './config.js';
import { loadKeypair } from './lib.js';
import { withLatestNonce, withNonceRetry } from './evm.js';

const URL = process.env.PAY_URL ?? 'http://127.0.0.1:5402/app?tab=send';
const SHOTS = process.env.SUI_SHOTS_DIR ?? join(RUN_DIR, 'status', 'sui-shots', 'send-live');
const dep = loadDeployment() as any;
const payer = loadKeypair(dep.demoAccounts.suiPayer);
const payee = loadKeypair(dep.demoAccounts.suiPayee);
const evmAccount = mnemonicToAccount(process.env.DEMO_MNEMONIC!, { addressIndex: 1 });
const evmWallet = withLatestNonce(createWalletClient({ account: evmAccount, chain: unichainSepolia, transport: http(evmRpcUrl()) }));
const evmPublic = createPublicClient({ chain: unichainSepolia, transport: http(evmRpcUrl()) });
const DEPOSIT = process.env.CLICK_DEPOSIT ?? '5';
const PAY_SHARES = process.env.CLICK_PAY ?? '3';
// Larger than the mcbAAPL custody holds, so delivery has to convert through the ParityHook pool.
const WITHDRAW_SHARES = process.env.CLICK_WITHDRAW ?? '5';

mkdirSync(SHOTS, { recursive: true });
let n = 0;
async function shot(page: Page, name: string, note: string) {
  const file = join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`[shot] ${file} — ${note}`);
}

/** Injected before any page script: wallet stand-ins whose signing is delegated to Node via exposed functions. */
function initScript(opts: { suiAddress: string; suiPublicKey: number[]; evmAddress: string }) {
  const w = window as any;
  // EIP-1193 (MetaMask stand-in)
  w.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [opts.evmAddress];
      if (method === 'eth_chainId') return '0x515';
      if (method === 'net_version') return '1301';
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
      return w.__evmRequest(method, params ?? []);
    },
    on: () => {},
    removeListener: () => {},
  };
  // wallet-standard Sui wallet (Slush stand-in)
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  const account = {
    address: opts.suiAddress,
    publicKey: new Uint8Array(opts.suiPublicKey),
    chains: ['sui:testnet'],
    features: ['sui:signTransaction', 'sui:signPersonalMessage'],
    label: 'demo',
  };
  const wallet = {
    version: '1.0.0',
    name: 'Demo Wallet (test harness)',
    icon: 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#2F5BFF"/></svg>'),
    chains: ['sui:testnet'],
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'sui:signPersonalMessage': {
        version: '1.1.0',
        signPersonalMessage: async ({ message }: { message: Uint8Array }) => w.__suiSignPersonal(b64(message)),
      },
      'sui:signTransaction': {
        version: '2.0.0',
        signTransaction: async ({ transaction }: { transaction: { toJSON(): Promise<string> } }) => w.__suiSignTx(await transaction.toJSON()),
      },
    },
  };
  const register = (api: { register: (w: unknown) => void }) => api.register(wallet);
  window.addEventListener('wallet-standard:app-ready', (e: any) => register(e.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
}

async function openAs(kp: Ed25519Keypair, label: string) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${label} pageerror] ${e.message}`));
  await page.exposeFunction('__suiSignPersonal', async (m: string) => {
    const r = await kp.signPersonalMessage(fromBase64(m));
    return { bytes: r.bytes, signature: r.signature };
  });
  await page.exposeFunction('__suiSignTx', async (tx: string) => {
    const r = await kp.signTransaction(fromBase64(tx));
    return { bytes: r.bytes, signature: r.signature };
  });
  await page.exposeFunction('__evmRequest', async (method: string, params: any[]) => {
    if (method === 'eth_sendTransaction') {
      const t = params[0];
      return withNonceRetry(() => evmWallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : undefined, gas: t.gas ? BigInt(t.gas) : undefined }));
    }
    return evmPublic.request({ method: method as any, params: params as any });
  });
  const opts = { suiAddress: kp.toSuiAddress(), suiPublicKey: Array.from(kp.getPublicKey().toRawBytes()), evmAddress: evmAccount.address };
  // Injected as source text: tsx/esbuild wraps functions in a `__name` helper that does not exist in the page.
  await page.addInitScript({ content: `var __name = (f) => f; (${initScript.toString()})(${JSON.stringify(opts)});` });
  await page.goto(URL, { waitUntil: 'networkidle' });
  // EVM through the app's own Connect button, then the Sui wallet through the panel's primary (dapp-kit modal).
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByTestId('send-primary').filter({ hasText: 'Connect Sui wallet' }).click();
  await page.getByText('Demo Wallet (test harness)').click();
  await page.getByTestId('send-primary').filter({ hasNotText: 'Connect Sui wallet' }).waitFor();
  return page;
}

const browser = await chromium.launch();
const T = { timeout: 6 * 60_000 };
try {
  const primary = (pg: Page) => pg.getByTestId('send-primary');
  // ---- sender: deposit on Unichain
  const p = await openAs(payer, 'sender');
  await shot(p, 'connected', 'sender connected: MetaMask path on Unichain Sepolia, Sui wallet on testnet');
  await p.getByLabel('Deposit token').selectOption({ index: 1 });
  await p.getByLabel('Deposit amount').fill(DEPOSIT);
  await primary(p).click();
  await p.getByText(/^Deposited /).waitFor(T);
  await shot(p, 'deposit-sent', `deposited ${DEPOSIT} into ShareVault on Unichain`);
  await p.getByText(/^Credited /).waitFor(T);
  await p.getByRole('button', { name: 'Decrypt' }).click();
  await p.getByText(/Seal-decrypted · proof checked/).waitFor(T);
  await shot(p, 'deposit-credited', 'keeper credited Sui; balance decrypted in the browser via Seal, proof checked');

  // ---- sender: sealed send
  await p.getByRole('tab', { name: /Send/ }).click();
  await p.getByLabel('Shares to send').fill(PAY_SHARES);
  await primary(p).click();
  await p.getByText(/^Sent .* sealed$/).waitFor(T);
  await p.waitForTimeout(2_000);
  await shot(p, 'send-sealed', 'sealed send submitted; "Sealed for 90 s · batching for privacy" countdown');
  await p.getByText(/applied · total unchanged/).waitFor(T);
  await shot(p, 'send-applied', 'window closed, keeper applied the batch; total unchanged');

  // ---- recipient: decrypt, withdraw to another platform
  const q = await openAs(payee, 'recipient');
  await q.getByRole('tab', { name: /Withdraw/ }).click();
  await q.getByRole('button', { name: 'Decrypt' }).click();
  await q.getByText(/Seal-decrypted · proof checked/).waitFor(T);
  await shot(q, 'recipient-balance', 'recipient sees the decrypted balance including the send');
  await q.getByLabel('Deliver on platform').selectOption({ index: 0 });
  await q.getByLabel('Shares to withdraw').fill(WITHDRAW_SHARES);
  await q.getByText('Router → ParityHook').waitFor(T);
  await q.waitForTimeout(1_500);
  await shot(q, 'withdraw-quote', 'withdraw to the other platform: live vault quote, hook-output gross-up');
  await primary(q).click();
  await q.getByText(/^Recipient withdrew /).waitFor(T);
  await q.getByText(/^Delivered |^Skipped/).waitFor(T);
  if (await q.getByText(/^Skipped/).count()) throw new Error('withdrawal was skipped on Unichain, not delivered');
  await shot(q, 'withdraw-delivered', 'ShareVault delivered through WrapSwapRouter -> ParityHook');
  await q.getByText(/^Debited /).locator('xpath=ancestor::li[contains(@class,"leg-done")]').waitFor(T);
  // Reserves poll every 10 s: wait for the 1:1 chip and the re-decrypted leaf before the last screenshot.
  await q.locator('.chip', { hasText: '1:1' }).waitFor(T);
  await q.waitForTimeout(4_000);
  await shot(q, 'withdraw-debited', 'keeper debited Sui; reserves back to 1:1');
  console.log('CLICK-THROUGH PASS');
} catch (e) {
  console.error('CLICK-THROUGH FAIL', e);
  for (const ctx of browser.contexts()) for (const pg of ctx.pages()) await pg.screenshot({ path: join(SHOTS, `zz-failure-${Date.now()}.png`), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
