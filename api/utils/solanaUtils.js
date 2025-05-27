const { Connection } = require('@solana/web3.js');

// Multiple RPC endpoints for better reliability and rate limiting distribution
const RPC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo', // Alchemy demo endpoint
  'https://mainnet.helius-rpc.com/?api-key=demo', // Helius demo endpoint  
  'https://api.mainnet-beta.solana.com' // Fallback to primary
];

// Current endpoint index for round-robin
let currentEndpointIndex = 0;
let failedEndpoints = new Set();

/**
 * Gets the next available RPC endpoint using round-robin with failure tracking
 * @returns {string} Next available RPC endpoint URL
 */
function getNextRpcEndpoint() {
  const availableEndpoints = RPC_ENDPOINTS.filter(endpoint => !failedEndpoints.has(endpoint));
  
  if (availableEndpoints.length === 0) {
    // Reset failed endpoints if all have failed
    console.warn('[SolanaUtils] All RPC endpoints failed, resetting failure tracking');
    failedEndpoints.clear();
    return RPC_ENDPOINTS[0];
  }
  
  const endpoint = availableEndpoints[currentEndpointIndex % availableEndpoints.length];
  currentEndpointIndex = (currentEndpointIndex + 1) % availableEndpoints.length;
  
  return endpoint;
}

/**
 * Marks an RPC endpoint as failed temporarily
 * @param {string} endpoint - The endpoint URL to mark as failed
 */
function markEndpointAsFailed(endpoint) {
  console.warn(`[SolanaUtils] Marking endpoint as failed: ${endpoint}`);
  failedEndpoints.add(endpoint);
  
  // Clear the failure after 5 minutes
  setTimeout(() => {
    failedEndpoints.delete(endpoint);
    console.log(`[SolanaUtils] Endpoint restored: ${endpoint}`);
  }, 300000); // 5 minutes
}

// Create connection with first available endpoint
let connection = new Connection(getNextRpcEndpoint(), {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000
});

/**
 * Creates a new connection with the next available RPC endpoint
 * @returns {Connection} New Solana connection object
 */
function createNewConnection() {
  const endpoint = getNextRpcEndpoint();
  console.log(`[SolanaUtils] Creating new connection to: ${endpoint}`);
  
  return new Connection(endpoint, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000
  });
}

/**
 * Switches to a different RPC endpoint if current one is having issues
 * @returns {Connection} New connection with different endpoint
 */
function switchRpcEndpoint() {
  const currentEndpoint = connection.rpcEndpoint;
  markEndpointAsFailed(currentEndpoint);
  connection = createNewConnection();
  return connection;
}

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
 * Enhanced retry function with endpoint switching for 429 errors and persistent failures
 * @param {Function} fn - The function to retry
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @param {number} initialDelay - Initial delay in milliseconds before first retry (default: 1000)
 * @param {boolean} switchEndpointOn429 - Whether to switch endpoint on 429 errors (default: true)
 * @returns {Promise<any>} The result of the successful function call
 * @throws {Error} The last error encountered if all retries fail
 */
async function retry(fn, maxRetries = 3, initialDelay = 1000, switchEndpointOn429 = true) {
  let lastError;
  let endpointSwitched = false;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Handle 429 rate limiting errors
      if ((error.message.includes('429') || error.message.includes('Too Many Requests')) && switchEndpointOn429 && !endpointSwitched) {
        console.warn(`[SolanaUtils] Rate limited, switching RPC endpoint (attempt ${i + 1})`);
        switchRpcEndpoint();
        endpointSwitched = true;
        
        // Longer wait after endpoint switch
        await delay(3000);
        continue;
      }
      
      // Handle connection/network errors
      if (error.message.includes('fetch') || error.message.includes('network') || error.message.includes('timeout')) {
        if (i < maxRetries - 1 && !endpointSwitched) {
          console.warn(`[SolanaUtils] Network error, switching endpoint (attempt ${i + 1})`);
          switchRpcEndpoint();
          endpointSwitched = true;
          await delay(2000);
          continue;
        }
      }
      
      const waitTime = initialDelay * Math.pow(2, i);
      console.log(`[SolanaUtils] Attempt ${i + 1} failed. Retrying in ${waitTime}ms...`);
      await delay(waitTime);
    }
  }
  throw lastError;
}

/**
 * Gets recent blockhash with proper commitment level and endpoint switching
 * @param {Connection} connectionOverride - Optional connection to use instead of global
 * @param {string} [commitment='confirmed'] - Commitment level
 * @returns {Promise<{blockhash: string, lastValidBlockHeight: number}>}
 */
async function getRecentBlockhash(connectionOverride = null, commitment = 'confirmed') {
  console.log(`[SolanaUtils] Fetching recent blockhash with commitment: ${commitment}`);
  
  const conn = connectionOverride || connection;
  
  const result = await retry(async () => {
    return await conn.getLatestBlockhash(commitment);
  }, 3, 1000, true); // Enable endpoint switching for blockhash calls
  
  console.log(`[SolanaUtils] Blockhash obtained: ${result.blockhash.slice(0, 8)}...`);
  return result;
}

/**
 * Health check for RPC endpoints
 * @param {string} endpoint - RPC endpoint to check
 * @returns {Promise<boolean>} True if endpoint is healthy
 */
async function checkEndpointHealth(endpoint) {
  try {
    const testConnection = new Connection(endpoint);
    const start = Date.now();
    await testConnection.getSlot();
    const responseTime = Date.now() - start;
    
    console.log(`[SolanaUtils] Endpoint ${endpoint} response time: ${responseTime}ms`);
    return responseTime < 5000; // Consider healthy if responds within 5 seconds
  } catch (error) {
    console.warn(`[SolanaUtils] Endpoint ${endpoint} health check failed:`, error.message);
    return false;
  }
}

/**
 * Performs health checks on all endpoints and updates failure tracking
 */
async function performHealthChecks() {
  console.log('[SolanaUtils] Performing endpoint health checks...');
  
  for (const endpoint of RPC_ENDPOINTS) {
    const isHealthy = await checkEndpointHealth(endpoint);
    if (!isHealthy && !failedEndpoints.has(endpoint)) {
      markEndpointAsFailed(endpoint);
    } else if (isHealthy && failedEndpoints.has(endpoint)) {
      failedEndpoints.delete(endpoint);
      console.log(`[SolanaUtils] Endpoint recovered: ${endpoint}`);
    }
  }
}

// Periodic health checks every 2 minutes
setInterval(performHealthChecks, 120000);

module.exports = {
  connection,
  createNewConnection,
  switchRpcEndpoint,
  getNextRpcEndpoint,
  delay,
  sleep,
  retry,
  getRecentBlockhash,
  checkEndpointHealth,
  performHealthChecks,
  // Legacy exports for compatibility
  MAINNET_URL: RPC_ENDPOINTS[0]
}; 