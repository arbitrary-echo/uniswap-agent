const BigNumber = require('bignumber.js');
const {
  Finding, FindingSeverity, FindingType, getJsonRpcUrl,
} = require('forta-agent');

// use ethers.js for contracts, interfaces, and provider
const ethers = require('ethers');

// use axios for external API GET requests
const axios = require('axios');

// load any agent configuration parameters
const config = require('../agent-config.json');

// load contract addresses
const contractAddresses = require('../contract-addresses.json');

// load contract ABIs
const { abi: factoryAbi } = require('../abi/UniswapV3Factory.json');
const { abi: uniswapV3PoolAbi } = require('../abi/UniswapV3Pool.json');

// decimals() signature
const DECIMALS_ABI = ['function decimals() view returns (uint8)'];

// create object that will contain contracts, providers, interfaces, and configuration parameters
const initializeData = {};

function provideInitialize(data) {
  return async function initialize() {
    // store the Everest ID for the UniswapV3 protocol
    /* eslint-disable no-param-reassign */
    data.everestId = config.EVEREST_ID;

    // set up an ethers.js provider for interacting with contracts
    // getJsonRpcUrl() will return the JSON-RPC URL from forta.config.json
    data.provider = new ethers.providers.JsonRpcBatchProvider(getJsonRpcUrl());

    // create an ethers.js Contract object for calling methods on the UniswapV3 factory contract
    data.factoryContract = new ethers.Contract(
      contractAddresses.UniswapV3Factory.address,
      factoryAbi,
      data.provider,
    );

    // store the flash swap threshold as a BigNumber (NOT ethers.js BigNumber)
    data.flashSwapThresholdUSDBN = new BigNumber(config.largeFlashSwap.thresholdUSD);

    // store the UniswapV2Pool contract ABI for use later
    data.poolAbi = uniswapV3PoolAbi;
    /* eslint-enable no-param-reassign */
  };
}

async function getTokenPrices(token0Address, token1Address) {
  const apiURL = 'https://api.coingecko.com/api/v3/simple/token_price/';
  const idString = 'ethereum';
  const addressString = `contract_addresses=${token0Address},${token1Address}`;
  const currencyString = 'vs_currencies=usd';

  const { data } = await axios.get(`${apiURL + idString}?${addressString}&${currencyString}`);

  // parse the response and convert the prices to BigNumber.js type (NOT ethers.js BigNumber)
  const usdPerToken0 = new BigNumber(data[token0Address.toLowerCase()].usd);
  const usdPerToken1 = new BigNumber(data[token1Address.toLowerCase()].usd);

  return { token0Price: usdPerToken0, token1Price: usdPerToken1 };
}

async function getValue(amountBN, tokenPrice, tokenAddress, provider) {
  const contract = new ethers.Contract(tokenAddress, DECIMALS_ABI, provider);
  const decimals = await contract.decimals();
  const denominator = (new BigNumber(10)).pow(decimals);
  return amountBN.times(tokenPrice).div(denominator);
}

function provideHandleTransaction(data) {
  return async function handleTransaction(txEvent) {
    // destructure the initialized data for use in handler
    const {
      poolAbi, provider, factoryContract, everestId, flashSwapThresholdUSDBN,
    } = data;

    if (!factoryContract) throw new Error('handleTransaction called before initialization');

    // initialize the findings Array
    const findings = [];

    // check for logs containing the Flash event signature
    const flashSignature = 'Flash(address,address,uint256,uint256,uint256,uint256)';
    const flashSwapLogs = txEvent.filterEvent(flashSignature);

    // no flash swaps, no findings
    if (flashSwapLogs.length > 0) {
      // iterate over the logs containing Flash events and return an Array of promises
      const flashSwapPromises = flashSwapLogs.map(async (flashSwapLog) => {
        // destructure the log
        const { address, data: eventData, topics } = flashSwapLog;

        // create an ethers.js Contract with the given address and the poolAbi
        const poolContract = new ethers.Contract(address, poolAbi, provider);

        let token0;
        let token1;
        try {
          // get the tokens and fee that define the Uniswap V3 pool
          token0 = await poolContract.token0();
          token1 = await poolContract.token1();
          const fee = await poolContract.fee();

          // use the Uniswap V3 factory to get the pool address based on the tokens and fee
          const expectedAddress = await data.factoryContract.getPool(token0, token1, fee);

          if (address.toLowerCase() !== expectedAddress.toLowerCase()) {
            // if the addresses do not match, assume that this is not a Uniswap V3 Pool
            return undefined;
          }
        } catch {
          // if an error was encountered calling contract methods
          // assume that this is not a Uniswap V3 Pool
          return undefined;
        }

        const tokenPrices = await getTokenPrices(token0, token1);

        // parse the information from the flash swap
        const { args: { sender, amount0, amount1 } } = poolContract.interface.parseLog({
          data: eventData,
          topics,
        });

        // convert from ethers.js BigNumber to BigNumber.js
        const amount0BN = new BigNumber(amount0.toHexString());
        const amount1BN = new BigNumber(amount1.toHexString());

        const flashSwapData = {
          address,
          amount0BN,
          amount1BN,
          sender,
          value0USDBN: new BigNumber(0),
          value1USDBN: new BigNumber(0),
        };

        if (amount0BN.gt(0)) {
          const value0USDBN = await getValue(amount0BN, tokenPrices.token0Price, token0, provider);
          flashSwapData.value0USDBN = flashSwapData.value0USDBN.plus(value0USDBN);
        }

        if (amount1BN.gt(0)) {
          const value1USDBN = await getValue(amount1BN, tokenPrices.token1Price, token1, provider);
          flashSwapData.value1USDBN = flashSwapData.value1USDBN.plus(value1USDBN);
        }

        return flashSwapData;
      });

      // settle the promises
      // NOTE: Promise.all will fail fast on any rejected promises
      // Consider Promise.allSettled() to ensure that all promises settle (fulfilled or rejected)
      let flashSwapResults = await Promise.all(flashSwapPromises);

      // filter out undefined entries in the results
      flashSwapResults = flashSwapResults.filter((result) => result !== undefined);

      // check each flash swap for any that exceeded the threshold value
      flashSwapResults.forEach((result) => {
        if (result.value0USDBN.plus(result.value1USDBN).gt(flashSwapThresholdUSDBN)) {
          const finding = Finding.fromObject({
            name: 'Forta Workshop 2: Uniswap V3 Large Flash Swap',
            description: `Large Flash Swap from pool ${result.address}`,
            alertId: 'AE-FORTA-WORKSHOP2-UNISWAPV3-LARGE-FLASH-SWAP',
            severity: FindingSeverity.Info,
            type: FindingType.Info,
            protocol: 'UniswapV3',
            everestId,
            metadata: {
              address: result.address,
              token0Amount: result.amount0BN.toString(),
              token1Amount: result.amount1BN.toString(),
              sender: result.sender,
              value0USD: result.value0USDBN.toString(),
              value1USD: result.value1USDBN.toString(),
              flashSwapThresholdUSD: flashSwapThresholdUSDBN.toString(),
            },
          });
          findings.push(finding);
        }
      });
    }

    return findings;
  };
}

module.exports = {
  provideInitialize,
  initialize: provideInitialize(initializeData),
  provideHandleTransaction,
  handleTransaction: provideHandleTransaction(initializeData),
};
