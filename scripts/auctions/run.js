const { default_yargs } = require("../utils/default_yargs")
const { runAuction } = require("./auctions")(web3, artifacts)

const argv = default_yargs
  .option("gasPrice", {
    type: "string",
    describe: "Gas price to be used for order submission",
    choices: ["lowest", "safeLow", "standard", "fast", "fastest"],
    default: "standard",
  })
  .option("gasPriceScale", {
    type: "number",
    describe: "Scale used as a multiplier to the gas price",
    default: 1.0,
  })
  .option("strategyFile", {
    type: "string",
    describe: "file containing the orders to be placed in the auction",
    default: 500,
  })
  .option("startTimestamp", {
    type: "number",
    describe: "Unix timestamp in milliseconds at which the auction is supposed to start",
    demandOption: true,
  })
  .option("priceAllowancePercent", {
    type: "number",
    describe: "How much to change the current price in favour of the users when creating an order (e.g., 10)",
    demandOption: true,
  }).argv

module.exports = async (callback) => {
  try {
    await runAuction(argv)
    callback()
  } catch (error) {
    callback(error)
  }
}
