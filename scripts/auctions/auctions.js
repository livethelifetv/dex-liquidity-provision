const fs = require("fs").promises
const { decodeOrders } = require("@gnosis.pm/dex-contracts")

const { uniqueItems } = require("../utils/js_helpers")

const { getUnlimitedOrderAmounts } = require("@gnosis.pm/dex-contracts")
const { floatToErc20Units, toErc20Units } = require("../utils/printing_tools")
const { getOneinchPrice } = require("../utils/price_utils")
const { fetchGasPrices } = require("../utils/gas")

const MILLIS_IN_ONE_DAY = 24 * 3600 * 1000
const MAX_ADMISSIBLE_GAS_PRICE_WEI = 10000 * 10 ** 9

module.exports = function (web3, artifacts) {
  const { fetchTokenInfoFromExchange } = require("../utils/trading_strategy_helpers")(web3, artifacts)
  const { getExchange } = require("../utils/trading_strategy_helpers")(web3, artifacts)

  const throwOnMalformedArguments = function (argv) {
    const priceAllowancePercent = argv.priceAllowancePercent
    if (!Number.isInteger(priceAllowancePercent)) {
      throw new Error("Price allowance must be a number (with no percent symbol)")
    }
    if (priceAllowancePercent < 0 || priceAllowancePercent > 100) {
      throw new Error("Price allowance must lie between 0 and 100")
    }
    const startTimestamp = argv.startTimestamp
    const minimumReasonableStart = Date.parse("01 Jan 2020 00:00:00 GMT")
    if (startTimestamp < minimumReasonableStart) {
      throw new Error("Start timestamp describes a date before the year 2020. Is the start timestamp in milliseconds?")
    }
  }

  const throwOnMalformedStrategy = function (strategy) {
    if (!Array.isArray(strategy)) {
      throw new Error("Strategy file does not contain an array")
    }
    strategy.forEach((order) => {
      if (
        !Number.isInteger(order.buyTokenId) ||
        !Number.isInteger(order.sellTokenId) ||
        typeof order.buyTokenSymbol !== "string" ||
        typeof order.sellTokenSymbol !== "string"
      ) {
        console.error(`Bad order: ${JSON.stringify(order)}`)
        throw new Error("Order from strategy file is not valid")
      }
    })
  }

  const throwIfTokenIdAndSymbolDontMatch = async function (strategy, tokenInfoPromises) {
    for (const order of strategy) {
      for (const [id, symbol] of [
        [order.buyTokenId, order.buyTokenSymbol],
        [order.sellTokenId, order.sellTokenSymbol],
      ]) {
        const idToSymbol = (await tokenInfoPromises[id]).symbol

        if (idToSymbol !== symbol) {
          throw new Error(`Token at given id (${id}, ${idToSymbol}) and token symbol (${symbol}) don't match.`)
        }
      }
    }
  }

  const openOrFutureOrdersArePresent = async function (user, exchange) {
    const orders = decodeOrders(await exchange.getEncodedUserOrders.call(user))
    for (const order of orders) {
      // note: JS tomestamps are in milliseconds, Solidity timestamps in seconds
      if (order.validUntil >= Date.now() / 1000) {
        return true
      }
    }
    return false
  }

  const determineOrderToExecute = function (strategy, startTimestamp) {
    const currentTimestamp = Date.now()
    const millisAfterStart = currentTimestamp > startTimestamp ? currentTimestamp - startTimestamp : 0
    // day zero is the day in which the auction starts
    const dayOfOrder = Math.ceil(millisAfterStart / MILLIS_IN_ONE_DAY)
    // Orders of a strategy are executed sequentially:
    // on day zero the first order is executed, on day one the second, and so on.
    // After all orders in a strategy have been created once, they are created again in the same order.
    return strategy[dayOfOrder % strategy.length]
  }

  const gasPriceWei = async function (gasPriceString, gasPriceScale) {
    const gasPrices = await fetchGasPrices()
    const price = gasPrices[gasPriceString]
    if (!price) {
      console.error("Gas prices:", JSON.stringify(gasPrices))
      console.error("Desired gas price:", gasPriceString)
      throw new Error("Unable to retrieve gas price in wei")
    }

    if (price > MAX_ADMISSIBLE_GAS_PRICE_WEI) {
      throw new Error(`Gas price of ${price / 10 ** 9} Gwei is too high, refusing to continue`)
    }

    // apply scaling constant to gas price
    const scaledGasPrice = parseInt(price * gasPriceScale)

    return scaledGasPrice
  }

  const runAuction = async function (argv) {
    throwOnMalformedArguments(argv)

    const account = (await web3.eth.getAccounts())[0]
    console.log("Using account", account)
    const exchange = await getExchange()

    if (await openOrFutureOrdersArePresent(account, exchange)) {
      throw new Error(
        "No order is created because other auction orders have already been created. Maybe this script has already been executed today?"
      )
    }

    const strategy = JSON.parse(await fs.readFile(argv.strategyFile, "utf8"))
    throwOnMalformedStrategy(strategy)

    const tokenIdSet = new Set()
    strategy.forEach((order) => {
      tokenIdSet.add(order.buyTokenId)
      tokenIdSet.add(order.sellTokenId)
    })
    const tokenIds = Array.from(tokenIdSet.values())
    console.log(tokenIds)
    const tokenInfoPromises = fetchTokenInfoFromExchange(exchange, tokenIds, true)

    await throwIfTokenIdAndSymbolDontMatch(strategy, tokenInfoPromises)

    const order = determineOrderToExecute(strategy, argv.startTimestamp)
    const buyTokenData = await tokenInfoPromises[order.buyTokenId]
    const sellTokenData = await tokenInfoPromises[order.sellTokenId]
    console.log("Executing order", JSON.stringify(order))

    const exchangeRate = (await getOneinchPrice(buyTokenData, sellTokenData)).price
    console.log(`Oracle price: ${exchangeRate} ${order.sellTokenSymbol} per ${order.buyTokenSymbol}`)

    const adjustedExchangeRate = exchangeRate * ((100 - argv.priceAllowancePercent) / 100)
    console.log(`Posted price: ${adjustedExchangeRate} ${order.sellTokenSymbol} per ${order.buyTokenSymbol}`)
    console.log(`       i.e., ${1 / adjustedExchangeRate} ${order.buyTokenSymbol} per ${order.sellTokenSymbol}`)

    const sellTokenBalance = await exchange.getBalance(account, sellTokenData.address)
    console.log("Sell token balance:", toErc20Units(sellTokenBalance.toString(), sellTokenData.decimals))

    const orders = []
    const { base: buyAmount, quote: sellAmount } = getUnlimitedOrderAmounts(
      adjustedExchangeRate,
      sellTokenData.decimals,
      buyTokenData.decimals
    )
    orders.push({
      buyToken: argv.buyTokenId,
      sellToken: argv.sellTokenId,
      buyAmount: buyAmount,
      sellAmount: sellAmount,
    })

    const gasPrice = await gasPriceWei(argv.gasPrice, argv.gasPriceScale)
    console.log("Gas price in wei:", gasPrice)

    // continue from here

    if (orders.length > 0) {
      // Fetch auction index and declare validity interval for orders.
      // Note that order validity interval is inclusive on both sides.
      const batchId = (await batchExchange.getCurrentBatchId.call()).toNumber()
      const validFroms = Array(orders.length).fill(batchId)
      const validTos = Array(orders.length).fill(batchId)

      const gasPrices = await fetchGasPrices(argv.network)
      const scaledGasPrice = parseInt(gasPrices[argv.gasPrice] * argv.gasPriceScale)
      console.log(`Using current "${argv.gasPrice}" gas price scaled by ${argv.gasPriceScale}: ${scaledGasPrice}`)
      await batchExchange.placeValidFromOrders(
        orders.map((order) => order.buyToken),
        orders.map((order) => order.sellToken),
        validFroms,
        validTos,
        orders.map((order) => order.buyAmount),
        orders.map((order) => order.sellAmount),
        {
          from: account,
          gasPrice: scaledGasPrice,
        }
      )
    }
  }

  return {
    runAuction,
  }
}
