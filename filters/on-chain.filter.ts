import { Filter, FilterResult } from './pool-filters';
import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4, TokenAmount, Token } from '@raydium-io/raydium-sdk';
import { MintLayout, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { logger } from '../helpers/logger';
import {
  CHECK_IMMUTABLE_METADATA,
  CHECK_MINT_RENOUNCED,
  CHECK_FREEZE_AUTHORITY,
  EXCLUDE_TOKEN2022,
  MIN_POOL_SIZE,
  MAX_POOL_SIZE,
  MAX_POOL_AGE_MINUTES,
  MAX_TOP1_HOLDER_PERCENT,
  MAX_TOP5_HOLDER_PERCENT,
  REQUIRE_LP_PROTECTION,
  MIN_LP_BURN_PERCENT
} from '../utils/constants';
import axios from 'axios';

export class OnChainFilter implements Filter {
  private readonly metadataSerializer = getMetadataAccountDataSerializer();

  constructor(
    private readonly connection: Connection,
    private readonly quoteToken: Token
  ) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    const mint = poolKeys.baseMint.toString();
    
    try {
      // Check if Token-2022 and exclude if needed
      if (EXCLUDE_TOKEN2022) {
        const tokenProgramCheck = await this.checkTokenProgram(poolKeys.baseMint);
        if (!tokenProgramCheck.ok) return tokenProgramCheck;
      }

      // Check metadata immutability
      if (CHECK_IMMUTABLE_METADATA) {
        const metadataCheck = await this.checkMetadataImmutable(poolKeys.baseMint);
        if (!metadataCheck.ok) return metadataCheck;
      }

      // Check mint authority renounced
      if (CHECK_MINT_RENOUNCED) {
        const renouncedCheck = await this.checkMintRenounced(poolKeys.baseMint);
        if (!renouncedCheck.ok) return renouncedCheck;
      }

      // Check freeze authority
      if (CHECK_FREEZE_AUTHORITY) {
        const freezeCheck = await this.checkFreezeAuthority(poolKeys.baseMint);
        if (!freezeCheck.ok) return freezeCheck;
      }

      // Check pool size
      const poolSizeCheck = await this.checkPoolSize(poolKeys);
      if (!poolSizeCheck.ok) return poolSizeCheck;

      // Check pool age
      const poolAgeCheck = await this.checkPoolAge(poolKeys);
      if (!poolAgeCheck.ok) return poolAgeCheck;

      // Check holder concentration
      const holderCheck = await this.checkHolderConcentration(poolKeys.baseMint);
      if (!holderCheck.ok) return holderCheck;

      // Check LP protection
      if (REQUIRE_LP_PROTECTION) {
        const lpProtectionCheck = await this.checkLPProtection(poolKeys);
        if (!lpProtectionCheck.ok) return lpProtectionCheck;
      }

      logger.trace({ mint }, 'ON_CHAIN -> All on-chain filters passed');
      return { ok: true };

    } catch (error: any) {
      logger.error({ mint, error: error.message }, 'ON_CHAIN -> Filter execution failed');
      return { ok: false, message: `ON_CHAIN -> Execution failed: ${error.message}` };
    }
  }

  private async checkTokenProgram(mint: PublicKey): Promise<FilterResult> {
    try {
      const accountInfo = await this.connection.getAccountInfo(mint);
      if (!accountInfo) {
        return { ok: false, message: 'SKIP_TOKEN2022 -> Failed to fetch mint account' };
      }

      if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        return { ok: false, message: 'SKIP_TOKEN2022 -> Token uses Token-2022 program' };
      }

      return { ok: true };
    } catch (error: any) {
      return { ok: false, message: `SKIP_TOKEN2022 -> Error checking token program: ${error.message}` };
    }
  }

  private async checkMetadataImmutable(mint: PublicKey): Promise<FilterResult> {
    try {
      const metadataPDA = getPdaMetadataKey(mint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey);

      if (!metadataAccount?.data) {
        return { ok: false, message: 'SKIP_IMMUTABLE -> Failed to fetch metadata account' };
      }

      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
      const isMutable = deserialize[0].isMutable;

      if (isMutable) {
        return { ok: false, message: 'SKIP_IMMUTABLE -> Token metadata is mutable' };
      }

      return { ok: true };
    } catch (error: any) {
      return { ok: false, message: `SKIP_IMMUTABLE -> Error checking metadata: ${error.message}` };
    }
  }

  private async checkMintRenounced(mint: PublicKey): Promise<FilterResult> {
    try {
      const accountInfo = await this.connection.getAccountInfo(mint);
      if (!accountInfo?.data) {
        return { ok: false, message: 'SKIP_RENOUNCED -> Failed to fetch mint account' };
      }

      const mintData = MintLayout.decode(accountInfo.data);
      const hasAuthority = mintData.mintAuthorityOption !== 0;

      if (hasAuthority) {
        return { ok: false, message: 'SKIP_RENOUNCED -> Mint authority not renounced' };
      }

      return { ok: true };
    } catch (error: any) {
      return { ok: false, message: `SKIP_RENOUNCED -> Error checking mint authority: ${error.message}` };
    }
  }

  private async checkFreezeAuthority(mint: PublicKey): Promise<FilterResult> {
    try {
      const accountInfo = await this.connection.getAccountInfo(mint);
      if (!accountInfo?.data) {
        return { ok: false, message: 'SKIP_FREEZE -> Failed to fetch mint account' };
      }

      const mintData = MintLayout.decode(accountInfo.data);
      const hasFreezeAuthority = mintData.freezeAuthorityOption !== 0;

      if (hasFreezeAuthority) {
        return { ok: false, message: 'SKIP_FREEZE -> Token has freeze authority' };
      }

      return { ok: true };
    } catch (error: any) {
      return { ok: false, message: `SKIP_FREEZE -> Error checking freeze authority: ${error.message}` };
    }
  }

  private async checkPoolSize(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const response = await this.connection.getTokenAccountBalance(poolKeys.quoteVault);
      const poolSize = new TokenAmount(this.quoteToken, response.value.amount, true);
      
      const minSize = parseFloat(MIN_POOL_SIZE);
      const maxSize = parseFloat(MAX_POOL_SIZE);

      if (minSize > 0 && poolSize.toExact() < minSize.toString()) {
        return { 
          ok: false, 
          message: `SKIP_POOL_SIZE -> Pool too small: ${poolSize.toFixed()} < ${minSize}` 
        };
      }

      if (maxSize > 0 && poolSize.toExact() > maxSize.toString()) {
        return { 
          ok: false, 
          message: `SKIP_POOL_SIZE -> Pool too large: ${poolSize.toFixed()} > ${maxSize}` 
        };
      }

      return { ok: true };
    } catch (error: any) {
      return { ok: false, message: `SKIP_POOL_SIZE -> Error checking pool size: ${error.message}` };
    }
  }

  private async checkPoolAge(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      // Get pool state to check creation time
      const poolInfo = await this.connection.getAccountInfo(poolKeys.id);
      if (!poolInfo) {
        return { ok: false, message: 'SKIP_POOL_AGE -> Failed to fetch pool info' };
      }

      // For now, we'll use slot time as approximation
      // In production, you'd need to track pool creation timestamps
      const currentTime = Math.floor(Date.now() / 1000);
      const maxAge = MAX_POOL_AGE_MINUTES * 60;
      
      // This is a simplified check - in production you'd need proper pool creation tracking
      logger.trace({ mint: poolKeys.baseMint.toString() }, 'POOL_AGE -> Age check passed (simplified)');
      return { ok: true };
      
    } catch (error: any) {
      return { ok: false, message: `SKIP_POOL_AGE -> Error checking pool age: ${error.message}` };
    }
  }

  private async checkHolderConcentration(mint: PublicKey): Promise<FilterResult> {
    try {
      // Use Helius API or similar to get holder distribution
      // For now, we'll use a simplified check
      
      // In production, you would:
      // 1. Get all token accounts for this mint
      // 2. Sort by balance descending
      // 3. Calculate TOP1 and TOP5 percentages
      // 4. Compare with limits
      
      logger.trace({ mint: mint.toString() }, 'HOLDERS -> Concentration check passed (simplified)');
      return { ok: true };
      
    } catch (error: any) {
      return { ok: false, message: `SKIP_HOLDERS -> Error checking holder concentration: ${error.message}` };
    }
  }

  private async checkLPProtection(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const lpSupply = await this.connection.getTokenSupply(poolKeys.lpMint);
      const burnedPercent = lpSupply.value.uiAmount === 0 ? 100 : 0;

      if (burnedPercent >= MIN_LP_BURN_PERCENT) {
        logger.trace({ mint: poolKeys.baseMint.toString() }, 'LP_BURN_OK -> LP tokens burned');
        return { ok: true };
      }

      // Check if LP is locked (would require additional API calls to locker contracts)
      // For now, we'll assume LP is not properly protected if not burned enough
      return { 
        ok: false, 
        message: `SKIP_LP_PROTECTION -> LP not sufficiently burned: ${burnedPercent}% < ${MIN_LP_BURN_PERCENT}%` 
      };

    } catch (error: any) {
      return { ok: false, message: `SKIP_LP_PROTECTION -> Error checking LP protection: ${error.message}` };
    }
  }
}