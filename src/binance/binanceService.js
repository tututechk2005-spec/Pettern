'use strict';
const crypto = require('crypto');
const axios = require('axios');
const cryptoUtil = require('../utils/crypto');
const logger = require('../utils/logger');

const BASE_URLS = {
  spot_real: 'https://api.binance.com',
  spot_testnet: 'https://testnet.binance.vision',
  futures_real: 'https://fapi.binance.com',
  futures_testnet: 'https://testnet.binancefuture.com',
};

function isFutures(accountType) {
  return accountType === 'futures_real' || accountType === 'futures_testnet';
}

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

/**
 * Classifies a Binance API error into one of the specific categories the
 * frontend needs to show a meaningful, non-generic notification for.
 */
function classifyError(err) {
  const code = err.binanceCode;
  const status = err.status;

  if (code === -2014) return 'invalid_api_key';
  if (code === -2015) return 'invalid_api_key';
  if (code === -1022) return 'invalid_secret';
  if (code === -1021) return 'clock_skew';
  if (code === -2010) return 'missing_permissions';
  if (code === -1102 || code === -1104) return 'missing_permissions';
  if (status === 403) return 'missing_permissions';
  if (status === 418 || status === 429) return 'rate_limited';
  if (status >= 500) return 'binance_server_error';
  if (status === 401) return 'invalid_api_key';
  return 'unknown_error';
}

function hintForError(err, errorType, accountType) {
  const isFuturesAcct = accountType && accountType.startsWith('futures');
  switch (errorType) {
    case 'invalid_api_key':
      return 'The API key was rejected by Binance. Double check you copied it exactly with no extra spaces, and that it belongs to the correct account (Testnet keys only work on Testnet, Real keys only work on Real).';
    case 'invalid_secret':
      return 'The API secret does not match the API key (signature verification failed). Re-copy the secret exactly - it is only shown once when the key is created on Binance.';
    case 'missing_permissions':
      return isFuturesAcct
        ? 'This API key does not have Futures trading permission enabled. On Binance, edit the API key and enable "Enable Futures" under API restrictions.'
        : 'This API key does not have the required permission enabled. On Binance, edit the API key and enable "Enable Reading" and "Enable Spot & Margin Trading".';
    case 'clock_skew':
      return 'Server clock drift caused a timestamp mismatch. This is usually transient - try again.';
    case 'rate_limited':
      return 'Binance is rate-limiting this request. Wait a short while before retrying.';
    case 'network_timeout':
      return 'The request to Binance timed out. Check your network connection and try again.';
    case 'network_error':
      return 'Could not reach Binance servers. Check your network connection or Binance status page.';
    case 'binance_server_error':
      return 'Binance is currently experiencing server issues. This is not caused by your API key - try again shortly.';
    default:
      return 'Verify the API key/secret, account type (spot/futures, testnet/real), and required permissions (read + trade).';
  }
}

/**
 * Thin wrapper around the Binance REST API. Every call takes the decrypted
 * apiKey/apiSecret pair for the account so we never keep long-lived clients
 * with credentials in memory longer than a single request.
 */
class BinanceClient {
  constructor(accountType, apiKey, apiSecret) {
    if (!BASE_URLS[accountType]) throw new Error(`Unknown account type: ${accountType}`);
    this.accountType = accountType;
    this.baseUrl = BASE_URLS[accountType];
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.futures = isFutures(accountType);
  }

  async request(method, path, params = {}, signed = false) {
    const query = new URLSearchParams(params);
    if (signed) {
      query.set('timestamp', Date.now().toString());
      query.set('recvWindow', '10000');
      const signature = sign(query.toString(), this.apiSecret);
      query.set('signature', signature);
    }
    const url = `${this.baseUrl}${path}${query.toString() ? '?' + query.toString() : ''}`;
    try {
      const res = await axios({
        method,
        url,
        headers: this.apiKey ? { 'X-MBX-APIKEY': this.apiKey } : {},
        timeout: 15000,
      });
      return res.data;
    } catch (err) {
      // Network-level failure - no HTTP response received at all
      if (!err.response) {
        const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
        const e = new Error(isTimeout ? 'Network timeout - Binance did not respond in time' : `Network error contacting Binance: ${err.message}`);
        e.errorType = isTimeout ? 'network_timeout' : 'network_error';
        e.status = null;
        throw e;
      }
      const detail = err.response.data || { msg: err.message };
      const e = new Error(detail.msg || 'Binance API request failed');
      e.binanceCode = detail.code;
      e.status = err.response.status;
      e.errorType = classifyError(e);
      throw e;
    }
  }

  // ---- Public/market data --------------------------------------------------
  ping() {
    return this.request('GET', this.futures ? '/fapi/v1/ping' : '/api/v3/ping');
  }

  serverTime() {
    return this.request('GET', this.futures ? '/fapi/v1/time' : '/api/v3/time');
  }

  klines(symbol, interval, limit = 200) {
    const path = this.futures ? '/fapi/v1/klines' : '/api/v3/klines';
    return this.request('GET', path, { symbol, interval, limit });
  }

  ticker24hr(symbol) {
    const path = this.futures ? '/fapi/v1/ticker/24hr' : '/api/v3/ticker/24hr';
    return this.request('GET', path, symbol ? { symbol } : {});
  }

  exchangeInfo() {
    const path = this.futures ? '/fapi/v1/exchangeInfo' : '/api/v3/exchangeInfo';
    return this.request('GET', path);
  }

  /**
   * Returns every tradable USDT-margined perpetual futures symbol, skipping
   * anything suspended, delisted, or not yet trading. Used by the scanner to
   * build its dynamic symbol list instead of a hardcoded one.
   */
  async fetchFuturesUSDTPerpetuals() {
    const info = await this.request('GET', '/fapi/v1/exchangeInfo');
    const symbols = (info.symbols || []).filter((s) =>
      s.quoteAsset === 'USDT' &&
      s.contractType === 'PERPETUAL' &&
      s.status === 'TRADING'
    );
    return symbols.map((s) => ({ symbol: s.symbol, status: s.status, contractType: s.contractType }));
  }

  // ---- Account / private ----------------------------------------------------
  accountInfo() {
    const path = this.futures ? '/fapi/v2/account' : '/api/v3/account';
    return this.request('GET', path, {}, true);
  }

  balances() {
    if (this.futures) return this.request('GET', '/fapi/v2/balance', {}, true);
    return this.accountInfo().then((a) => a.balances);
  }

  openOrders(symbol) {
    const path = this.futures ? '/fapi/v1/openOrders' : '/api/v3/openOrders';
    return this.request('GET', path, symbol ? { symbol } : {}, true);
  }

  positionRisk(symbol) {
    if (!this.futures) return Promise.resolve([]);
    return this.request('GET', '/fapi/v2/positionRisk', symbol ? { symbol } : {}, true);
  }

  myTrades(symbol, limit = 50) {
    const path = this.futures ? '/fapi/v1/userTrades' : '/api/v3/myTrades';
    return this.request('GET', path, { symbol, limit }, true);
  }

  // ---- Trading ---------------------------------------------------------------
  placeOrder(params) {
    const path = this.futures ? '/fapi/v1/order' : '/api/v3/order';
    return this.request('POST', path, params, true);
  }

  cancelOrder(symbol, orderId) {
    const path = this.futures ? '/fapi/v1/order' : '/api/v3/order';
    return this.request('DELETE', path, { symbol, orderId }, true);
  }

  changeLeverage(symbol, leverage) {
    if (!this.futures) return Promise.resolve(null);
    return this.request('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
  }

  // ---- Validation --------------------------------------------------------
  async validateKeys() {
    logger.info('binance', `Validating ${this.accountType} API keys...`);
    try {
      await this.ping();
      const account = await this.accountInfo();
      logger.info('binance', `Validation SUCCESS for ${this.accountType}`);
      return { ok: true, account };
    } catch (err) {
      const errorType = err.errorType || classifyError(err);
      const hint = hintForError(err, errorType, this.accountType);
      logger.error('binance', `Validation FAILED for ${this.accountType}: [${errorType}] ${err.message}`);
      return {
        ok: false,
        error: err.message,
        errorType,
        code: err.binanceCode,
        httpStatus: err.status,
        hint,
      };
    }
  }
}

function buildClient(accountType, encApiKey, encApiSecret) {
  const apiKey = cryptoUtil.decrypt(encApiKey);
  const apiSecret = cryptoUtil.decrypt(encApiSecret);
  return new BinanceClient(accountType, apiKey, apiSecret);
}

module.exports = { BinanceClient, buildClient, BASE_URLS, isFutures, classifyError, hintForError };
