const { Connection } = require('@solana/web3.js');

// Get RPC URL from environment variable or use default mainnet-beta
const MAINNET_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

console.log(`[SolanaUtils] Using RPC endpoint: ${MAINNET_URL}`);

// Create connection with optimized settings for fast confirmation
let connection = new Connection(MAINNET_URL, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000, // Increased timeout for better confirmation
  wsEndpoint: undefined // Disable WebSocket for more predictable behavior
});

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
 * Simple retry function with exponential backoff
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
      
      if (i < maxRetries - 1) {
        const waitTime = initialDelay * Math.pow(2, i);
        console.log(`[SolanaUtils] Attempt ${i + 1} failed. Retrying in ${waitTime}ms...`);
        await delay(waitTime);
      }
    }
  }
  throw lastError;
}

/**
 * Gets recent blockhash with proper commitment level
 * @param {Connection} connectionOverride - Optional connection to use instead of global
 * @param {string} [commitment='confirmed'] - Commitment level
 * @returns {Promise<{blockhash: string, lastValidBlockHeight: number}>}
 */
async function getRecentBlockhash(connectionOverride = null, commitment = 'confirmed') {
  console.log(`[SolanaUtils] Fetching recent blockhash with commitment: ${commitment}`);
  
  const conn = connectionOverride || connection;
  
  const result = await retry(async () => {
    return await conn.getLatestBlockhash(commitment);
  }, 3, 1000);
  
  console.log(`[SolanaUtils] Blockhash obtained: ${result.blockhash.slice(0, 8)}...`);
  return result;
}

module.exports = {
  connection,
  delay,
  sleep,
  retry,
  getRecentBlockhash,
  // Legacy exports for compatibility
  MAINNET_URL
}; 