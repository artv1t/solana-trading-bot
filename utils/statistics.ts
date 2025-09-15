import { logger } from '../helpers/logger';
import { PositionManager } from '../managers/position-manager';
import { ENABLE_STATISTICS, STATS_LOG_INTERVAL } from './constants';

export class Statistics {
  private startTime: number = Date.now();
  private tokensDetected: number = 0;
  private tokensFiltered: number = 0;
  private tokensBought: number = 0;
  private tokensSold: number = 0;
  private totalVolume: number = 0;
  private isRunning: boolean = false;

  constructor(private readonly positionManager: PositionManager) {
    if (ENABLE_STATISTICS) {
      this.startLogging();
    }
  }

  public incrementDetected(): void {
    this.tokensDetected++;
  }

  public incrementFiltered(): void {
    this.tokensFiltered++;
  }

  public incrementBought(volume: number): void {
    this.tokensBought++;
    this.totalVolume += volume;
  }

  public incrementSold(): void {
    this.tokensSold++;
  }

  private startLogging(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    const logStats = () => {
      if (!this.isRunning) return;
      
      const positionStats = this.positionManager.getStatistics();
      const runtime = (Date.now() - this.startTime) / (1000 * 60); // minutes
      
      logger.info({
        runtime: `${runtime.toFixed(1)} minutes`,
        detected: this.tokensDetected,
        filtered: this.tokensFiltered,
        filterRate: this.tokensDetected > 0 ? `${((this.tokensFiltered / this.tokensDetected) * 100).toFixed(1)}%` : '0%',
        bought: this.tokensBought,
        sold: this.tokensSold,
        activePositions: positionStats.active,
        totalPnl: positionStats.totalPnl.toFixed(4),
        winRate: `${positionStats.winRate.toFixed(1)}%`,
        totalVolume: this.totalVolume.toFixed(4)
      }, 'STATISTICS -> Bot performance summary');
      
      setTimeout(logStats, STATS_LOG_INTERVAL);
    };
    
    setTimeout(logStats, STATS_LOG_INTERVAL);
  }

  public stop(): void {
    this.isRunning = false;
  }

  public getStats() {
    const positionStats = this.positionManager.getStatistics();
    const runtime = (Date.now() - this.startTime) / (1000 * 60);
    
    return {
      runtime,
      tokensDetected: this.tokensDetected,
      tokensFiltered: this.tokensFiltered,
      tokensBought: this.tokensBought,
      tokensSold: this.tokensSold,
      totalVolume: this.totalVolume,
      positionStats
    };
  }
}