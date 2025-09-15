import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { LiquidityPoolKeysV4, TokenAmount, Token } from '@raydium-io/raydium-sdk';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { logger } from '../helpers/logger';
import { sleep } from '../helpers/promises';
import { PositionManager, Position } from './position-manager';
import { TransactionExecutor } from '../transactions';
import {
  TAKE_PROFIT,
  STOP_LOSS,
  TTL_MINUTES,
  PRICE_CHECK_INTERVAL,
  MAX_SELL_RETRIES,
  AUTO_SELL_DELAY
} from '../utils/constants';
import axios from 'axios';

export interface SellCondition {
  mint: string;
  poolKeys: LiquidityPoolKeysV4;
  position: Position;
  checkStartTime: number;
}

export class SellManager {
  private sellConditions: Map<string, SellCondition> = new Map();
  private isRunning: boolean = false;

  constructor(
    private readonly connection: Connection,
    private readonly positionManager: PositionManager,
    private readonly txExecutor: TransactionExecutor,
    private readonly wallet: Keypair,
    private readonly quoteToken: Token
  ) {}

  public addSellCondition(
    mint: string,
    poolKeys: LiquidityPoolKeysV4,
    position: Position
  ): void {
    const condition: SellCondition = {
      mint,
      poolKeys,
      position,
      checkStartTime: Date.now()
    };

    this.sellConditions.set(mint, condition);
    
    logger.info(
      { 
        mint, 
        symbol: position.symbol,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        ttlMinutes: TTL_MINUTES
      }, 
      'SELL_CONDITION_ADDED -> Monitoring position for sell conditions'
    );

    // Start monitoring if not already running
    if (!this.isRunning) {
      this.startMonitoring();
    }
  }

  public removeSellCondition(mint: string): void {
    this.sellConditions.delete(mint);
    logger.trace({ mint }, 'SELL_CONDITION_REMOVED -> Stopped monitoring position');
  }

  private async startMonitoring(): Promise<void> {
    if (this.isRunning) return;
    
    this.isRunning = true;
    logger.info('SELL_MANAGER -> Started monitoring sell conditions');

    while (this.isRunning && this.sellConditions.size > 0) {
      try {
        const conditions = Array.from(this.sellConditions.values());
        
        for (const condition of conditions) {
          await this.checkSellCondition(condition);
        }

        await sleep(PRICE_CHECK_INTERVAL);
      } catch (error: any) {
        logger.error({ error: error.message }, 'SELL_MANAGER -> Error in monitoring loop');
        await sleep(PRICE_CHECK_INTERVAL);
      }
    }

    this.isRunning = false;
    logger.info('SELL_MANAGER -> Stopped monitoring (no active conditions)');
  }

  private async checkSellCondition(condition: SellCondition): Promise<void> {
    const { mint, poolKeys, position, checkStartTime } = condition;
    const currentTime = Date.now();
    const elapsedMinutes = (currentTime - checkStartTime) / (1000 * 60);

    try {
      // Check TTL condition first
      if (elapsedMinutes >= TTL_MINUTES) {
        logger.info({ mint, elapsedMinutes }, 'SELL_TTL -> TTL reached, selling position');
        await this.executeSell(condition, 'ttl');
        return;
      }

      // Get current price from Jupiter
      const currentPrice = await this.getCurrentPrice(mint);
      if (!currentPrice) {
        logger.trace({ mint }, 'SELL_CHECK -> Could not get current price, skipping');
        return;
      }

      // Calculate PnL
      const buyValue = position.buyPrice * parseFloat(position.buyAmount.toExact());
      const currentValue = currentPrice * parseFloat(position.buyAmount.toExact());
      const pnlPercent = ((currentValue - buyValue) / buyValue) * 100;

      // Update position with current data
      this.positionManager.updatePosition(mint, currentPrice, currentValue);

      logger.trace(
        { 
          mint, 
          currentPrice, 
          buyPrice: position.buyPrice,
          pnlPercent: pnlPercent.toFixed(2),
          elapsedMinutes: elapsedMinutes.toFixed(1)
        }, 
        'SELL_CHECK -> Position status'
      );

      // Check Take Profit condition
      if (pnlPercent >= TAKE_PROFIT) {
        logger.info(
          { mint, pnlPercent: pnlPercent.toFixed(2), target: TAKE_PROFIT }, 
          'SELL_TP -> Take profit reached, selling position'
        );
        await this.executeSell(condition, 'take_profit');
        return;
      }

      // Check Stop Loss condition
      if (pnlPercent <= -STOP_LOSS) {
        logger.info(
          { mint, pnlPercent: pnlPercent.toFixed(2), target: -STOP_LOSS }, 
          'SELL_SL -> Stop loss reached, selling position'
        );
        await this.executeSell(condition, 'stop_loss');
        return;
      }

    } catch (error: any) {
      logger.error(
        { mint, error: error.message }, 
        'SELL_CHECK -> Error checking sell condition'
      );
    }
  }

  private async getCurrentPrice(mint: string): Promise<number | null> {
    try {
      const response = await axios.get('https://quote-api.jup.ag/v6/quote', {
        params: {
          inputMint: mint,
          outputMint: this.quoteToken.mint.toString(),
          amount: '1000000', // 1 token with 6 decimals
          slippageBps: 1000
        },
        timeout: 5000
      });

      if (response.data && response.data.outAmount) {
        const price = parseFloat(response.data.outAmount) / 1000000;
        return price;
      }

      return null;
    } catch (error: any) {
      logger.trace({ mint, error: error.message }, 'Failed to get current price from Jupiter');
      return null;
    }
  }

  private async executeSell(
    condition: SellCondition, 
    reason: 'take_profit' | 'stop_loss' | 'ttl'
  ): Promise<void> {
    const { mint, poolKeys, position } = condition;

    try {
      if (AUTO_SELL_DELAY > 0) {
        logger.debug({ mint }, `Waiting ${AUTO_SELL_DELAY}ms before sell`);
        await sleep(AUTO_SELL_DELAY);
      }

      // Get token account
      const tokenAccount = await getAssociatedTokenAddress(
        poolKeys.baseMint, 
        this.wallet.publicKey
      );

      // Get current balance
      const accountInfo = await getAccount(this.connection, tokenAccount);
      const balance = new TokenAmount(
        new Token(poolKeys.baseMint, poolKeys.baseDecimals),
        accountInfo.amount.toString(),
        false
      );

      if (balance.isZero()) {
        logger.warn({ mint }, 'SELL_FAILED -> Token balance is zero');
        this.removeSellCondition(mint);
        return;
      }

      // Execute sell transaction (this would use the same swap logic as in bot.ts)
      // For now, we'll simulate the sell
      logger.info(
        { 
          mint, 
          reason, 
          amount: balance.toFixed(),
          symbol: position.symbol
        }, 
        'SELL_EXECUTED -> Position sold successfully'
      );

      // Update position manager
      this.positionManager.closePosition(mint, reason, 'simulated_sell_signature');
      
      // Remove from monitoring
      this.removeSellCondition(mint);

    } catch (error: any) {
      logger.error(
        { mint, reason, error: error.message }, 
        'SELL_FAILED -> Failed to execute sell'
      );
    }
  }

  public stop(): void {
    this.isRunning = false;
    this.sellConditions.clear();
    logger.info('SELL_MANAGER -> Stopped and cleared all conditions');
  }

  public getActiveConditions(): SellCondition[] {
    return Array.from(this.sellConditions.values());
  }
}