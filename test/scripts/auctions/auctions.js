const BN = require("bn.js")
const fs = require("fs").promises
const tmp = require("tmp-promise")
const assertNodejs = require("assert")

const BatchExchange = artifacts.require("BatchExchange")
const ERC20 = artifacts.require("ERC20Detailed")
const MintableToken = artifacts.require("DetailedMintableToken")
const GnosisSafe = artifacts.require("GnosisSafe")
const ProxyFactory = artifacts.require("GnosisSafeProxyFactory")

const { runAuction } = require("../../../scripts/auctions/auctions")(web3, artifacts)
const { addCustomMintableTokenToExchange } = require("../../../scripts/utils/strategy_simulator")(web3, artifacts)
const { toErc20Units, fromErc20Units } = require("../../../scripts/utils/printing_tools")

const bnMaxUint256 = new BN(2).pow(new BN(256)).subn(1)

contract("Auctions", function (accounts) {
  let gnosisSafeMasterCopy
  let proxyFactory
  let exchange
  const safeOwner = accounts[0]

  beforeEach(async function () {
    gnosisSafeMasterCopy = await GnosisSafe.new()

    exchange = await BatchExchange.deployed()
  })

  describe("using withdrawal file", () => {
    it("requests withdrawals", async () => {
      const { id: id1, token: token1 } = await addCustomMintableTokenToExchange(exchange, "WETH", 18, accounts[0])
      await token1.mint(accounts[0], toErc20Units("1", 18))
      const { id: id2, token: token2 } = await addCustomMintableTokenToExchange(exchange, "USDC", 6, accounts[0])
      await token2.mint(accounts[0], toErc20Units("400", 6))

      const strategy = [
        {
          buyTokenId: id1,
          buyTokenSymbol: "WETH",
          sellTokenId: id2,
          sellTokenSymbol: "USDC",
        },
        {
          buyTokenId: id2,
          buyTokenSymbol: "USDC",
          sellTokenId: id1,
          sellTokenSymbol: "WETH",
        },
      ]
      const strategyFile = await tmp.file()
      await fs.writeFile(strategyFile.path, JSON.stringify(strategy))

      const argv = {
        strategyFile: strategyFile.path,
        priceAllowancePercent: 10,
        startTimestamp: Date.now(),
      }

      await runAuction(argv)

      await strategyFile.cleanup()
    })
  })
})
