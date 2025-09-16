import { Logger } from 'pino';
import dotenv from 'dotenv';
import { Commitment } from '@solana/web3.js';
import { logger } from '../helpers/logger';

dotenv.config();

const retrieveEnvVariable = (variableName: string, logger: Logger, defaultValue?: string) => {
  const variable = process.env[variableName] || defaultValue || '';
  if (!variable && !defaultValue) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

const getEnvNumber = (variableName: string, defaultValue: number): number => {
  const value = process.env[variableName];
  return value ? Number(value) : defaultValue;
};

const getEnvBoolean = (variableName: string, defaultValue: boolean): boolean => {
  const value = process.env[variableName];
  return value ? value === 'true' : defaultValue;
};

// Wallet Configuration
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);

// RPC Configuration
export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger, 'confirmed') as Commitment;
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

// Bot Configuration
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger, 'info');
export const ONE_TOKEN_AT_A_TIME = getEnvBoolean('ONE_TOKEN_AT_A_TIME', true);
export const COMPUTE_UNIT_LIMIT = getEnvNumber('COMPUTE_UNIT_LIMIT', 200000);
export const COMPUTE_UNIT_PRICE = getEnvNumber('COMPUTE_UNIT_PRICE', 500000);
export const PRE_LOAD_EXISTING_MARKETS = getEnvBoolean('PRE_LOAD_EXISTING_MARKETS', false);
export const CACHE_NEW_MARKETS = getEnvBoolean('CACHE_NEW_MARKETS', false);
export const TRANSACTION_EXECUTOR = retrieveEnvVariable('TRANSACTION_EXECUTOR', logger, 'default');
export const CUSTOM_FEE = retrieveEnvVariable('CUSTOM_FEE', logger, '0.006');

// Trading Configuration
export const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger, 'WSOL');
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger, '0.01');
export const AUTO_BUY_DELAY = getEnvNumber('AUTO_BUY_DELAY', 1000);
export const MAX_BUY_RETRIES = getEnvNumber('MAX_BUY_RETRIES', 3);
export const BUY_SLIPPAGE = getEnvNumber('BUY_SLIPPAGE', 15);

// Sell Configuration
export const AUTO_SELL = getEnvBoolean('AUTO_SELL', true);
export const MAX_SELL_RETRIES = getEnvNumber('MAX_SELL_RETRIES', 3);
export const AUTO_SELL_DELAY = getEnvNumber('AUTO_SELL_DELAY', 2000);
export const TAKE_PROFIT = getEnvNumber('TAKE_PROFIT', 50);
export const STOP_LOSS = getEnvNumber('STOP_LOSS', 30);
export const SELL_SLIPPAGE = getEnvNumber('SELL_SLIPPAGE', 15);
export const TTL_MINUTES = getEnvNumber('TTL_MINUTES', 30);
export const PRICE_CHECK_INTERVAL = getEnvNumber('PRICE_CHECK_INTERVAL', 5000);

// Route Gate Filter
export const ENABLE_ROUTE_GATE = getEnvBoolean('ENABLE_ROUTE_GATE', true);
export const MAX_PRICE_IMPACT = getEnvNumber('MAX_PRICE_IMPACT', 15);
export const ROUTE_CHECK_TIMEOUT = getEnvNumber('ROUTE_CHECK_TIMEOUT', 10000);

// On-Chain Filters
export const CHECK_IMMUTABLE_METADATA = getEnvBoolean('CHECK_IMMUTABLE_METADATA', true);
export const CHECK_MINT_RENOUNCED = getEnvBoolean('CHECK_MINT_RENOUNCED', true);
export const CHECK_FREEZE_AUTHORITY = getEnvBoolean('CHECK_FREEZE_AUTHORITY', true);
export const EXCLUDE_TOKEN2022 = getEnvBoolean('EXCLUDE_TOKEN2022', true);
export const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger, '1');
export const MAX_POOL_SIZE = retrieveEnvVariable('MAX_POOL_SIZE', logger, '100');
export const MAX_POOL_AGE_MINUTES = getEnvNumber('MAX_POOL_AGE_MINUTES', 60);
export const MAX_TOP1_HOLDER_PERCENT = getEnvNumber('MAX_TOP1_HOLDER_PERCENT', 20);
export const MAX_TOP5_HOLDER_PERCENT = getEnvNumber('MAX_TOP5_HOLDER_PERCENT', 50);

// LP Protection
export const REQUIRE_LP_PROTECTION = getEnvBoolean('REQUIRE_LP_PROTECTION', true);
export const MIN_LP_BURN_PERCENT = getEnvNumber('MIN_LP_BURN_PERCENT', 80);
export const LP_LOCKER_WHITELIST = retrieveEnvVariable('LP_LOCKER_WHITELIST', logger, 'Team Finance,Unicrypt,PinkSale').split(',');

// Repeat Checks
export const FILTER_REPEAT_COUNT = getEnvNumber('FILTER_REPEAT_COUNT', 3);
export const FILTER_REPEAT_INTERVAL = getEnvNumber('FILTER_REPEAT_INTERVAL', 5000);
export const FILTER_REPEAT_TIMEOUT = getEnvNumber('FILTER_REPEAT_TIMEOUT', 30000);

// DexScreener Filter
export const ENABLE_DEXSCREENER_FILTER = getEnvBoolean('ENABLE_DEXSCREENER_FILTER', true);
export const DEXSCREENER_CHECK_INTERVAL = getEnvNumber('DEXSCREENER_CHECK_INTERVAL', 20000);
export const DEXSCREENER_MAX_WAIT_MINUTES = getEnvNumber('DEXSCREENER_MAX_WAIT_MINUTES', 15);
export const REQUIRE_LOGO = getEnvBoolean('REQUIRE_LOGO', true);
export const REQUIRE_SOCIALS = getEnvBoolean('REQUIRE_SOCIALS', true);
export const SOCIAL_WHITELIST = retrieveEnvVariable('SOCIAL_WHITELIST', logger, 'twitter,telegram,discord,website').split(',');

// Snipe List
export const USE_SNIPE_LIST = getEnvBoolean('USE_SNIPE_LIST', false);
export const SNIPE_LIST_REFRESH_INTERVAL = getEnvNumber('SNIPE_LIST_REFRESH_INTERVAL', 30000);

// Statistics
export const ENABLE_STATISTICS = getEnvBoolean('ENABLE_STATISTICS', true);
export const STATS_LOG_INTERVAL = getEnvNumber('STATS_LOG_INTERVAL', 300000);

// Alerts
export const ENABLE_ALERTS = getEnvBoolean('ENABLE_ALERTS', true);
export const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

// Test Mode
export const TEST_MODE = getEnvBoolean('TEST_MODE', false);

// Balance Check
export const MIN_SOL_BALANCE = getEnvNumber('MIN_SOL_BALANCE', 0.1);

// Legacy constants for backward compatibility
export const CHECK_IF_MUTABLE = !CHECK_IMMUTABLE_METADATA;
export const CHECK_IF_SOCIALS = REQUIRE_SOCIALS;
export const CHECK_IF_MINT_IS_RENOUNCED = CHECK_MINT_RENOUNCED;
export const CHECK_IF_FREEZABLE = !CHECK_FREEZE_AUTHORITY;
export const CHECK_IF_BURNED = REQUIRE_LP_PROTECTION;
export const FILTER_CHECK_INTERVAL = FILTER_REPEAT_INTERVAL;
export const FILTER_CHECK_DURATION = FILTER_REPEAT_TIMEOUT;
export const CONSECUTIVE_FILTER_MATCHES = FILTER_REPEAT_COUNT;