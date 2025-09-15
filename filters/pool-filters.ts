import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers/logger';
import { RouteGateFilter } from './route-gate.filter';
import { OnChainFilter } from './on-chain.filter';
import { DexScreenerFilter } from './dexscreener.filter';
import {
  ENABLE_ROUTE_GATE,
  ENABLE_DEXSCREENER_FILTER,
  FILTER_REPEAT_COUNT,
  FILTER_REPEAT_INTERVAL,
  FILTER_REPEAT_TIMEOUT
} from '../utils/constants';
import { sleep } from '../helpers/promises';

export interface Filter {
  execute(poolKeysV4: LiquidityPoolKeysV4): Promise<FilterResult>;
}

export interface FilterResult {
  ok: boolean;
  message?: string;
}

export interface PoolFilterArgs {
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
}

export class PoolFilters {
  private readonly filters: Filter[] = [];

  constructor(
    readonly connection: Connection,
    readonly args: PoolFilterArgs,
  ) {
    // Add Route Gate filter first (fastest check)
    if (ENABLE_ROUTE_GATE) {
      this.filters.push(new RouteGateFilter());
    }

    // Add comprehensive on-chain filter
    this.filters.push(new OnChainFilter(connection, args.quoteToken));

    // Add DexScreener filter last (slowest check)
    if (ENABLE_DEXSCREENER_FILTER) {
      this.filters.push(new DexScreenerFilter());
    }
  }

  public async execute(poolKeys: LiquidityPoolKeysV4): Promise<boolean> {
    if (this.filters.length === 0) {
      return true;
    }

    const mint = poolKeys.baseMint.toString();
    
    // Execute filters with repeat logic
    let consecutiveMatches = 0;
    const maxAttempts = Math.ceil(FILTER_REPEAT_TIMEOUT / FILTER_REPEAT_INTERVAL);
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      logger.trace({ mint, attempt: attempt + 1 }, 'FILTER_CHECK -> Running filter check');
      
      let allPassed = true;
      
      // Run filters sequentially (not in parallel) for better error handling
      for (const filter of this.filters) {
        const result = await filter.execute(poolKeys);
        
        if (!result.ok) {
          if (result.message) {
            logger.trace({ mint }, result.message);
          }
          allPassed = false;
          break; // Stop at first failed filter
        }
      }
      
      if (allPassed) {
        consecutiveMatches++;
        logger.debug(
          { mint, consecutiveMatches, required: FILTER_REPEAT_COUNT }, 
          'FILTER_MATCH -> Filters passed'
        );
        
        if (consecutiveMatches >= FILTER_REPEAT_COUNT) {
          logger.info({ mint }, 'FILTER_SUCCESS -> All filters passed required times');
          return true;
        }
      } else {
        consecutiveMatches = 0; // Reset on failure
      }
      
      // Wait before next attempt (except on last attempt)
      if (attempt < maxAttempts - 1) {
        await sleep(FILTER_REPEAT_INTERVAL);
      }
    }

    logger.debug(
      { mint, consecutiveMatches, required: FILTER_REPEAT_COUNT }, 
      'FILTER_TIMEOUT -> Failed to achieve required consecutive matches'
    );

    return false;
  }
}