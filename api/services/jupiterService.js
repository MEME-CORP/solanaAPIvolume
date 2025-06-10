const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const { connection, retry } = require('../utils/solanaUtils');
const { 
  sendAndConfirmTransactionWrapper, 
  lamportsToSol,
} = require('../utils/transactionUtils');

// Common token addresses
const TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
};

// Fee collector wallet address
const FEE_COLLECTOR_ADDRESS = 'FKS2idx6M1WyBeWtMr2tY9XSFsVvKNy84rS9jq9W1qfo';

// Instantiate the Jupiter API client once and reuse it
const jupiterApi = createJupiterApiClient();

/**
 * [REFACTORED] Fetch price quote from Jupiter using the SDK.
 * This replaces the manual fetch call with a more reliable SDK method.
 * @returns {Promise<import('@jup-ag/api').QuoteResponse>} The Jupiter quote response.
 * @throws {Error} If the quote cannot be fetched.
 */
async function getQuoteService(
  inputMint, 
  outputMint, 
  amount, 
  slippageBps = 50,
  onlyDirectRoutes = false,
  asLegacyTransaction = false, // Note: asLegacyTransaction may have limited support
  platformFeeBps = 0
) {
  try {
    const resolvedInputMint = TOKENS[inputMint] || inputMint;
    const resolvedOutputMint = TOKENS[outputMint] || outputMint;
    
    console.log(`[JupiterService-SDK] Requesting quote: ${amount} of ${resolvedInputMint} → ${resolvedOutputMint}`);
    
    const quote = await jupiterApi.quoteGet({
      inputMint: resolvedInputMint,
      outputMint: resolvedOutputMint,
      amount: Number(amount),
      slippageBps,
      onlyDirectRoutes,
      asLegacyTransaction,
      platformFeeBps,
    });

    if (!quote) {
      // This will be caught by the controller and classified as NO_ROUTE_FOUND
      throw new Error('Could not find any route');
    }
    
    return quote;

  } catch (error) {
    console.error('[JupiterService-SDK] Error fetching Jupiter quote:', error);
    // Re-throw the error so the controller can classify it
    throw error;
  }
}

/**
 * [REFACTORED] Execute a swap on Jupiter using the SDK.
 * This is the core fix that resolves serialization and Token-2022 issues.
 * @returns {Promise<object>} Swap result including transaction ID.
 * @throws {Error} If the swap fails.
 */
async function executeSwapService(
  userWalletPrivateKeyBase58,
  quoteResponse,
  // wrapAndUnwrapSol and asLegacyTransaction are now handled in swapPost
) {
  try {
    const secretKey = bs58.decode(userWalletPrivateKeyBase58);
    const userWallet = Keypair.fromSecretKey(secretKey);
    const userPublicKey = userWallet.publicKey;

    console.log(`[JupiterService-SDK] Executing swap for user: ${userPublicKey.toBase58()}`);

    // Get the serialized transaction from the Jupiter API via the SDK
    // This is the key step that fixes the previous errors.
    const { swapTransaction } = await jupiterApi.swapPost({
      swapRequest: {
        userPublicKey: userPublicKey.toBase58(),
        quoteResponse: quoteResponse,
        wrapAndUnwrapSol: true,
        // The SDK and API handle fee and compute unit optimization automatically.
        dynamicComputeUnitLimit: true, 
        prioritizationFeeLamports: 'auto' // Recommended setting
      }
    });

    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Sign the transaction
    transaction.sign([userWallet]);

    // Execute the transaction using the robust wrapper
    const signature = await sendAndConfirmTransactionWrapper(
      connection,
      transaction,
      [userWallet] // The userWallet is the only required signer
    );

    console.log(`[JupiterService-SDK] ✅ Swap confirmed! Signature: ${signature}`);

    const newBalance = await connection.getBalance(userPublicKey);
    
    return {
      status: 'success',
      transactionId: signature,
      newBalanceSol: lamportsToSol(newBalance),
      // Fee collection logic can be added back here if needed,
      // but the primary swap logic is now much cleaner.
      feeCollection: { status: 'skipped', message: 'Fee collection temporarily disabled during SDK refactor.' }
    };

  } catch (error) {
    console.error('[JupiterService-SDK] Error executing swap:', error.message);
    // Re-throw the error to be handled by the controller's classifier
    // Include full error for better logging in the controller
    throw new Error(`Failed to execute swap: ${error.message}`, { cause: error });
  }
}

/**
 * Get information about tokens supported by Jupiter
 * @returns {Object} Object containing token mint addresses
 */
function getSupportedTokens() {
  return TOKENS;
}

module.exports = {
  getQuoteService,
  executeSwapService,
  getSupportedTokens,
  TOKENS,
  FEE_COLLECTOR_ADDRESS,
}; 