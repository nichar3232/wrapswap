# Unison Pay: Sui prize (DeFi & Payments)

**Live:** https://nichars-mac-mini.tail43cacc.ts.net/app?tab=send · repo (public), tag `v1-ethglobal-tokyo` · full run log and every hash: [sui-details.md](sui-details.md)

**Send someone Apple shares, confidentially, with no cash leg.**
1. Deposit a wrapper into the ShareVault on Unichain.
2. Pay on Sui with a Seal-encrypted instruction.
3. The recipient withdraws into whichever issuer's wrapper they use. The ShareVault converts through the Uniswap v4 ParityHook.

- **Sui package** `unison_pay`: [`0x2f18fa6d…f452c`](https://suiscan.xyz/testnet/object/0x2f18fa6d27e46235a4dcb9c0de62adbf612e3f60700ffeeac4e13d50ea4f452c).
- **Pool**: publishes only a total and a Merkle root; payments can't change the total.
- **Seal** gates instructions until the batch window closes, and gates each balance leaf to its owner.
- **Walrus** stores the sealed instructions and one manifest per root.

## Proof: one end-to-end run on the final deployment

| Step | Tx |
| --- | --- |
| Deposit 5 mAAPLx into ShareVault (Unichain) | [0xb1d818df…8b81](https://sepolia.uniscan.xyz/tx/0xb1d818df53f0ab92de3d89e115e3ec16a6e6739fbe8a6716a172485582ae8b81) |
| Keeper credits 5 shares (Sui) | [9D9u3gLh5v…](https://suiscan.xyz/testnet/tx/9D9u3gLh5vfrsiMSLXtBcvw7AQR2a3PzPtaRGnabiAFo) |
| Sealed payment of 3 shares (Sui) | [Cd9YepBeMf…](https://suiscan.xyz/testnet/tx/Cd9YepBeMfAPQcnFcQGiTqoK3fwXFQTKALvYDmexhFWu) |
| Batch applied, total unchanged (Sui) | [4dtHGYtxgW…](https://suiscan.xyz/testnet/tx/4dtHGYtxgWesaYVhDWoFb1bZpWDL2kT7Z6BUmPQ4yUzz) |
| Sealed withdrawal into the other issuer (Sui) | [71m6E9Eb9g…](https://suiscan.xyz/testnet/tx/71m6E9Eb9g2TEVSp7HriUJLdYPPFaai1JF8tyBgjKLkL) |
| ShareVault converts via Uniswap v4 and delivers 4.938271 mcbAAPL (Unichain) | [0x635b4c36…949d](https://sepolia.uniscan.xyz/tx/0x635b4c364390866199ca8f025e02d9fd0ed9d886f0f0aa9801521db8a0cf949d) |
| Keeper debits Sui | [2CdgAK4GFq…](https://suiscan.xyz/testnet/tx/2CdgAK4GFqj9fhDneTjUJWdVMMrwNwVZk5kjC4f7S2mC) |

## Mapping to the track

| Criterion | Unison Pay |
| --- | --- |
| Payment flows | Confidential share payments in 90 s sealed batches |
| Vaults | ShareVault custody. Solvency invariant: Sui total ≤ vault shares held, served at `/api/pay/reserves` |
| Automation | Keeper credits, applies, settles, debits; relay and MCP send without a wallet |
| Financial interfaces | Send panel, `POST /api/demo/send`, reserves API |
| Financial abstractions | Sized in shares; settles into any issuer's wrapper |

Honest scope: confidential, not anonymous. The keeper sees amounts.
