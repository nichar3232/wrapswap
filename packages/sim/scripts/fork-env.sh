# Sourced by the sim scripts. Fork stack = live stack ports + 1000; anvil fork on 8555. Keys are anvil's public
# test keys (never the live deployer/crank/relay keys): #4 crank, #5 relay, #6.. sim agents.
export NETWORK=unichain-sepolia USE_MOCKS=false DEPLOYMENT_FILE=deployments/unichain-sepolia.json
export RPC_URL=http://127.0.0.1:8555 FORK_RPC=http://127.0.0.1:8555
export WEB_PORT=14010 API_PORT=19010 CRANK_HEALTH_PORT=19110 CRANK_PORT=19110 RELAY_PORT=19210 PG_PORT=16410 MCP_PORT=19220
export DATABASE_URL=postgresql://wrapswap:wrapswap@127.0.0.1:$PG_PORT/wrapswap
export CRANK_PK=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
export CRANK_ADDR=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
export RELAY_ADDR=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
export RELAY_KEY_FILE=$HOME/wrapswap-run/env/sim-relay.env
export DEPLOYER=0xFD42fC43855C9332051e9e2F05a75C8914073F9e
export VITE_NETWORK=unichain-sepolia VITE_USE_MOCKS=false INDEXER_CONFIRMATIONS=0 ORACLE_MODE=mock
unset VITE_RPC_URL DEMO_MNEMONIC CRANK_PRIVATE_KEY DEPLOYER_PRIVATE_KEY UNICHAIN_SEPOLIA_RPC_URL
