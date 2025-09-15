import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, NETWORK, sleep } from './helpers';
import { logger } from './helpers/logger';
import { PositionManager } from './managers/position-manager';
import { SellManager } from './managers/sell-manager';
import { Statistics } from './utils/statistics';
import { AlertManager } from './utils/alerts';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { 
  TEST_MODE, 
  MIN_SOL_BALANCE,
  NETWORK 
} from './utils/constants';

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
}

export class Bot {
  private readonly poolFilters: PoolFilters;
  private readonly positionManager: PositionManager;
  private readonly sellManager: SellManager;
  private readonly statistics: Statistics;
  private readonly alertManager: AlertManager;

  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  // one token at the time
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    
    // Initialize managers
    this.positionManager = new PositionManager();
    this.sellManager = new SellManager(
      connection,
      this.positionManager,
      txExecutor,
      config.wallet,
      config.quoteToken
    );
    this.statistics = new Statistics(this.positionManager);
    this.alertManager = new AlertManager();
    
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    const mint = poolState.baseMint.toString();
    
    logger.trace({ mint }, `DETECTED_POOL -> Processing new pool`);
    this.statistics.incrementDetected();

    // Check if we already have this position
    if (this.positionManager.hasPosition(mint)) {
      logger.debug({ mint }, 'SKIP_DUPLICATE -> Already have position for this token');
      return;
    }

    // Check wallet balance
    const balance = await this.connection.getBalance(this.config.wallet.publicKey);
    const solBalance = balance / 1e9; // Convert lamports to SOL
    
    if (solBalance < MIN_SOL_BALANCE) {
      logger.warn({ mint, balance: solBalance }, 'SKIP_INSUFFICIENT_BALANCE -> Not enough SOL for transaction');
      return;
    }

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(poolState.baseMint.toString())) {
      logger.debug({ mint }, `SKIP_SNIPE_LIST -> Token not in snipe list`);
      return;
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: poolState.baseMint.toString() },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        return;
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);

        if (!match) {
          logger.trace({ mint }, `SKIP_FILTERS -> Pool doesn't match filters`);
          this.statistics.incrementFiltered();
          return;
        }
      }

      logger.info({ mint }, 'BUY_ATTEMPT -> All filters passed, attempting to buy');

      if (TEST_MODE) {
        logger.info({ mint, testMode: true }, 'BUY_TEST -> Test mode: would buy token');
        
        // Simulate position creation in test mode
        const buyPrice = 0.001; // Simulated price
        this.positionManager.addPosition(
          mint,
          'TEST',
          buyPrice,
          this.config.quoteAmount,
          'test_mode_signature'
        );
        
        this.statistics.incrementBought(parseFloat(this.config.quoteAmount.toExact()));
        return;
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.config.quoteAmount,
            this.config.buySlippage,
            this.config.wallet,
            'buy',
          );

          if (result.confirmed) {
            logger.info(
              {
                mint,
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `BUY_SUCCESS -> Confirmed buy transaction`,
            );

            // Add position to manager
            const buyPrice = await this.calculateBuyPrice(poolKeys, this.config.quoteAmount);
            this.positionManager.addPosition(
              mint,
              await this.getTokenSymbol(poolKeys.baseMint),
              buyPrice,
              this.config.quoteAmount,
              result.signature || ''
            );

            // Add to sell manager for monitoring
            const position = this.positionManager.getPosition(mint);
            if (position) {
              this.sellManager.addSellCondition(mint, poolKeys, position);
            }

            // Update statistics
            this.statistics.incrementBought(parseFloat(this.config.quoteAmount.toExact()));

            // Send alert
            await this.alertManager.sendAlert({
              type: 'buy',
              mint,
              amount: this.config.quoteAmount.toFixed(),
              signature: result.signature,
              message: `Successfully bought ${mint.slice(0, 8)}...`
            });

            break;
          }

          logger.info(
            {
              mint,
              signature: result.signature,
              error: result.error,
            },
            `BUY_RETRY -> Error confirming buy transaction`,
          );
        } catch (error) {
          logger.debug({ mint, error }, `BUY_ERROR -> Error in buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint, error }, `BUY_FAILED -> Failed to buy token`);
      
      await this.alertManager.sendAlert({
        type: 'error',
        mint,
        message: `Failed to buy ${mint.slice(0, 8)}...: ${error}`
      });
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  private async calculateBuyPrice(poolKeys: LiquidityPoolKeysV4, quoteAmount: TokenAmount): Promise<number> {
    try {
      // Get current pool info to calculate price
      const poolInfo = await Liquidity.fetchInfo({
        connection: this.connection,
        poolKeys,
      });
      
      // Calculate expected output for price estimation
      const computedAmountOut = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn: quoteAmount,
        currencyOut: new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals),
        slippage: new Percent(this.config.buySlippage, 100),
      });
      
      const price = parseFloat(quoteAmount.toExact()) / parseFloat(computedAmountOut.amountOut.toExact());
      return price;
    } catch (error) {
      logger.error({ error }, 'Failed to calculate buy price');
      return 0.001; // Fallback price
    }
  }

  private async getTokenSymbol(mint: PublicKey): Promise<string> {
    try {
      // Get token metadata to extract symbol
      const metadataPDA = getPdaMetadataKey(mint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey);
      
      if (metadataAccount?.data) {
        const metadataSerializer = getMetadataAccountDataSerializer();
        const metadata = metadataSerializer.deserialize(metadataAccount.data);
        return metadata[0].symbol || 'UNKNOWN';
      }
      
      return 'UNKNOWN';
    } catch (error) {
      return 'UNKNOWN';
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    const mint = rawAccount.mint.toString();
    
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    try {
      logger.trace({ mint }, `WALLET_CHANGE -> Processing token balance change`);

      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (!poolData) {
        logger.trace({ mint }, `SELL_SKIP -> Pool data not found`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint }, `SELL_SKIP -> Empty balance`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      await this.priceMatch(tokenAmountIn, poolKeys);

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
          );

          if (result.confirmed) {
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`,
                mint,
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `SELL_SUCCESS -> Confirmed sell transaction`,
            );
            
            // Update statistics
            this.statistics.incrementSold();
            
            break;
          }

          logger.info(
            {
              mint,
              signature: result.signature,
              error: result.error,
            },
            `SELL_RETRY -> Error confirming sell transaction`,
          );
        } catch (error) {
          logger.debug({ mint, error }, `SELL_ERROR -> Error in sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint, error }, `SELL_FAILED -> Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    // New filter system handles repeat logic internally
    return await this.poolFilters.execute(poolKeys);
  }

  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
    // Price matching is now handled by SellManager
    // This method is kept for backward compatibility but does nothing
    return;
  }

  public stop(): void {
    logger.info('BOT -> Stopping bot and all managers...');
    this.sellManager.stop();
    this.statistics.stop();
    logger.info('BOT -> Bot stopped successfully');
  }
}
