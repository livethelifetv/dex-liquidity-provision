const fetch = require("node-fetch")

const gasStationURL = {
  mainnet: "https://safe-relay.gnosis.io/api/v1/gas-station/",
  rinkeby: "https://safe-relay.rinkeby.gnosis.io/api/v1/gas-station/",
}

/**
 * Computes the gas prices in wei to submit a transaction in the given
 * network.
 *
 * @param {string} network Name of the network for which to retrieve a
 * gas estimate. It has the same format as Truffle's network argument.
 * @returns {object} An object that associates the desired confirmation
 * speed ("lowest", "safeLow", "standard", "fast", "fastest") to the
 * corresponding estimated gas price in wei.
 */
const fetchGasPrices = async function (network) {
  return (await fetch(gasStationURL[network])).json()
}

module.exports = {
  fetchGasPrices,
}
