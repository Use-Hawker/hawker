// Local fork of Robinhood Chain for testing HawkerTill against the real USDG.
module.exports = {
  networks: {
    hardhat: {
      chainId: 4663,
      hardfork: 'cancun',
      chains: { 4663: { hardforkHistory: { cancun: 0 } } },
      forking: { url: process.env.FORK_RPC || 'https://rpc.mainnet.chain.robinhood.com' },
      mining: { auto: true },
    },
  },
};
