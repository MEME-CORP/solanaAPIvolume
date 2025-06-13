const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { createJupiterApiClient } = require('@jup-ag/api');
const { connection, retry } = require('../utils/solanaUtils');
const { 
  sendAndConfirmVersionedTransaction,
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

// Configure Jupiter API client with proper base URL for free usage
// Based on Jupiter docs: https://dev.jup.ag/docs/ - use lite-api.jup.ag for free usage
const jupiterApiConfig = {
  basePath: 'https://lite-api.jup.ag'
};

console.log(`[JupiterService-SDK] Initializing Jupiter API client with base URL: ${jupiterApiConfig.basePath}`);

// Instantiate the Jupiter API client with proper configuration
const jupiterApi = createJupiterApiClient(jupiterApiConfig);

/**
 * Enhanced error handler to extract meaningful error information from the Jupiter API response.
 * @param {Error} error - The error from Jupiter SDK
 * @returns {Promise<string>} Detailed error message
 */
async function extractJupiterError(error) {
  // Log the raw error object for deep debugging
  console.error('[JupiterService-SDK] Raw error object:', {
    message: error.message,
    name: error.name,
    stack: error.stack,
    cause: error.cause,
    responseStatus: error.response?.status
  });

  // Try to extract more specific error information from the response body
  if (error.response) {
    try {
      // The response body contains the real error from Jupiter's API
      const errorBody = await error.response.json();
      const errorMessage = errorBody.error || JSON.stringify(errorBody);
      return `Jupiter API Error (HTTP ${error.response.status}): ${errorMessage}`;
    } catch (e) {
      // Fallback if the body isn't valid JSON or can't be read
      return `HTTP ${error.response.status}: ${error.response.statusText || 'Failed to parse error response'}`;
    }
  }
  
  if (error.cause) {
    return `${error.message} (Cause: ${error.cause.message || error.cause})`;
  }
  
  if (error.status) {
    return `HTTP ${error.status}: ${error.message}`;
  }
  
  return error.message || 'Unknown Jupiter API error';
}

/**
 * [ENHANCED] Fetch price quote from Jupiter using the SDK with better error handling.
 * @returns {Promise<import('@jup-ag/api').QuoteResponse>} The Jupiter quote response.
 * @throws {Error} If the quote cannot be fetched.
 */
async function getQuoteService(
  inputMint, 
  outputMint, 
  amount, 
  slippageBps = 50,
  onlyDirectRoutes = false,
  asLegacyTransaction = false,
  platformFeeBps = 0
) {
  try {
    const resolvedInputMint = TOKENS[inputMint] || inputMint;
    const resolvedOutputMint = TOKENS[outputMint] || outputMint;
    
    console.log(`[JupiterService-SDK] Requesting quote: ${amount} of ${resolvedInputMint} → ${resolvedOutputMint}`);
    console.log(`[JupiterService-SDK] Quote parameters:`, {
      slippageBps,
      onlyDirectRoutes,
      asLegacyTransaction,
      platformFeeBps
    });
    
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
      throw new Error('Could not find any route');
    }
    
    console.log(`[JupiterService-SDK] ✅ Quote successful:`, {
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct,
      routePlan: quote.routePlan?.length || 0
    });
    
    return quote;

  } catch (error) {
    const detailedError = await extractJupiterError(error);
    console.error('[JupiterService-SDK] Error fetching Jupiter quote:', detailedError);
    throw new Error(detailedError);
  }
}

/**
 * [ENHANCED] Execute a swap on Jupiter using the SDK with better error handling.
 * @returns {Promise<object>} Swap result including transaction ID.
 * @throws {Error} If the swap fails.
 */
async function executeSwapService(
  userWalletPrivateKeyBase58,
  quoteResponse,
  wrapAndUnwrapSol = true,
  asLegacyTransaction = false,
  collectFees = true
) {
  try {
    const secretKey = bs58.decode(userWalletPrivateKeyBase58);
    const userWallet = Keypair.fromSecretKey(secretKey);
    const userPublicKey = userWallet.publicKey;

    console.log(`[JupiterService-SDK] Executing swap for user: ${userPublicKey.toBase58()}`);
    console.log(`[JupiterService-SDK] Swap parameters:`, {
      inputMint: quoteResponse.inputMint,
      outputMint: quoteResponse.outputMint,
      inAmount: quoteResponse.inAmount,
      outAmount: quoteResponse.outAmount,
      wrapAndUnwrapSol,
      asLegacyTransaction
    });

    // Enhanced swap request with proper error handling
    console.log(`[JupiterService-SDK] Calling Jupiter swapPost API...`);
    
    const swapResult = await jupiterApi.swapPost({
      swapRequest: {
        userPublicKey: userPublicKey.toBase58(),
        quoteResponse: quoteResponse,
        wrapAndUnwrapSol: wrapAndUnwrapSol,
        dynamicComputeUnitLimit: true
      }
    });

    if (!swapResult || !swapResult.swapTransaction) {
      throw new Error('Invalid swap response: missing swapTransaction');
    }

    console.log(`[JupiterService-SDK] ✅ Swap transaction received from Jupiter API`);

    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Pre-flight check for native SOL swaps to prevent "custom program error: 1"
    if (quoteResponse.inputMint === TOKENS.SOL) {
      console.log(`[JupiterService-SDK] Performing pre-flight balance check for native SOL swap...`);
      const balance = await connection.getBalance(userPublicKey);
      const feeData = await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed');
      const fee = feeData.value || 5000; // Use 5000 lamports as a fallback fee

      const requiredLamports = BigInt(quoteResponse.inAmount) + BigInt(fee);

      console.log(`[JupiterService-SDK] Required SOL: ~${lamportsToSol(Number(requiredLamports))} (Amount: ${lamportsToSol(Number(quoteResponse.inAmount))} + Fee: ${lamportsToSol(fee)})`);
      console.log(`[JupiterService-SDK] Available SOL: ${lamportsToSol(balance)}`);

      if (BigInt(balance) < requiredLamports) {
        throw new Error(`Insufficient SOL balance. Wallet has ${lamportsToSol(balance)} SOL, but needs ~${lamportsToSol(Number(requiredLamports))} for the swap amount and transaction fees.`);
      }
    }

    // Sign the transaction
    transaction.sign([userWallet]);

    console.log(`[JupiterService-SDK] Transaction signed, sending to network...`);

    // Execute the transaction using the robust wrapper for versioned transactions
    const signature = await sendAndConfirmVersionedTransaction(
      connection,
      transaction,
      // No signers array needed as the new function handles pre-signed transactions
    );

    console.log(`[JupiterService-SDK] ✅ Swap confirmed! Signature: ${signature}`);

    const newBalance = await connection.getBalance(userPublicKey);
    
    return {
      status: 'success',
      transactionId: signature,
      newBalanceSol: lamportsToSol(newBalance),
      feeCollection: { 
        status: 'skipped', 
        message: 'Fee collection temporarily disabled during SDK refactor.' 
      }
    };

  } catch (error) {
    const detailedError = await extractJupiterError(error);
    console.error('[JupiterService-SDK] Error executing swap:', detailedError);
    throw new Error(detailedError);
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