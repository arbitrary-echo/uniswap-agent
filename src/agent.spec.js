const {
  Finding, FindingType, FindingSeverity, createTransactionEvent,
} = require('forta-agent');

const BigNumber = require('bignumber.js');

/* axios mocking */
const mockCoinGeckoData = {};
const mockCoinGeckoResponse = {
  data: mockCoinGeckoData,
};
jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue(mockCoinGeckoResponse),
}));

const axios = require('axios');
/* ethers mocking */
// uniswap v3 factory contract mock and pool mock
const mockToken0Address = '0xFAKETOKEN0ADDRESS'; // .token0()
const mockToken1Address = '0xFAKETOKEN1ADDRESS'; // .token1()
const mockFee = 0; // .fee()
const mockPoolAddress = '0xFAKEPOOLADDRESS';
const mockDecimals = 3;

const mockFactoryContract = {
  getPool: jest.fn().mockResolvedValue(mockPoolAddress),
};

const mockPoolContract = {
  token0: jest.fn().mockResolvedValue(mockToken0Address),
  token1: jest.fn().mockResolvedValue(mockToken1Address),
  fee: jest.fn().mockResolvedValue(mockFee),
};

const mockTokenContract = {
  decimals: jest.fn().mockResolvedValue(mockDecimals),
};

// mock the JsonRpcBatchProvider and Contract constructors
jest.mock('ethers', () => ({
  Contract: jest.fn(),
  providers: {
    JsonRpcBatchProvider: jest.fn(),
  },
  ...jest.requireActual('ethers'),
}));
// import the rest of the ethers.js module
const ethers = require('ethers');

// this must be set after ethers.js is imported to have access to the real Interface constructor
const { abi: poolAbi } = require('../abi/UniswapV3Pool.json');

mockPoolContract.interface = new ethers.utils.Interface(poolAbi);

const poolCreatedTopic = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';
const flashTopic = '0xbdbdb71d7860376ba52b25a5028beea23581364a40522f6bcfb86bb1f2dca633';
const EVEREST_ID = '0xa2e07f422b5d7cbbfca764e53b251484ecf945fa';

/* handler import */
// import the handler code after the mocked modules have been defined
const { provideHandleTransaction, provideInitialize } = require('./agent');

/* axios mock test */
describe('mock axios GET requests', () => {
  it('should call axios.get and return the mocked response for CoinGecko', async () => {
    mockCoinGeckoResponse.data = { '0xtokenaddress': { usd: 1000 } };
    const response = await axios.get('https://url.url');
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(response.data['0xtokenaddress'].usd).toEqual(1000);

    // reset call count for next test
    axios.get.mockClear();
    expect(axios.get).toHaveBeenCalledTimes(0);
  });
});

/* handler tests */
describe('large flash swap monitoring', () => {
  describe('handleTransaction', () => {
    let initializeData;
    let handleTransaction;

    // event Flash(
    //  address indexed sender,
    //  address indexed recipient,
    //  uint256 amount0,
    //  uint256 amount1,
    //  uint256 paid0,
    //  uint256 paid1
    // )

    // log with an event other than a Flash event
    const logsNoMatchEvent = [{ topics: [poolCreatedTopic] }];

    // log that matches a Flash event from a non-uniswap address
    // expect filterEvent to match on event but then Pool address check will fail
    // no additional topics or data are needed because this will fail before those checks occur
    const logsMatchFlashEventInvalidAddress = [
      { address: '0xINVALIDUNISWAPV3POOLADDRESS', topics: [flashTopic] },
    ];

    // log that matches a Flash event from a uniswap v3 pool address
    // expect all checks to work and for this to be processed completely
    // therefore, we need all valid topics and data for parseLog to properly decode
    const amount0 = 100;
    const amount0Hex64 = amount0.toString(16).padStart(64, '0');
    const hashZero = (ethers.constants.HashZero).slice(2);
    const logsMatchFlashEventAddressMatch = [{
      address: '0xFAKEPOOLADDRESS',
      topics: [
        flashTopic,
        ethers.constants.HashZero,
        ethers.constants.HashZero,
      ],
      data: `0x${amount0Hex64}${hashZero}${hashZero}${hashZero}`,
    }];

    beforeEach(async () => {
      initializeData = {};

      ethers.Contract = jest.fn().mockImplementationOnce(() => mockFactoryContract);

      // initialize the handler
      // this will create the mock provider and mock factory contract
      await (provideInitialize(initializeData))();
      handleTransaction = provideHandleTransaction(initializeData);
    });

    it('returns empty findings if no flash swaps occurred', async () => {
      const receipt = {
        logs: logsNoMatchEvent,
      };
      const txEvent = createTransactionEvent({ receipt });

      const findings = await handleTransaction(txEvent);

      expect(findings).toStrictEqual([]);
      expect(axios.get).toHaveBeenCalledTimes(0);
      expect(mockPoolContract.token0).toHaveBeenCalledTimes(0);
    });

    it('returns empty findings a Flash event occurred for a non-Uniswap V3 pool ', async () => {
      // supply ethers.Contract mock with correct mock contract objects to return
      ethers.Contract = jest.fn().mockImplementationOnce(() => mockPoolContract);

      const receipt = {
        logs: logsMatchFlashEventInvalidAddress,
      };
      const txEvent = createTransactionEvent({ receipt });

      const findings = await handleTransaction(txEvent);

      expect(findings).toStrictEqual([]);
      expect(axios.get).toHaveBeenCalledTimes(0);
      expect(mockPoolContract.token0).toHaveBeenCalledTimes(1);
      expect(mockPoolContract.token1).toHaveBeenCalledTimes(1);
      expect(mockPoolContract.fee).toHaveBeenCalledTimes(1);
      mockPoolContract.token0.mockClear();
      mockPoolContract.token1.mockClear();
      mockPoolContract.fee.mockClear();
    });

    it('returns empty findings for a Flash event lower than the threshold', async () => {
      // supply ethers.Contract mock with correct mock contract objects to return
      ethers.Contract = jest.fn()
        .mockImplementationOnce(() => mockPoolContract)
        .mockImplementationOnce(() => mockTokenContract)
        .mockImplementationOnce(() => mockTokenContract);

      const receipt = {
        logs: logsMatchFlashEventAddressMatch,
      };
      const txEvent = createTransactionEvent({ receipt });

      // set up the mocked response from axios to return the price of the token
      // intentionally set the price low enough that the threshold is not exceeded
      const threshold = initializeData.flashSwapThresholdUSDBN;

      const decimalScaling = (new BigNumber(10)).pow(mockDecimals);
      const amount0Scaled = (new BigNumber(amount0)).div(decimalScaling);
      const usdPricePerToken = threshold.minus(1).div(amount0Scaled);
      const usdPricePerTokenNum = parseInt(usdPricePerToken.toString(), 10);

      // set up the coin gecko response to return a value that will not cause a finding
      mockCoinGeckoResponse.data = {};
      mockCoinGeckoResponse.data[mockToken0Address.toLowerCase()] = { usd: usdPricePerTokenNum };
      mockCoinGeckoResponse.data[mockToken1Address.toLowerCase()] = { usd: usdPricePerTokenNum };

      // this will determine that the Flash included an amount of 100 tokens of token0
      const findings = await handleTransaction(txEvent);

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(findings).toStrictEqual([]);
      axios.get.mockClear();
      expect(axios.get).toHaveBeenCalledTimes(0);
      expect(mockPoolContract.token0).toHaveBeenCalledTimes(1);
      expect(mockPoolContract.token1).toHaveBeenCalledTimes(1);
      expect(mockPoolContract.fee).toHaveBeenCalledTimes(1);
      mockPoolContract.token0.mockClear();
      mockPoolContract.token1.mockClear();
      mockPoolContract.fee.mockClear();
    });

    it('returns a finding for a Flash event over the threshold', async () => {
      // supply ethers.Contract mock with correct mock contract objects to return
      ethers.Contract = jest.fn()
        .mockImplementationOnce(() => mockPoolContract)
        .mockImplementationOnce(() => mockTokenContract)
        .mockImplementationOnce(() => mockTokenContract);

      const receipt = {
        logs: logsMatchFlashEventAddressMatch,
      };
      const txEvent = createTransactionEvent({ receipt });

      // set up the mocked response from axios to return the price of the token
      // intentionally set the price just over the threshold for a finding
      const threshold = initializeData.flashSwapThresholdUSDBN;

      const decimalScaling = (new BigNumber(10)).pow(mockDecimals);
      const amount0Scaled = (new BigNumber(amount0)).div(decimalScaling);
      const usdPricePerToken = threshold.plus(1).div(amount0Scaled);
      const usdPricePerTokenNum = parseInt(usdPricePerToken.toString(), 10);

      // set up the coin gecko response to the appropriate price to cause a finding
      mockCoinGeckoResponse.data = {};
      mockCoinGeckoResponse.data[mockToken0Address.toLowerCase()] = { usd: usdPricePerTokenNum };
      mockCoinGeckoResponse.data[mockToken1Address.toLowerCase()] = { usd: usdPricePerTokenNum };

      // this will determine that the Flash included an amount of 100 tokens of token0
      const findings = await handleTransaction(txEvent);

      const expectedFindings = [
        Finding.fromObject({
          name: 'Forta Workshop 2: Uniswap V3 Large Flash Swap',
          description: `Large Flash Swap from pool ${mockPoolAddress}`,
          alertId: 'AE-FORTA-WORKSHOP2-UNISWAPV3-LARGE-FLASH-SWAP',
          severity: FindingSeverity.Info,
          type: FindingType.Info,
          protocol: 'UniswapV3',
          everestId: EVEREST_ID,
          metadata: {
            address: mockPoolAddress,
            token0Amount: amount0.toString(),
            token1Amount: '0',
            sender: ethers.constants.AddressZero,
            value0USD: (threshold.plus(1)).toString(),
            value1USD: '0',
            flashSwapThresholdUSD: (threshold.toString()),
          },
        }),
      ];

      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(findings).toStrictEqual(expectedFindings);
      axios.get.mockClear();
      expect(axios.get).toHaveBeenCalledTimes(0);
    });
  });
});
