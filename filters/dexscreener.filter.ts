import { Filter, FilterResult } from './pool-filters';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers';
import {
  DEXSCREENER_CHECK_INTERVAL,
  DEXSCREENER_MAX_WAIT_MINUTES,
  REQUIRE_LOGO,
  REQUIRE_SOCIALS,
  SOCIAL_WHITELIST
} from '../utils/constants';
import axios from 'axios';
import { sleep } from '../helpers/promises';

export interface DexScreenerToken {
  address: string;
  name: string;
  symbol: string;
  logoURI?: string;
  websites?: { label: string; url: string }[];
  socials?: { type: string; url: string }[];
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  priceNative: string;
  priceUsd?: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity?: {
    usd?: number;
    base: number;
    quote: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

export class DexScreenerFilter implements Filter {
  private readonly dexScreenerApiUrl = 'https://api.dexscreener.com/latest/dex/tokens';

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    const mint = poolKeys.baseMint.toString();
    
    try {
      logger.trace({ mint }, 'DEXSCREENER -> Starting social/logo check');

      const maxWaitTime = DEXSCREENER_MAX_WAIT_MINUTES * 60 * 1000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        try {
          const response = await axios.get<DexScreenerResponse>(
            `${this.dexScreenerApiUrl}/${mint}`,
            { timeout: 10000 }
          );

          if (!response.data.pairs || response.data.pairs.length === 0) {
            logger.trace({ mint }, 'DEXSCREENER -> No pairs found, waiting...');
            await sleep(DEXSCREENER_CHECK_INTERVAL);
            continue;
          }

          const pair = response.data.pairs[0];
          const token = pair.baseToken;

          // Check logo requirement
          if (REQUIRE_LOGO && !token.logoURI) {
            logger.trace({ mint }, 'DEXSCREENER -> No logo found, waiting...');
            await sleep(DEXSCREENER_CHECK_INTERVAL);
            continue;
          }

          // Check social requirements
          if (REQUIRE_SOCIALS) {
            const socialCheck = this.checkSocials(token);
            if (!socialCheck.ok) {
              logger.trace({ mint }, 'DEXSCREENER -> Insufficient socials, waiting...');
              await sleep(DEXSCREENER_CHECK_INTERVAL);
              continue;
            }
          }

          logger.info(
            { 
              mint,
              hasLogo: !!token.logoURI,
              socials: token.socials?.length || 0,
              websites: token.websites?.length || 0
            }, 
            'DEXSCREENER -> Token has required logo and socials'
          );

          return { ok: true };

        } catch (error: any) {
          if (error.response?.status === 404) {
            logger.trace({ mint }, 'DEXSCREENER -> Token not found on DexScreener, waiting...');
            await sleep(DEXSCREENER_CHECK_INTERVAL);
            continue;
          }

          logger.error({ mint, error: error.message }, 'DEXSCREENER -> API error, retrying...');
          await sleep(DEXSCREENER_CHECK_INTERVAL);
          continue;
        }
      }

      return { 
        ok: false, 
        message: `SKIP_DEXSCREENER -> Timeout waiting for logo/socials after ${DEXSCREENER_MAX_WAIT_MINUTES} minutes` 
      };

    } catch (error: any) {
      logger.error({ mint, error: error.message }, 'DEXSCREENER -> Filter execution failed');
      return { 
        ok: false, 
        message: `SKIP_DEXSCREENER -> Execution failed: ${error.message}` 
      };
    }
  }

  private checkSocials(token: DexScreenerToken): FilterResult {
    const allSocials = [
      ...(token.socials || []).map(s => s.type.toLowerCase()),
      ...(token.websites || []).map(w => w.label.toLowerCase())
    ];

    const requiredSocials = SOCIAL_WHITELIST.map(s => s.toLowerCase());
    const hasRequiredSocial = requiredSocials.some(required => 
      allSocials.some(social => social.includes(required))
    );

    if (!hasRequiredSocial) {
      return { 
        ok: false, 
        message: `Missing required socials. Found: ${allSocials.join(', ')}, Required: ${requiredSocials.join(', ')}` 
      };
    }

    return { ok: true };
  }
}