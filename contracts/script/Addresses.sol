// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Official deployment page checked 2026-09-26 (developers.uniswap.org/docs/protocols/v4/deployments); no assumption of cross-chain address equality.
library Addresses {
    struct Network {
        address poolManager;
        address positionManager;
        address stateView;
        address quoter;
        address universalRouter;
        address permit2;
        address usdc;
        address oracle;
        address eas;
    }

    function forChain(uint256 chainId) internal pure returns (Network memory n) {
        n.permit2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
        n.eas = 0x4200000000000000000000000000000000000021;
        if (chainId == 8453) {
            n.poolManager = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
            n.positionManager = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
            n.stateView = 0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71;
            n.quoter = 0x0d5e0F971ED27FBfF6c2837bf31316121532048D;
            n.universalRouter = 0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40;
            n.usdc = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
            n.oracle = 0x787f13dEa48Db0897CbCDD985de77809D837F988;
        } else if (chainId == 1301) {
            n.poolManager = 0x00B036B58a818B1BC34d502D3fE730Db729e62AC;
            n.positionManager = 0xf969Aee60879C54bAAed9F3eD26147Db216Fd664;
            n.stateView = 0xc199F1072a74D4e905ABa1A84d9a45E2546B6222;
            n.quoter = 0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472;
            n.universalRouter = 0xf70536B3bcC1bD1a972dc186A2cf84cC6da6Be5D;
        } else {
            revert("Unsupported chain");
        }
    }
}
