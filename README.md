# Forta Workshop 2: Uniswap V3 Large Flash Swap Agent

## Description

This Forta Workshop agent monitors Uniswap V3 Pool contracts for large flash swaps over a specified threshold (default 100K USD).

## Supported Chains

- Ethereum Mainnet

## Alerts

<!-- -->
- AE-FORTA-WORKSHOP2-UNISWAPV3-LARGE-FLASH-SWAP
  - Fired on any Flash event from a Uniswap V3 Pool contract with USD value exceeding the threshold specified in agent-config.json
  - Severity is always set to "info"
  - Type is always set to "info"
  - Metadata field contains:
    - Pool contract address
    - Amount of token 0 involved in swap
    - Amount of token 1 involved in swap
    - Sender's address
    - USD value of token 0 amount involved in swap
    - USD value of token 1 amount involved in swap
    - USD flash swap threshold

## Test Data

The agent behavior can be verified with the following transactions (`npm run tx <tx_hash>`):
- 0x8c97790e8a16b71968b7d194892966b86e3d898c7d166086d4d8831ed3fbaff3
- 0x1cd2db6d7da6459585c4af8e217ff65cf645aa40a75a381596615fd3e0e3f8ea
- 0x6677c6fcb786dd45a99c8a0e14dec98f8c36eaba498519c043fdf9e12067122c
