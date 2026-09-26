/** Where Move should start, requested by another panel (Portfolio row, Liquidity cheap direction). */
export type MoveIntent = { fromToken: string; mode: "convert" | "dark"; nonce: number };
