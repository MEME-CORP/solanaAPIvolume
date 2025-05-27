const { Connection } = require('@solana/web3.js');

// Default Solana mainnet connection
const MAINNET_URL = 'https://api.mainnet-beta.solana.com';
const connection = new Connection(MAINNET_URL);

/**
 * Helper function to add delay between operations
 * @param {number} ms - The number of milliseconds to delay
 * @returns {Promise<void>} A promise that resolves after the specified delay
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sleep utility function (alias for delay)
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Helper function to retry operations with exponential backoff
 * @param {Function} fn - The function to retry
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} initialDelay - Initial delay in milliseconds before first retry (default: 1000)
 * @returns {Promise<any>} The result of the successful function call
 * @throws {Error} The last error encountered if all retries fail
 */
async function retry(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const waitTime = initialDelay * Math.pow(2, i);
      console.log(`[SolanaUtils] Attempt ${i + 1} failed. Retrying in ${waitTime}ms...`);
      await delay(waitTime);
    }
  }
  throw lastError;
}

/**
 * Gets recent blockhash with proper commitment level
 * @param {Connection} connection - Solana connection object
 * @param {string} [commitment='confirmed'] - Commitment level
 * @returns {Promise<{blockhash: string, lastValidBlockHeight: number}>}
 */
async function getRecentBlockhash(connection, commitment = 'confirmed') {
  console.log(`[SolanaUtils] Fetching recent blockhash with commitment: ${commitment}`);
  const result = await connection.getLatestBlockhash(commitment);
  console.log(`[SolanaUtils] Blockhash obtained: ${result.blockhash.slice(0, 8)}...`);
  return result;
}

module.exports = {
  MAINNET_URL,
  connection,
  delay,
  sleep,
  retry,
  getRecentBlockhash
}; 