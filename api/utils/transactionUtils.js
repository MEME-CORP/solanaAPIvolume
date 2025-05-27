const web3 = require('@solana/web3.js');
const { connection, delay } = require('./solanaUtils');

/**
 * RPC rate limiting protection
 */
let lastRpcCall = 0;
const RPC_CALL_INTERVAL = 200; // 200ms between RPC calls to avoid 429 errors

async function rateLimitedRpcCall(rpcFunction, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            // Ensure minimum interval between RPC calls
            const now = Date.now();
            const timeSinceLastCall = now - lastRpcCall;
            if (timeSinceLastCall < RPC_CALL_INTERVAL) {
                await sleep(RPC_CALL_INTERVAL - timeSinceLastCall);
            }
            lastRpcCall = Date.now();
            
            return await rpcFunction();
        } catch (error) {
            if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                const backoffTime = Math.min(1000 * Math.pow(2, i), 8000); // Max 8 second backoff
                console.warn(`[TransactionUtils] RPC rate limited, waiting ${backoffTime}ms (attempt ${i + 1}/${retries})`);
                await sleep(backoffTime);
                continue;
            }
            throw error;
        }
    }
    throw new Error('RPC call failed after rate limiting retries');
}

/**
 * Gets recent blockhash with proper commitment level and rate limiting protection
 * @param {web3.Connection} connection - Solana connection object
 * @param {web3.Commitment} [commitment='confirmed'] - Commitment level
 * @returns {Promise<{blockhash: string, lastValidBlockHeight: number}>}
 */
async function getRecentBlockhash(connection, commitment = 'confirmed') {
    console.log(`[TransactionUtils] Fetching recent blockhash with commitment: ${commitment}`);
    
    const result = await rateLimitedRpcCall(async () => {
        return await connection.getLatestBlockhash(commitment);
    });
    
    console.log(`[TransactionUtils] Blockhash obtained: ${result.blockhash.slice(0, 8)}...`);
    return result;
}

/**
 * Sleep utility function
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Adds priority fee instructions to a transaction.
 * @param {web3.Transaction} transaction - The transaction to add priority fees to.
 * @param {number} [priorityFeeMicrolamports=100000] - Priority fee in microlamports.
 * @param {number} [computeUnitLimit=200000] - Compute unit limit.
 * @returns {web3.Transaction} The transaction with priority fee instructions added.
 */
function addPriorityFeeInstructions(transaction, priorityFeeMicrolamports = 100000, computeUnitLimit = 200000) {
    console.log(`[TransactionUtils] Adding priority fee: ${priorityFeeMicrolamports} microlamports, CU limit: ${computeUnitLimit}`);
    
    // Add compute unit limit instruction
    const computeUnitLimitInstruction = web3.ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnitLimit
    });
    
    // Add compute unit price instruction (priority fee)
    const computeUnitPriceInstruction = web3.ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicrolamports
    });
    
    // Add instructions at the beginning of the transaction
    transaction.instructions.unshift(computeUnitPriceInstruction, computeUnitLimitInstruction);
    
    return transaction;
}

/**
 * SIMPLIFIED confirmation strategy that works with the proper confirmTransaction API
 * Based on official Solana documentation and working implementations
 * @param {web3.Connection} connection - Solana connection object
 * @param {string} signature - Transaction signature
 * @param {string} blockhash - Recent blockhash used in transaction
 * @param {number} lastValidBlockHeight - Last valid block height
 * @param {web3.Commitment} commitment - Commitment level
 * @returns {Promise<object>} Confirmation result
 */
async function confirmTransactionProperly(connection, signature, blockhash, lastValidBlockHeight, commitment = 'confirmed') {
    console.log(`[TransactionUtils] Starting PROPER confirmation strategy for signature: ${signature.slice(0, 8)}...`);
    
    try {
        // Use the official confirmTransaction method with the proper signature
        // This is the CORRECT way according to Solana documentation
        const confirmation = await connection.confirmTransaction({
            signature: signature,
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight
        }, commitment);
        
        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        
        console.log(`[TransactionUtils] ✅ Transaction confirmed successfully!`);
        return confirmation;
        
    } catch (error) {
        console.error(`[TransactionUtils] ❌ Confirmation failed: ${error.message}`);
        throw error;
    }
}

/**
 * Calculates accurate transaction fee including priority fees
 * @param {number} priorityFeeMicrolamports - Priority fee in microlamports
 * @param {number} computeUnitLimit - Compute unit limit
 * @returns {number} Estimated total fee in lamports
 */
function calculateTransactionFee(priorityFeeMicrolamports = 100000, computeUnitLimit = 200000) {
    const baseFee = 5000; // Base transaction fee in lamports
    const priorityFeeInLamports = Math.ceil((priorityFeeMicrolamports * computeUnitLimit) / 1000000);
    const totalFee = baseFee + priorityFeeInLamports;
    
    console.log(`[TransactionUtils] Fee calculation: Base=${baseFee}, Priority=${priorityFeeInLamports}, Total=${totalFee} lamports`);
    return totalFee;
}

/**
 * Enhanced transaction sender with PROPER confirmation to avoid block height exceeded
 * Uses the correct confirmTransaction pattern with proper blockhash handling
 * @param {web3.Connection} connection - Solana connection object.
 * @param {web3.Transaction} transaction - The transaction to send.
 * @param {web3.Signer[]} signers - Array of signers for the transaction.
 * @param {object} [options] - Optional parameters.
 * @param {boolean} [options.skipPreflight=false] - Whether to skip preflight simulation.
 * @param {number} [options.maxRetries=3] - Maximum retries for sending/confirming.
 * @param {web3.Commitment} [options.commitment='confirmed'] - Desired commitment level.
 * @param {number} [options.priorityFeeMicrolamports=100000] - Priority fee in microlamports.
 * @param {number} [options.computeUnitLimit=200000] - Compute unit limit.
 * @returns {Promise<string>} The transaction signature.
 */
async function sendAndConfirmTransactionWrapper(connection, transaction, signers, options = {}) {
    const {
        skipPreflight = false,
        maxRetries = 3,
        commitment = 'confirmed',
        priorityFeeMicrolamports = 100000,
        computeUnitLimit = 200000
    } = options;

    console.log(`[TransactionUtils] Starting PROPER transaction strategy with ${maxRetries} max retries`);
    console.log(`[TransactionUtils] Configuration: skipPreflight=${skipPreflight}, commitment=${commitment}`);

    // Add priority fee instructions
    addPriorityFeeInstructions(transaction, priorityFeeMicrolamports, computeUnitLimit);

    let retries = 0;
    let signature = null;

    while (retries < maxRetries) {
        try {
            console.log(`[TransactionUtils] Attempt ${retries + 1}/${maxRetries}: Preparing transaction...`);
            
            // Get FRESH blockhash for each attempt - CRITICAL
            const latestBlockhash = await connection.getLatestBlockhash(commitment);
            transaction.recentBlockhash = latestBlockhash.blockhash;
            transaction.feePayer = signers[0].publicKey;

            console.log(`[TransactionUtils] Fresh blockhash: ${latestBlockhash.blockhash.slice(0, 8)}... Valid until: ${latestBlockhash.lastValidBlockHeight}`);

            // Sign transaction
            transaction.sign(...signers);
            
            // Send transaction immediately
            const rawTransaction = transaction.serialize();
            console.log(`[TransactionUtils] Sending transaction (${rawTransaction.length} bytes)...`);
            
            // Send with minimal settings for speed
            signature = await connection.sendRawTransaction(rawTransaction, {
                skipPreflight: skipPreflight,
                preflightCommitment: commitment,
                maxRetries: 0 // Disable built-in retries for speed
            });

            console.log(`[TransactionUtils] Transaction sent: ${signature}`);
            console.log(`[TransactionUtils] Solscan: https://solscan.io/tx/${signature}?cluster=mainnet-beta`);

            // PROPER confirmation using the official confirmTransaction API
            await confirmTransactionProperly(
                connection, 
                signature, 
                latestBlockhash.blockhash, 
                latestBlockhash.lastValidBlockHeight, 
                commitment
            );

            console.log(`[TransactionUtils] ✅ Transaction SUCCESS: ${signature}`);
            return signature;

        } catch (error) {
            console.warn(`[TransactionUtils] ❌ Attempt ${retries + 1} failed: ${error.message}`);
            retries++;
            signature = null;
            
            // Handle specific error types
            if (error.message.includes('insufficient funds')) {
                console.error(`[TransactionUtils] 💰 Insufficient funds - stopping retries`);
                throw error;
            }
            
            if (error.message.includes('block height exceeded')) {
                console.error(`[TransactionUtils] ⏰ Block height exceeded - will retry with fresh blockhash`);
                // Don't throw immediately - retry with fresh blockhash
            }
            
            if (retries >= maxRetries) {
                console.error(`[TransactionUtils] 🚫 All retries exhausted`);
                throw new Error(`Transaction failed after ${maxRetries} attempts: ${error.message}`);
            }

            // Quick retry for block height issues, longer for others
            let backoffTime;
            if (error.message.includes('block height exceeded')) {
                backoffTime = 500; // Very quick retry with fresh blockhash
            } else if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                backoffTime = 2000; // Moderate delay for rate limiting
            } else {
                backoffTime = 1000; // Standard delay for other errors
            }
            
            console.log(`[TransactionUtils] ⏳ Retrying in ${backoffTime}ms...`);
            await sleep(backoffTime);
        }
    }
    
    throw new Error('Transaction failed after all retries');
}

/**
 * Creates a basic SOL transfer transaction.
 * @param {web3.PublicKey} fromPubkey - Sender's public key.
 * @param {web3.PublicKey} toPubkey - Receiver's public key.
 * @param {number} lamports - Amount to transfer in lamports.
 * @returns {web3.Transaction} The transaction with transfer instruction.
 */
function createSolTransferTransaction(fromPubkey, toPubkey, lamports) {
    console.log(`[TransactionUtils] Creating SOL transfer: ${lamports} lamports from ${fromPubkey.toBase58().slice(0, 8)}... to ${toPubkey.toBase58().slice(0, 8)}...`);
    
    const transaction = new web3.Transaction();
    
    const transferInstruction = web3.SystemProgram.transfer({
        fromPubkey: fromPubkey,
        toPubkey: toPubkey,
        lamports: lamports
    });
    
    transaction.add(transferInstruction);
    return transaction;
}

/**
 * Converts SOL amount to lamports.
 * @param {number} solAmount - Amount in SOL.
 * @returns {number} Amount in lamports.
 */
function solToLamports(solAmount) {
    return Math.floor(solAmount * web3.LAMPORTS_PER_SOL);
}

/**
 * Converts lamports to SOL.
 * @param {number} lamports - Amount in lamports.
 * @returns {number} Amount in SOL.
 */
function lamportsToSol(lamports) {
    return lamports / web3.LAMPORTS_PER_SOL;
}

/**
 * Estimates the transaction fee for a given transaction.
 * @param {web3.Connection} connection - Solana connection object.
 * @param {web3.Transaction} transaction - The transaction to estimate fees for.
 * @param {web3.Signer[]} signers - Array of signers for the transaction.
 * @returns {Promise<number>} Estimated fee in lamports.
 */
async function estimateTransactionFee(connection, transaction, signers) {
    try {
        console.log(`[TransactionUtils] Estimating transaction fee...`);
        
        // Get recent blockhash
        const { blockhash } = await getRecentBlockhash(connection);
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = signers[0].publicKey;
        
        // Get fee for transaction with rate limiting
        const fee = await rateLimitedRpcCall(async () => {
            return await connection.getFeeForMessage(transaction.compileMessage());
        });
        
        const estimatedFee = fee.value || 5000; // Default fallback fee
        
        console.log(`[TransactionUtils] Estimated fee: ${estimatedFee} lamports (${lamportsToSol(estimatedFee)} SOL)`);
        return estimatedFee;
    } catch (error) {
        console.warn(`[TransactionUtils] Error estimating transaction fee: ${error.message}`);
        return 5000; // Default fallback fee
    }
}

/**
 * Gets dynamic priority fee recommendations
 * @param {web3.Connection} connection - Solana connection object
 * @param {web3.PublicKey[]} [accounts] - Accounts involved in the transaction
 * @returns {Promise<number>} Recommended priority fee in microlamports
 */
async function getDynamicPriorityFee(connection, accounts = []) {
    try {
        console.log(`[TransactionUtils] Getting dynamic priority fee...`);
        
        // Try to get recent prioritization fees
        if (connection.getRecentPrioritizationFees) {
            const recentFees = await connection.getRecentPrioritizationFees({
                lockedWritableAccounts: accounts.slice(0, 5)
            });
            
            if (recentFees && recentFees.length > 0) {
                // Use 90th percentile for higher success rate
                const sortedFees = recentFees
                    .map(fee => fee.prioritizationFee)
                    .sort((a, b) => a - b);
                
                const percentile90Index = Math.floor(sortedFees.length * 0.9);
                const recommendedFee = Math.max(sortedFees[percentile90Index] || 100000, 50000);
                
                console.log(`[TransactionUtils] Dynamic priority fee (90th percentile): ${recommendedFee} microlamports`);
                return recommendedFee;
            }
        }
        
        console.log(`[TransactionUtils] Using fallback priority fee: 100000 microlamports`);
        return 100000;
    } catch (error) {
        console.warn(`[TransactionUtils] Error getting dynamic priority fee: ${error.message}`);
        return 100000;
    }
}

module.exports = {
    addPriorityFeeInstructions,
    sendAndConfirmTransactionWrapper,
    createSolTransferTransaction,
    solToLamports,
    lamportsToSol,
    estimateTransactionFee,
    getDynamicPriorityFee,
    getRecentBlockhash,
    calculateTransactionFee,
    confirmTransactionProperly,
    sleep
}; 