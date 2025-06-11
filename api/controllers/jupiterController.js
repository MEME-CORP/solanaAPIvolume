const jupiterService = require('../services/jupiterService');

/**
 * Enhanced error classifier for Jupiter API responses
 * @param {Error} error - The error object from Jupiter service
 * @returns {Object} Classified error with proper status code and error type
 */
function classifyJupiterError(error) {
  const errorMessage = error.message || '';
  
  // Jupiter API 400 errors - legitimate responses for business logic issues
  if (errorMessage.includes('Could not find any route')) {
    return {
      status: 400,
      errorCode: 'NO_ROUTE_FOUND',
      message: 'No trading route found for this token pair. This may be due to low liquidity or an unsupported token.',
      userMessage: 'Unable to find a swap route for these tokens. Please check token addresses or try a different pair.',
      category: 'BUSINESS_LOGIC'
    };
  }
  
  if (errorMessage.includes('Invalid input mint') || errorMessage.includes('Invalid output mint')) {
    return {
      status: 400,
      errorCode: 'INVALID_TOKEN_ADDRESS',
      message: 'Invalid token mint address provided.',
      userMessage: 'One or both token addresses are invalid. Please verify the token addresses.',
      category: 'VALIDATION'
    };
  }
  
  // Jupiter API 422 errors - serialization/format issues
  if (errorMessage.includes('Failed to deserialize') || errorMessage.includes('Parse error: WrongSize')) {
    return {
      status: 422,
      errorCode: 'SERIALIZATION_ERROR',
      message: 'Quote response format incompatible with swap endpoint.',
      userMessage: 'There was an issue processing the swap quote. Please request a new quote and try again.',
      category: 'SERIALIZATION'
    };
  }
  
  // Network/Infrastructure errors (502)
  if (errorMessage.includes('HTTP error! Status: 5') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('timeout')) {
    return {
      status: 502,
      errorCode: 'JUPITER_API_UNAVAILABLE',
      message: 'Jupiter API is temporarily unavailable.',
      userMessage: 'The trading service is temporarily unavailable. Please try again in a moment.',
      category: 'INFRASTRUCTURE'
    };
  }
  
  // Transaction execution errors (simulation failures, etc.)
  if (errorMessage.includes('custom program error: 0x26') || errorMessage.includes('InvalidSplTokenProgram')) {
    return {
      status: 400,
      errorCode: 'TOKEN_PROGRAM_INCOMPATIBLE',
      message: 'Token program incompatibility detected (likely Token-2022 issue).',
      userMessage: 'This token is not compatible with the current swap method. Please try a different token or contact support.',
      category: 'TOKEN_COMPATIBILITY'
    };
  }
  
  if (errorMessage.includes('Transaction simulation failed') || errorMessage.includes('transaction failed')) {
    return {
      status: 400,
      errorCode: 'TRANSACTION_SIMULATION_FAILED',
      message: 'Swap transaction simulation failed.',
      userMessage: 'The swap transaction could not be completed. Please check your balance and try again.',
      category: 'TRANSACTION'
    };
  }
  
  // Default to internal server error for unclassified errors
  return {
    status: 500,
    errorCode: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred.',
    userMessage: 'An internal error occurred. Please try again later.',
    category: 'INTERNAL'
  };
}

/**
 * Controller to handle getting a swap quote from Jupiter.
 */
async function getQuoteController(req, res) {
  try {
    const { 
      inputMint, 
      outputMint, 
      amount, 
      slippageBps = 50,
      onlyDirectRoutes = false,
      asLegacyTransaction = false,
      platformFeeBps = 0
    } = req.body;

    // Validate required parameters
    if (!inputMint) {
      return res.status(400).json({
        message: 'Missing required parameter: inputMint',
        errorCode: 'MISSING_INPUT_MINT'
      });
    }

    if (!outputMint) {
      return res.status(400).json({
        message: 'Missing required parameter: outputMint',
        errorCode: 'MISSING_OUTPUT_MINT'
      });
    }

    if (!amount) {
      return res.status(400).json({
        message: 'Missing required parameter: amount',
        errorCode: 'MISSING_AMOUNT'
      });
    }

    // Convert string booleans to actual booleans if needed
    const parsedOnlyDirectRoutes = typeof onlyDirectRoutes === 'string' 
      ? onlyDirectRoutes.toLowerCase() === 'true' 
      : Boolean(onlyDirectRoutes);
    
    const parsedAsLegacyTransaction = typeof asLegacyTransaction === 'string'
      ? asLegacyTransaction.toLowerCase() === 'true'
      : Boolean(asLegacyTransaction);

    // Parse numeric values
    const parsedAmount = parseInt(amount, 10);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        message: 'Invalid amount parameter: must be a positive number',
        errorCode: 'INVALID_AMOUNT'
      });
    }

    const parsedSlippageBps = parseInt(slippageBps, 10);
    if (isNaN(parsedSlippageBps) || parsedSlippageBps < 0) {
      return res.status(400).json({
        message: 'Invalid slippageBps parameter: must be a non-negative number',
        errorCode: 'INVALID_SLIPPAGE'
      });
    }

    const parsedPlatformFeeBps = parseInt(platformFeeBps, 10);
    if (isNaN(parsedPlatformFeeBps) || parsedPlatformFeeBps < 0) {
      return res.status(400).json({
        message: 'Invalid platformFeeBps parameter: must be a non-negative number',
        errorCode: 'INVALID_PLATFORM_FEE'
      });
    }

    // Call the service function to get a quote
    const quoteResponse = await jupiterService.getQuoteService(
      inputMint,
      outputMint,
      parsedAmount,
      parsedSlippageBps,
      parsedOnlyDirectRoutes,
      parsedAsLegacyTransaction,
      parsedPlatformFeeBps
    );

    res.status(200).json({
      message: 'Jupiter quote retrieved successfully',
      quoteResponse: quoteResponse
    });
  } catch (error) {
    // Enhanced structured logging for observability
    console.error('[JupiterController] Quote error:', {
      inputMint,
      outputMint,
      amount,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    
    // Classify error and send appropriate response
    const classifiedError = classifyJupiterError(error);
    
    res.status(classifiedError.status).json({
      message: classifiedError.userMessage,
      errorCode: classifiedError.errorCode,
      category: classifiedError.category,
      // Include technical details for debugging (remove in production if needed)
      details: classifiedError.message
    });
  }
}

/**
 * Controller to execute a swap on Jupiter.
 */
async function executeSwapController(req, res) {
  try {
    const { 
      userWalletPrivateKeyBase58, 
      quoteResponse,
      wrapAndUnwrapSol = true,
      asLegacyTransaction = false,
      collectFees = true
    } = req.body;

    // Validate required parameters
    if (!userWalletPrivateKeyBase58) {
      return res.status(400).json({
        message: 'Missing required parameter: userWalletPrivateKeyBase58',
        errorCode: 'MISSING_PRIVATE_KEY'
      });
    }

    if (!quoteResponse) {
      return res.status(400).json({
        message: 'Missing required parameter: quoteResponse',
        errorCode: 'MISSING_QUOTE_RESPONSE'
      });
    }

    // Validate quote response structure
    if (!quoteResponse.inputMint || !quoteResponse.outputMint || !quoteResponse.inAmount || !quoteResponse.outAmount) {
      return res.status(400).json({
        message: 'Invalid quoteResponse: missing required fields',
        errorCode: 'INVALID_QUOTE_STRUCTURE'
      });
    }

    // Convert string booleans to actual booleans if needed
    const parsedWrapAndUnwrapSol = typeof wrapAndUnwrapSol === 'string' 
      ? wrapAndUnwrapSol.toLowerCase() === 'true' 
      : Boolean(wrapAndUnwrapSol);
    
    const parsedAsLegacyTransaction = typeof asLegacyTransaction === 'string'
      ? asLegacyTransaction.toLowerCase() === 'true'
      : Boolean(asLegacyTransaction);

    const parsedCollectFees = typeof collectFees === 'string'
      ? collectFees.toLowerCase() === 'true'
      : Boolean(collectFees);

    // Call the service function to execute the swap
    const swapResult = await jupiterService.executeSwapService(
      userWalletPrivateKeyBase58,
      quoteResponse,
      parsedWrapAndUnwrapSol,
      parsedAsLegacyTransaction,
      parsedCollectFees
    );

    res.status(200).json({
      message: 'Swap executed successfully',
      ...swapResult
    });
  } catch (error) {
    // Enhanced structured logging for observability
    console.error('[JupiterController] Swap error:', {
      inputMint: req.body.quoteResponse?.inputMint,
      outputMint: req.body.quoteResponse?.outputMint,
      inAmount: req.body.quoteResponse?.inAmount,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    
    // Classify error and send appropriate response
    const classifiedError = classifyJupiterError(error);
    
    res.status(classifiedError.status).json({
      message: classifiedError.userMessage,
      errorCode: classifiedError.errorCode,
      category: classifiedError.category,
      // Include technical details for debugging (remove in production if needed)
      details: classifiedError.message
    });
  }
}

/**
 * Controller to get information about supported tokens.
 */
function getSupportedTokensController(req, res) {
  try {
    const tokens = jupiterService.getSupportedTokens();
    
    res.status(200).json({
      message: 'Supported tokens retrieved successfully',
      tokens: tokens
    });
  } catch (error) {
    console.error('[JupiterController] Supported tokens error:', {
      error: error.message,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({ 
      message: 'Error retrieving supported tokens.',
      errorCode: 'TOKENS_RETRIEVAL_ERROR',
      category: 'INTERNAL',
      details: error.message || 'An unexpected error occurred.'
    });
  }
}

module.exports = {
  getQuoteController,
  executeSwapController,
  getSupportedTokensController
}; 