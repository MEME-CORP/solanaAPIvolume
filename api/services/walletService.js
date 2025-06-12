const { Keypair, Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const path = require('path');
const fs = require('fs');
const { connection, retry, delay } = require('../utils/solanaUtils');
const { 
  sendAndConfirmTransactionWrapper, 
  createSolTransferTransaction, 
  getDynamicPriorityFee,
  calculateTransactionFee,
  solToLamports,
  lamportsToSol
} = require('../utils/transactionUtils');
const web3 = require('@solana/web3.js');

// Define the Solana mainnet RPC endpoint
const MAINNET_URL = 'https://api.mainnet-beta.solana.com';

/**
 * Creates a new mother wallet or imports one from a base58 encoded private key.
 * @param {string} [privateKeyBase58] - Optional base58 encoded private key to import.
 * @returns {Promise<{publicKey: string, privateKeyBase58: string}>} An object containing the public key and base58 encoded private key.
 * @throws {Error} If private key decoding or keypair creation fails.
 */
async function createOrImportMotherWalletService(privateKeyBase58) {
  let keypair;

  if (privateKeyBase58) {
    try {
      const secretKeyBytes = bs58.decode(privateKeyBase58);
      if (secretKeyBytes.length !== 64 && secretKeyBytes.length !== 32) { // 32 for seed, 64 for full secret key
        // For simplicity, we'll assume bs58 encoded secret keys are typically full 64 bytes.
        // Keypair.fromSecretKey expects 64 bytes. If it's a 32-byte seed, it needs different handling
        // which is not typical for direct bs58 encoded private keys.
        // Let's stick to Keypair.fromSecretKey which expects 64 bytes.
        // If you intend to support 32-byte seeds that are bs58 encoded, this logic needs adjustment.
        // For now, we'll assume the input bs58 string decodes to a 64-byte secret key.
        console.warn(`Decoded secret key length is ${secretKeyBytes.length}. Expected 64 bytes for Keypair.fromSecretKey.`);
        // If Keypair.fromSecretKey handles various lengths gracefully, this warning might be for info only.
        // Test with actual key formats intended for use.
      }
      keypair = Keypair.fromSecretKey(secretKeyBytes);
      console.log('Mother wallet imported successfully.');
    } catch (error) {
      console.error('Failed to import mother wallet from private key:', error);
      throw new Error('Invalid private key provided or failed to derive keypair.');
    }
  } else {
    keypair = Keypair.generate();
    console.log('New mother wallet generated successfully.');
  }

  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKeyBase58: bs58.encode(keypair.secretKey),
  };
}

/**
 * Retrieves information about a wallet, including its SOL balance.
 * @param {string} publicKeyStr - The wallet's public key in base58 encoding.
 * @returns {Promise<{publicKey: string, balanceSol: number, balanceLamports: number}>} The wallet's information.
 * @throws {Error} If there's an error retrieving the balance or the public key is invalid.
 */
async function getWalletInfo(publicKeyStr) {
  try {
    // Convert the public key string to a PublicKey object
    const publicKey = new PublicKey(publicKeyStr);
    
    // Get the wallet's SOL balance in lamports
    const balanceLamports = await connection.getBalance(publicKey);
    
    // Convert lamports to SOL (1 SOL = 1,000,000,000 lamports)
    const balanceSol = balanceLamports / 1_000_000_000;
    
    return {
      publicKey: publicKeyStr,
      balanceSol,
      balanceLamports,
    };
  } catch (error) {
    console.error('Error retrieving wallet info:', error);
    throw new Error(`Unable to get wallet info: ${error.message}`);
  }
}

/**
 * Derives child wallets from a mother wallet public key.
 * Note: In this implementation, we're creating new random wallets rather than using
 * hierarchical deterministic derivation, which aligns with the original script's approach.
 * 
 * @param {string} motherWalletPublicKey - The public key of the mother wallet.
 * @param {number} count - The number of child wallets to derive (default: 3).
 * @param {boolean} [saveToFile=false] - Whether to save the wallets to a file.
 * @returns {Promise<{motherWalletPublicKey: string, childWallets: Array<{publicKey: string, privateKeyBase58: string}>}>}
 * @throws {Error} If there's an error generating the child wallets.
 */
async function deriveChildWallets(motherWalletPublicKey, count = 3, saveToFile = false) {
  try {
    console.log(`Generating ${count} child wallets for mother wallet: ${motherWalletPublicKey}`);
    
    // Validate mother wallet public key
    new PublicKey(motherWalletPublicKey); // This will throw if invalid
    
    // Generate child wallets
    const childWallets = [];
    
    for (let i = 0; i < count; i++) {
      const keypair = Keypair.generate();
      childWallets.push({
        publicKey: keypair.publicKey.toBase58(),
        privateKeyBase58: bs58.encode(keypair.secretKey)
      });
    }
    
    // If saveToFile is true, save the wallets to the mainnet wallet storage directory
    if (saveToFile) {
      const mainnetWalletPath = path.join(process.cwd(), 'wallet-storage', 'mainnet');
      if (!fs.existsSync(mainnetWalletPath)) {
        fs.mkdirSync(mainnetWalletPath, { recursive: true });
      }
      
      const childWalletsPath = path.join(mainnetWalletPath, 'child-wallets.json');
      fs.writeFileSync(
        childWalletsPath,
        JSON.stringify(childWallets.map(wallet => {
          return {
            publicKey: wallet.publicKey,
            secretKey: Array.from(bs58.decode(wallet.privateKeyBase58))
          };
        }), null, 2),
        'utf-8'
      );
      console.log(`Child wallets saved to: ${childWalletsPath}`);
    }
    
    return {
      motherWalletPublicKey,
      childWallets
    };
  } catch (error) {
    console.error('Error deriving child wallets:', error);
    throw new Error(`Failed to derive child wallets: ${error.message}`);
  }
}

/**
 * Funds multiple child wallets from a mother wallet using IMMEDIATE confirmation strategy.
 * @param {string} motherWalletPrivateKeyBase58 - The mother wallet's private key in base58 encoding.
 * @param {Array<{publicKey: string, amountSol: number}>} childWallets - Array of child wallets to fund.
 * @returns {Promise<{status: string, results: Array, motherWalletFinalBalanceSol: number}>}
 * @throws {Error} If there's an error funding the wallets.
 */
async function fundChildWallets(motherWalletPrivateKeyBase58, childWallets) {
  try {
    console.log(`[WalletService] Starting IMMEDIATE funding for ${childWallets.length} child wallets`);
    
    // Decode mother wallet private key
    const motherSecretKey = bs58.decode(motherWalletPrivateKeyBase58);
    const motherWallet = Keypair.fromSecretKey(motherSecretKey);
    const motherPublicKey = motherWallet.publicKey.toBase58();
    
    console.log(`[WalletService] Mother wallet public key: ${motherPublicKey}`);
    
    // Check mother wallet balance
    const motherBalance = await retry(async () => await connection.getBalance(motherWallet.publicKey));
    const motherBalanceInSol = lamportsToSol(motherBalance);
    console.log(`[WalletService] Mother wallet balance: ${motherBalanceInSol} SOL`);
    
    // Get dynamic priority fee for accurate fee calculation
    const dynamicPriorityFee = await getDynamicPriorityFee(connection, [motherWallet.publicKey]);
    console.log(`[WalletService] Using dynamic priority fee: ${dynamicPriorityFee} microlamports`);
    
    // Calculate accurate fees per transaction
    const feePerTransaction = calculateTransactionFee(dynamicPriorityFee, 200000);
    console.log(`[WalletService] Estimated fee per transaction: ${lamportsToSol(feePerTransaction)} SOL`);
    
    // Calculate total amount needed with accurate fees
    const totalAmountSol = childWallets.reduce((sum, wallet) => sum + wallet.amountSol, 0);
    const totalAmountLamports = solToLamports(totalAmountSol);
    const totalFeesLamports = childWallets.length * feePerTransaction;
    const totalNeededLamports = totalAmountLamports + totalFeesLamports;
    
    console.log(`[WalletService] Total amount to distribute: ${totalAmountSol} SOL`);
    console.log(`[WalletService] Total estimated fees: ${lamportsToSol(totalFeesLamports)} SOL`);
    console.log(`[WalletService] Total needed: ${lamportsToSol(totalNeededLamports)} SOL`);
    
    // Check if we have sufficient funds with a safety buffer
    const safetyBufferLamports = 2000000; // 0.002 SOL safety buffer
    if (motherBalance < totalNeededLamports + safetyBufferLamports) {
      // Calculate how many transactions we can actually afford
      const availableForTransactions = motherBalance - safetyBufferLamports;
      const maxAffordableTransactions = Math.floor(availableForTransactions / (solToLamports(childWallets[0].amountSol) + feePerTransaction));
      
      if (maxAffordableTransactions <= 0) {
        throw new Error(`Insufficient funds in mother wallet. Required: ${lamportsToSol(totalNeededLamports)} SOL, Available: ${motherBalanceInSol} SOL, Safety buffer: ${lamportsToSol(safetyBufferLamports)} SOL`);
      }
      
      console.warn(`[WalletService] ⚠️ Only enough funds for ${maxAffordableTransactions} out of ${childWallets.length} transactions`);
      console.warn(`[WalletService] Will process first ${maxAffordableTransactions} wallets`);
      
      // Trim the array to what we can afford
      childWallets = childWallets.slice(0, maxAffordableTransactions);
    }
    
    const results = [];
    let successfulTransactions = 0;
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = 3;
    
    for (let i = 0; i < childWallets.length; i++) {
      const { publicKey, amountSol } = childWallets[i];
      console.log(`[WalletService] Funding wallet ${i + 1}/${childWallets.length}: ${publicKey} with ${amountSol} SOL`);
      
      // Check remaining balance before each transaction
      const currentBalance = await retry(async () => await connection.getBalance(motherWallet.publicKey));
      const remainingTransactions = childWallets.length - i;
      const neededForRemaining = remainingTransactions * (solToLamports(amountSol) + feePerTransaction);
      
      if (currentBalance < neededForRemaining) {
        console.warn(`[WalletService] ⚠️ Insufficient funds for remaining transactions. Stopping at transaction ${i + 1}`);
        console.warn(`[WalletService] Current balance: ${lamportsToSol(currentBalance)} SOL, Needed: ${lamportsToSol(neededForRemaining)} SOL`);
        break;
      }
      
      try {
        // Convert SOL to lamports
        const amountLamports = solToLamports(amountSol);
        
        // Create and validate child wallet public key
        const childPublicKey = new PublicKey(publicKey);
        
        // Get current balance
        const childCurrentBalance = await retry(async () => await connection.getBalance(childPublicKey));
        console.log(`[WalletService] Current child balance: ${lamportsToSol(childCurrentBalance)} SOL`);
        
        // Create transfer transaction using robust utilities
        const transaction = createSolTransferTransaction(
          motherWallet.publicKey,
          childPublicKey,
          amountLamports
        );
        
        // MINIMAL delay between transactions - only if needed for rate limiting
        if (i > 0 && consecutiveFailures === 0) {
          const minimalDelay = 500; // Reduced from 2000ms+ to 500ms
          console.log(`[WalletService] Brief ${minimalDelay}ms delay for rate limiting...`);
          await delay(minimalDelay);
        }
        
        // Send transaction using IMMEDIATE confirmation strategy
        console.log(`[WalletService] Sending transaction with IMMEDIATE confirmation...`);
        const signature = await sendAndConfirmTransactionWrapper(
          connection,
          transaction,
          [motherWallet],
          {
            skipPreflight: false,
            maxRetries: 3,
            commitment: 'confirmed',
            priorityFeeMicrolamports: dynamicPriorityFee,
            computeUnitLimit: 200000
          }
        );
        
        console.log(`[WalletService] ✅ Funding SUCCESS!`);
        
        // Get updated balance
        const newBalance = await retry(async () => await connection.getBalance(childPublicKey));
        console.log(`[WalletService] New child balance: ${lamportsToSol(newBalance)} SOL`);
        
        results.push({
          childPublicKey: publicKey,
          transactionId: signature,
          status: 'funded',
          error: null,
          newBalanceSol: lamportsToSol(newBalance)
        });
        
        successfulTransactions++;
        consecutiveFailures = 0; // Reset consecutive failures on success
        
      } catch (error) {
        console.error(`[WalletService] ❌ Error funding wallet ${publicKey}:`, error);
        consecutiveFailures++;
        
        results.push({
          childPublicKey: publicKey,
          transactionId: null,
          status: 'failed',
          error: error.message || 'Unknown error'
        });
        
        // Stop if too many consecutive failures (might indicate persistent network issues)
        if (consecutiveFailures >= maxConsecutiveFailures) {
          console.error(`[WalletService] 🛑 Too many consecutive failures (${consecutiveFailures}). Stopping funding process.`);
          break;
        }
        
        // Minimal delay after failures - don't wait too long
        if (consecutiveFailures > 1) {
          const errorDelayTime = 1000 * consecutiveFailures; // Reduced from 5000ms
          console.log(`[WalletService] Adding ${errorDelayTime}ms delay after consecutive failures...`);
          await delay(errorDelayTime);
        }
      }
    }
    
    // Determine overall status
    const totalAttempted = results.length;
    const successRate = successfulTransactions / totalAttempted;
    let overallStatus;
    
    if (successRate >= 0.8) {
      overallStatus = 'success';
    } else if (successRate >= 0.5) {
      overallStatus = 'partial';
    } else {
      overallStatus = 'failed';
    }
    
    // Get final mother wallet balance
    const finalBalance = await retry(async () => await connection.getBalance(motherWallet.publicKey));
    console.log(`[WalletService] Final mother wallet balance: ${lamportsToSol(finalBalance)} SOL`);
    console.log(`[WalletService] 📊 Success rate: ${successfulTransactions}/${totalAttempted} (${(successRate * 100).toFixed(1)}%)`);
    
    return {
      status: overallStatus,
      results: results,
      motherWalletFinalBalanceSol: lamportsToSol(finalBalance),
      statistics: {
        attempted: totalAttempted,
        successful: successfulTransactions,
        failed: totalAttempted - successfulTransactions,
        successRate: Math.round(successRate * 100)
      }
    };
  } catch (error) {
    console.error('[WalletService] Error funding child wallets:', error);
    throw new Error(`Failed to fund child wallets: ${error.message}`);
  }
}

/**
 * Returns funds from a child wallet to a mother wallet using IMMEDIATE confirmation strategy.
 * @param {string} childWalletPrivateKeyBase58 - The child wallet's private key in base58 encoding.
 * @param {string} motherWalletPublicKey - The mother wallet's public key in base58 encoding.
 * @param {boolean} returnAllFunds - Whether to return all funds or keep some for transaction fees.
 * @returns {Promise<{status: string, transactionId: string, amountReturnedSol: number, newChildBalanceSol: number}>}
 * @throws {Error} If there's an error returning funds.
 */
async function returnFundsToMotherWallet(childWalletPrivateKeyBase58, motherWalletPublicKey, returnAllFunds = false) {
  try {
    console.log(`[WalletService] Returning funds to mother wallet: ${motherWalletPublicKey}`);
    
    // Decode child wallet private key
    const childSecretKey = bs58.decode(childWalletPrivateKeyBase58);
    const childWallet = Keypair.fromSecretKey(childSecretKey);
    const childPublicKey = childWallet.publicKey.toBase58();
    
    console.log(`[WalletService] Child wallet public key: ${childPublicKey}`);
    
    // Validate mother wallet public key
    const motherPublicKey = new PublicKey(motherWalletPublicKey);
    
    // Check child wallet balance
    const childBalance = await retry(async () => await connection.getBalance(childWallet.publicKey));
    const childBalanceInSol = lamportsToSol(childBalance);
    console.log(`[WalletService] Child wallet balance: ${childBalanceInSol} SOL`);
    
    // Get dynamic priority fee
    const dynamicPriorityFee = await getDynamicPriorityFee(connection, [childWallet.publicKey, motherPublicKey]);
    
    // Calculate transaction fees more accurately using the new utility
    const totalTransactionFee = calculateTransactionFee(dynamicPriorityFee, 200000);
    
    console.log(`[WalletService] Estimated total transaction fee: ${lamportsToSol(totalTransactionFee)} SOL`);
    
    if (childBalance <= totalTransactionFee) {
      throw new Error(`Insufficient funds in child wallet. Balance (${childBalanceInSol} SOL) is too low to cover transaction fees (${lamportsToSol(totalTransactionFee)} SOL).`);
    }
    
    // Calculate amount to return, leaving some for transaction fees if returnAllFunds is false
    let amountToReturn;
    if (returnAllFunds) {
      // Return all but leave just enough for the total transaction fee
      amountToReturn = childBalance - totalTransactionFee;
    } else {
      // Return all but leave a small amount for potential future transactions (0.001 SOL)
      const bufferAmount = 1000000; // 0.001 SOL in lamports
      amountToReturn = childBalance - bufferAmount - totalTransactionFee;
      
      // If the buffer would leave too little, just return all minus the total transaction fee
      if (amountToReturn <= 0) {
        amountToReturn = childBalance - totalTransactionFee;
      }
    }
    
    console.log(`[WalletService] Returning ${lamportsToSol(amountToReturn)} SOL to mother wallet`);
    
    // Create transfer transaction using robust utilities
    const transaction = createSolTransferTransaction(
      childWallet.publicKey,
      motherPublicKey,
      amountToReturn
    );
    
    // Send transaction using IMMEDIATE confirmation strategy
    console.log(`[WalletService] Sending return transaction with IMMEDIATE confirmation...`);
    const signature = await sendAndConfirmTransactionWrapper(
      connection,
      transaction,
      [childWallet],
      {
        skipPreflight: false,
        maxRetries: 3,
        commitment: 'confirmed',
        priorityFeeMicrolamports: dynamicPriorityFee,
        computeUnitLimit: 200000
      }
    );
    
    console.log(`[WalletService] ✅ Return funds SUCCESS!`);
    
    // Get updated balances
    const newChildBalance = await retry(async () => await connection.getBalance(childWallet.publicKey));
    const newMotherBalance = await retry(async () => await connection.getBalance(motherPublicKey));
    
    console.log(`[WalletService] New child wallet balance: ${lamportsToSol(newChildBalance)} SOL`);
    console.log(`[WalletService] New mother wallet balance: ${lamportsToSol(newMotherBalance)} SOL`);
    
    return {
      status: 'success',
      transactionId: signature,
      amountReturnedSol: lamportsToSol(amountToReturn),
      newChildBalanceSol: lamportsToSol(newChildBalance),
      message: 'Funds returned to mother wallet successfully'
    };
  } catch (error) {
    console.error('[WalletService] Error returning funds to mother wallet:', error);
    throw new Error(`Failed to return funds: ${error.message}`);
  }
}

/**
 * Gets SPL token balance for a wallet
 * @param {string} walletPublicKey - The wallet's public key
 * @param {string} mintAddress - The token mint address
 * @returns {Promise<{publicKey: string, mintAddress: string, balance: number, decimals: number}>}
 */
async function getTokenBalance(walletPublicKey, mintAddress) {
    try {
        // Validate inputs
        if (!walletPublicKey || !mintAddress) {
            throw new Error('Missing required parameters: walletPublicKey and mintAddress');
        }

        // Validate public key format
        try {
            new web3.PublicKey(walletPublicKey);
        } catch (error) {
            throw new Error('Invalid wallet public key format');
        }

        // Validate mint address format
        try {
            new web3.PublicKey(mintAddress);
        } catch (error) {
            throw new Error('Invalid token mint address format');
        }

        const { balance, decimals } = await solanaUtils.getTokenBalance(walletPublicKey, mintAddress);

        return {
            publicKey: walletPublicKey,
            mintAddress: mintAddress,
            balance: balance,
            decimals: decimals
        };
    } catch (error) {
        console.error('[WalletService] Error getting token balance:', error.message);
        throw error;
    }
}

module.exports = {
  createOrImportMotherWalletService,
  getWalletInfo,
  deriveChildWallets,
  fundChildWallets,
  returnFundsToMotherWallet,
  getTokenBalance
}; 