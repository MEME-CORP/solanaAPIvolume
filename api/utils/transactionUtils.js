const web3 = require('@solana/web3.js');
const { connection, delay } = require('./solanaUtils');

/**
 * Gets recent blockhash with proper commitment level
 * @param {web3.Connection} connection - Solana connection object
 * @param {web3.Commitment} [commitment='confirmed'] - Commitment level
 * @returns {Promise<{blockhash: string, lastValidBlockHeight: number}>}
 */
async function getRecentBlockhash(connection, commitment = 'confirmed') {
    console.log(`[TransactionUtils] Fetching recent blockhash with commitment: ${commitment}`);
    const result = await connection.getLatestBlockhash(commitment);
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
 * @param {number} [priorityFeeMicrolamports=50000] - Priority fee in microlamports (increased from 10000).
 * @param {number} [computeUnitLimit=200000] - Compute unit limit.
 * @returns {web3.Transaction} The transaction with priority fee instructions added.
 */
function addPriorityFeeInstructions(transaction, priorityFeeMicrolamports = 50000, computeUnitLimit = 200000) {
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
 * Sends and confirms a transaction with robust retry logic and priority fees.
 * Uses the more reliable sendRawTransaction + confirmTransaction pattern to avoid blockhash expiration issues.
 * @param {web3.Connection} connection - Solana connection object.
 * @param {web3.Transaction} transaction - The transaction to send.
 * @param {web3.Signer[]} signers - Array of signers for the transaction.
 * @param {object} [options] - Optional parameters.
 * @param {boolean} [options.skipPreflight=true] - Whether to skip preflight simulation.
 * @param {number} [options.maxRetries=5] - Maximum retries for sending/confirming.
 * @param {web3.Commitment} [options.commitment='confirmed'] - Desired commitment level.
 * @param {number} [options.priorityFeeMicrolamports=50000] - Priority fee in microlamports.
 * @param {number} [options.computeUnitLimit=200000] - Compute unit limit.
 * @returns {Promise<string>} The transaction signature.
 */
async function sendAndConfirmTransactionWrapper(connection, transaction, signers, options = {}) {
    const {
        skipPreflight = true,
        maxRetries = 5,
        commitment = 'confirmed',
        priorityFeeMicrolamports = 50000,
        computeUnitLimit = 200000
    } = options;

    console.log(`[TransactionUtils] Starting transaction with ${maxRetries} max retries`);
    console.log(`[TransactionUtils] Configuration: skipPreflight=${skipPreflight}, commitment=${commitment}`);

    // Add priority fee instructions
    addPriorityFeeInstructions(transaction, priorityFeeMicrolamports, computeUnitLimit);

    let retries = 0;
    let signature = null;

    while (retries < maxRetries) {
        try {
            console.log(`[TransactionUtils] Attempt ${retries + 1}/${maxRetries}: Preparing transaction...`);
            
            // Get fresh blockhash for each attempt - CRITICAL for avoiding expiration
            const latestBlockhash = await getRecentBlockhash(connection, commitment);
            transaction.recentBlockhash = latestBlockhash.blockhash;
            transaction.feePayer = signers[0].publicKey;

            console.log(`[TransactionUtils] Using fresh blockhash: ${latestBlockhash.blockhash.slice(0, 8)}...`);
            console.log(`[TransactionUtils] Last valid block height: ${latestBlockhash.lastValidBlockHeight}`);

            // Sign the transaction
            transaction.sign(...signers);
            
            // Serialize the transaction
            const rawTransaction = transaction.serialize();
            
            console.log(`[TransactionUtils] Sending transaction (size: ${rawTransaction.length} bytes)...`);
            
            // Send the transaction using sendRawTransaction for better control
            signature = await connection.sendRawTransaction(rawTransaction, {
                skipPreflight: skipPreflight,
                preflightCommitment: commitment
            });

            console.log(`[TransactionUtils] Transaction sent with signature: ${signature}`);
            console.log(`[TransactionUtils] Solscan: https://solscan.io/tx/${signature}?cluster=mainnet-beta`);
            console.log(`[TransactionUtils] Confirming transaction...`);

            // Confirm the transaction using the blockhash info - CRITICAL for proper confirmation
            const confirmation = await connection.confirmTransaction({
                signature: signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, commitment);

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            console.log(`[TransactionUtils] ✅ Transaction confirmed with signature: ${signature}`);
            return signature;

        } catch (error) {
            console.warn(`[TransactionUtils] ❌ Attempt ${retries + 1} failed: ${error.message}`);
            retries++;
            
            // Clear signature for retry
            signature = null;
            
            if (retries >= maxRetries) {
                console.error(`[TransactionUtils] 🚫 Max retries reached. Transaction failed.`);
                throw new Error(`Transaction failed after ${maxRetries} attempts: ${error.message}`);
            }

            // Wait before retrying with exponential backoff
            const delay = 1000 * Math.pow(2, retries);
            console.log(`[TransactionUtils] ⏳ Waiting ${delay}ms before retry...`);
            await sleep(delay);
        }
    }
    
    throw new Error('Failed to send and confirm transaction after multiple retries.');
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
        
        // Get fee for transaction
        const fee = await connection.getFeeForMessage(transaction.compileMessage());
        const estimatedFee = fee.value || 5000; // Default fallback fee
        
        console.log(`[TransactionUtils] Estimated fee: ${estimatedFee} lamports (${lamportsToSol(estimatedFee)} SOL)`);
        return estimatedFee;
    } catch (error) {
        console.warn(`[TransactionUtils] Error estimating transaction fee: ${error.message}`);
        return 5000; // Default fallback fee
    }
}

/**
 * Gets dynamic priority fee recommendations based on network conditions
 * @param {web3.Connection} connection - Solana connection object
 * @param {web3.PublicKey[]} [accounts] - Accounts involved in the transaction for more accurate estimates
 * @returns {Promise<number>} Recommended priority fee in microlamports
 */
async function getDynamicPriorityFee(connection, accounts = []) {
    try {
        console.log(`[TransactionUtils] Getting dynamic priority fee recommendations...`);
        
        // Try to get recent prioritization fees (if available)
        if (connection.getRecentPrioritizationFees) {
            const recentFees = await connection.getRecentPrioritizationFees({
                lockedWritableAccounts: accounts.slice(0, 5) // Limit to first 5 accounts
            });
            
            if (recentFees && recentFees.length > 0) {
                // Calculate 75th percentile of recent fees
                const sortedFees = recentFees
                    .map(fee => fee.prioritizationFee)
                    .sort((a, b) => a - b);
                
                const percentile75Index = Math.floor(sortedFees.length * 0.75);
                const recommendedFee = Math.max(sortedFees[percentile75Index] || 50000, 10000);
                
                console.log(`[TransactionUtils] Dynamic priority fee (75th percentile): ${recommendedFee} microlamports`);
                return recommendedFee;
            }
        }
        
        // Fallback to higher default if dynamic fees not available
        console.log(`[TransactionUtils] Using fallback priority fee: 50000 microlamports`);
        return 50000;
    } catch (error) {
        console.warn(`[TransactionUtils] Error getting dynamic priority fee: ${error.message}`);
        return 50000; // Fallback to higher default
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
    sleep
}; 