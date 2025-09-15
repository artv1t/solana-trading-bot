import { Filter, FilterResult } from './pool-filters';
import { LiquidityPoolKeysV4, TokenAmount } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers/logger';
import { MAX_PRICE_IMPACT, ROUTE_CHECK_TIMEOUT, QUOTE_AMOUNT } from '../utils/constants';
import axios from 'axios';

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null;
  priceImpactPct: number;
  routePlan: any[];
  contextSlot: number;
  timeTaken: number;
}

export class RouteGateFilter implements Filter {
  private readonly jupiterApiUrl = 'https://quote-api.jup.ag/v6/quote';

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      logger.trace({ mint: poolKeys.baseMint.toString() }, 'ROUTE_GATE -> Checking Jupiter route');

      const quoteAmount = parseFloat(QUOTE_AMOUNT) * 1e9; // Convert to lamports for WSOL
      
      const response = await axios.get(this.jupiterApiUrl, {
        params: {
          inputMint: poolKeys.quoteMint.toString(), // WSOL
          outputMint: poolKeys.baseMint.toString(), // Target token
          amount: quoteAmount.toString(),
          slippageBps: 1500, // 15% slippage
          onlyDirectRoutes: false,
          asLegacyTransaction: false
        },
        timeout: ROUTE_CHECK_TIMEOUT
      });

      if (!response.data) {
        return { 
          ok: false, 
          message: `SKIP_ROUTE_GATE -> No route found for ${poolKeys.baseMint.toString()}` 
        };
      }

      const quote: JupiterQuoteResponse = response.data;
      
      if (quote.priceImpactPct > MAX_PRICE_IMPACT) {
        return { 
          ok: false, 
          message: `SKIP_ROUTE_GATE -> Price impact too high: ${quote.priceImpactPct.toFixed(2)}% > ${MAX_PRICE_IMPACT}%` 
        };
      }

      logger.trace(
        { 
          mint: poolKeys.baseMint.toString(),
          priceImpact: quote.priceImpactPct,
          outAmount: quote.outAmount
        }, 
        'ROUTE_GATE -> Route found with acceptable price impact'
      );

      return { ok: true };

    } catch (error: any) {
      if (error.code === 'ECONNABORTED') {
        return { 
          ok: false, 
          message: `SKIP_ROUTE_GATE -> Jupiter API timeout for ${poolKeys.baseMint.toString()}` 
        };
      }

      logger.error(
        { 
          mint: poolKeys.baseMint.toString(), 
          error: error.message 
        }, 
        'ROUTE_GATE -> Failed to check Jupiter route'
      );

      return { 
        ok: false, 
        message: `SKIP_ROUTE_GATE -> Jupiter API error: ${error.message}` 
      };
    }
  }
}