// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Official deployment page checked 2026-09-25; no assumption of cross-chain address equality.
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
        } else if (chainId == 84532) {
            n.poolManager = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
            n.positionManager = 0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80;
            n.stateView = 0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4;
            n.quoter = 0x4A6513c898fe1B2d0E78d3b0e0A4a151589B1cBa;
            n.universalRouter = 0x8702463e73f74d0b6765aBceb314Ef07aCb92650;
        } else {
            revert("Unsupported chain");
        }
    }
}
