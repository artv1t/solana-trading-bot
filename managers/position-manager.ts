import { PublicKey } from '@solana/web3.js';
import { TokenAmount, Token } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers/logger';

export interface Position {
  mint: string;
  symbol: string;
  buyPrice: number;
  buyAmount: TokenAmount;
  buyTimestamp: number;
  buySignature: string;
  currentPrice?: number;
  currentValue?: number;
  pnl?: number;
  pnlPercent?: number;
  status: 'active' | 'sold' | 'failed';
  sellReason?: 'take_profit' | 'stop_loss' | 'ttl' | 'manual';
  sellSignature?: string;
  sellTimestamp?: number;
}

export class PositionManager {
  private positions: Map<string, Position> = new Map();
  private readonly maxPositions: number = 50;

  public addPosition(
    mint: string,
    symbol: string,
    buyPrice: number,
    buyAmount: TokenAmount,
    buySignature: string
  ): void {
    const position: Position = {
      mint,
      symbol,
      buyPrice,
      buyAmount,
      buyTimestamp: Date.now(),
      buySignature,
      status: 'active'
    };

    this.positions.set(mint, position);
    
    // Clean up old positions if we exceed max
    if (this.positions.size > this.maxPositions) {
      this.cleanupOldPositions();
    }

    logger.info(
      { 
        mint, 
        symbol, 
        buyPrice, 
        amount: buyAmount.toFixed(),
        signature: buySignature 
      }, 
      'POSITION_ADDED -> New position tracked'
    );
  }

  public updatePosition(
    mint: string, 
    currentPrice: number, 
    currentValue: number
  ): Position | null {
    const position = this.positions.get(mint);
    if (!position) return null;

    position.currentPrice = currentPrice;
    position.currentValue = currentValue;
    
    const buyValue = position.buyPrice * parseFloat(position.buyAmount.toExact());
    position.pnl = currentValue - buyValue;
    position.pnlPercent = (position.pnl / buyValue) * 100;

    return position;
  }

  public closePosition(
    mint: string,
    sellReason: 'take_profit' | 'stop_loss' | 'ttl' | 'manual',
    sellSignature?: string
  ): void {
    const position = this.positions.get(mint);
    if (!position) return;

    position.status = 'sold';
    position.sellReason = sellReason;
    position.sellSignature = sellSignature;
    position.sellTimestamp = Date.now();

    logger.info(
      {
        mint,
        symbol: position.symbol,
        sellReason,
        pnl: position.pnl?.toFixed(4),
        pnlPercent: position.pnlPercent?.toFixed(2),
        holdTime: position.sellTimestamp - position.buyTimestamp,
        signature: sellSignature
      },
      'POSITION_CLOSED -> Position closed'
    );
  }

  public getPosition(mint: string): Position | undefined {
    return this.positions.get(mint);
  }

  public getActivePositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'active');
  }

  public getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  public hasPosition(mint: string): boolean {
    return this.positions.has(mint);
  }

  public getPositionCount(): number {
    return this.getActivePositions().length;
  }

  public getStatistics(): {
    total: number;
    active: number;
    sold: number;
    profitable: number;
    totalPnl: number;
    winRate: number;
  } {
    const allPositions = this.getAllPositions();
    const soldPositions = allPositions.filter(p => p.status === 'sold');
    const profitablePositions = soldPositions.filter(p => (p.pnl || 0) > 0);
    const totalPnl = soldPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);

    return {
      total: allPositions.length,
      active: this.getActivePositions().length,
      sold: soldPositions.length,
      profitable: profitablePositions.length,
      totalPnl,
      winRate: soldPositions.length > 0 ? (profitablePositions.length / soldPositions.length) * 100 : 0
    };
  }

  private cleanupOldPositions(): void {
    const positions = Array.from(this.positions.entries());
    const sortedPositions = positions.sort((a, b) => a[1].buyTimestamp - b[1].buyTimestamp);
    
    // Remove oldest positions that are not active
    const toRemove = sortedPositions
      .filter(([_, pos]) => pos.status !== 'active')
      .slice(0, 10);

    toRemove.forEach(([mint, _]) => {
      this.positions.delete(mint);
    });

    if (toRemove.length > 0) {
      logger.debug(`POSITION_CLEANUP -> Removed ${toRemove.length} old positions`);
    }
  }
}