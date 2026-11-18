// Node 18+, no dependencies. Run with node samples/node/quickstart.mjs.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];
function signRequest(signingSecret, method, path, body = '',
  timestamp = Math.floor(Date.now() / 1000),
  nonce = randomBytes(18).toString('base64url')) {
  const write = WRITES.includes(method);
  const digest = createHash('sha256').update(body).digest('hex');
  const lines = write
    ? [timestamp, nonce, method, path, digest]
    : [timestamp, method, path, digest];
  const key = Buffer.from(signingSecret, 'hex');
  const signature = createHmac('sha256', key)
    .update(lines.join('\n')).digest('hex');
  const headers = { 'X-Timestamp': String(timestamp), 'X-Signature': signature };
  if (write) headers['X-Nonce'] = nonce;
  return headers;
}

const json = JSON.stringify;
class ResponseError extends Error {}
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

function minimumReceive(amount, bps, decimals) {
  if (typeof amount !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(amount)
      || !/^(0|[1-9][0-9]{0,3})$/.test(bps)
      || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Invalid decimal amount, slippage (0-9999 bps), or asset decimals (0-255).');
  }
  const [whole, fraction = ''] = amount.split('.');
  const units = BigInt(whole + fraction) * (10000n - BigInt(bps))
    * 10n ** BigInt(decimals) / 10n ** BigInt(fraction.length + 4);
  if (!units) throw new Error('Minimum receive must be positive; this amount is below the asset precision.');
  const digits = units.toString().padStart(decimals + 1, '0');
  return decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
}

function orderBody(quote, assets) {
  const body = { quoteId: quote.id };
  if (quote.minReceiveRequired === true) {
    const decimals = assets.items.filter(({ asset }) => asset === quote.buy.asset)
      .flatMap(({ variants }) => variants.filter(({ kind }) => kind === 'native'))
      .flatMap(({ deployments }) => deployments)
      .filter(({ network }) => !quote.buy.network || network === quote.buy.network)
      .map(({ decimals }) => decimals);
    if (!decimals.length) throw new Error('RECEIVE_ASSET_DECIMALS_MISSING');
    body.minReceive = minimumReceive(quote.buy.amount,
      process.env.TETRAFI_SLIPPAGE_BPS || '50', Math.min(...decimals));
  }
  return json(body);
}

function recordPath(quoteId) {
  if (typeof quoteId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(quoteId)) {
    throw new Error('Invalid quote id.');
  }
  return `./tetrafi-order-${quoteId}.json`;
}

function saveAndLoad(path, quote, assets) {
  if (!existsSync(path)) {
    const record = { quoteId: quote.id, idempotencyKey: randomBytes(16).toString('hex'),
      exactBody: orderBody(quote, assets) };
    // Exclusive creation: a competing run cannot overwrite the first key.
    writeFileSync(path, `${json(record)}\n`, { flag: 'wx', mode: 0o600 });
  }
  if (!lstatSync(path).isFile()) throw new Error('Order record is not a regular file.');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.quoteId !== quote.id || typeof record.idempotencyKey !== 'string'
      || !/^[a-f0-9]{32}$/.test(record.idempotencyKey)
      || typeof record.exactBody !== 'string'
      || JSON.parse(record.exactBody)?.quoteId !== quote.id) {
    throw new Error('Order record is unreadable or mismatched. Do not replace it with a new key.');
  }
  return record;
}

function checkOrderAnswer(order, quoteId) {
  const nonempty = (value) => typeof value === 'string' && value.length > 0;
  if (!nonempty(order?.kind) || !nonempty(order.orderId)
      || typeof order.statusUrl !== 'string' || !order.statusUrl.startsWith('/api/v1/orders/')
      || !nonempty(order.status) || typeof order.terminal !== 'boolean'
      || (order.quoteId != null && order.quoteId !== quoteId)) {
    throw new Error('Order answer is unreadable; it is not proof that nothing was placed.');
  }
}

function recovery(record, quoteId) {
  console.error(`Order outcome may be unknown. Keep ${record}. Do not rerun the whole script,
request a fresh quote, generate a new key, or place a fresh order to retry this trade.
Resend the saved exactBody to POST /api/v1/orders with the SAME saved idempotencyKey
and fresh signing headers. Even if replay fails, read GET /api/v1/orders/by-quote/${quoteId}.
ordered: follow statusUrl. unknown or a failed read: wait and read again, never order again.
notOrdered: retry only the saved body and key, and only while expired is false.`);
}

async function main() {
  // #region quickstart-client
  const baseUrl = required('TETRAFI_BASE_URL');
  const apiKey = required('TETRAFI_API_KEY');
  const signingSecret = process.env.TETRAFI_SIGNING_SECRET;

  async function tetrafi(method, path, body = '', extra = {}) {
    const headers = {
      'X-API-Key': apiKey,
      Accept: 'application/json',
      'TetraFi-Version': '2026-11-17',
      ...extra,
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (signingSecret) {
      Object.assign(headers, signRequest(signingSecret, method, path, body));
    }
    const response = await fetch(baseUrl + path, {
      method, headers, body: body || undefined,
      redirect: 'manual', signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new ResponseError(text);
    return JSON.parse(text);
  }

  const sell = process.env.TETRAFI_SELL || 'USDC';
  const buy = process.env.TETRAFI_BUY || 'USDT';
  const amount = process.env.TETRAFI_AMOUNT || '10';
  // #endregion

  // #region quickstart-assets
  const assets = { items: [] };
  let cursor = '';
  do { // follow nextCursor to the last page
    const next = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await tetrafi('GET', `/api/v1/assets?limit=200${next}`);
    assets.items.push(...page.items);
    cursor = page.nextCursor ?? '';
  } while (cursor);
  for (const asset of [sell, buy]) {
    if (!assets.items.some((item) => item.asset === asset)) {
      throw new Error(json({ error: 'ASSET_NOT_LISTED', asset }));
    }
  }
  console.error(`assets: ${assets.items.length} listed,`,
    `quoting ${sell} for ${buy}`);
  // #endregion

  // #region quickstart-quote
  const request = { kind: 'pair', sell: { asset: sell }, buy: { asset: buy },
    sellAmount: amount };
  const venues = process.env.TETRAFI_VENUES;
  if (venues) request.filters = { venues: { include: venues.split(',') } };
  const quotes = await tetrafi('POST', '/api/v1/quotes', json(request));

  // Quotes arrive best first. Take the first quote you can order now.
  const quote = quotes.quotes.find((item) => item.next?.kind === 'order');
  if (!quote) {
    const sources = quotes.sources.map(({ venue, status, reason }) => ({
      venue: venue.id, status, reason: reason ?? null,
    }));
    throw new Error(json({ error: 'NO_ACTIONABLE_QUOTE', sources }));
  }
  console.error(json({ quoteId: quote.id, venue: quote.legs[0]?.venue.id,
    mode: quote.legs[0]?.venue.integrationMode, sell: quote.sell.amount,
    buy: quote.buy.amount, next: quote.next.kind,
    expiresAt: quote.expiresAt }));
  // #endregion

  if (process.env.TETRAFI_PLACE_ORDER !== '1') {
    console.log(json({ quoteId: quote.id, ordered: false }));
    return;
  }

  // #region quickstart-order
  // Save quote id, Idempotency-Key and exact body before sending.
  // orderBody applies slippage and rounds minReceive down when required.
  const record = recordPath(quote.id);
  let idempotencyKey, placed;
  try {
    const saved = saveAndLoad(record, quote, assets);
    idempotencyKey = saved.idempotencyKey;
    placed = await tetrafi('POST', '/api/v1/orders', saved.exactBody,
      { 'Idempotency-Key': idempotencyKey });
    checkOrderAnswer(placed, quote.id);
  } catch (error) {
    console.error(error.message);
    recovery(record, quote.id);
    process.exitCode = 1;
    return;
  }
  console.error(`Order request saved in ${record}; reuse it for every retry.`);
  console.error(json({ kind: placed.kind, quoteId: placed.quoteId ?? null }));
  // #endregion

  // #region quickstart-status
  // terminal says whether status can still change; next says what to do.
  const order = await tetrafi('GET', placed.statusUrl);
  const { kind, status, terminal, next = null } = order;
  console.log(json({ kind, status, terminal, next, idempotencyKey }));
  // #endregion
}

function selfTest() {
  const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('hex');
  const body = '{"quoteId":"q_example","minReceive":"9.95"}';
  const path = '/api/v1/orders';
  const nonce = 'Ex4mpleNonce_0123456789';
  const write = signRequest(secret, 'POST', path, body, 1795000000, nonce);
  const read = signRequest(secret, 'GET', `${path}?limit=5`, '', 1795000000);
  assert.equal(write['X-Signature'], '1d39eb3481420b8969e52a21aafb0bd446678ae0db576e92d3662f99ca4792f8');
  assert.equal(write['X-Nonce'], nonce);
  assert.equal(read['X-Signature'], '29c51b5c2e63a4c97526add948df624234cc531952995ebb761bd1c50be47e54');
  assert.equal(read['X-Nonce'], undefined);
  assert.notEqual(signRequest(secret, 'POST', path, body.replace('9.95', '9.96'),
    1795000000, nonce)['X-Signature'], write['X-Signature']);
  assert.equal(minimumReceive('10.003', '50', 2), '9.95');
  assert.equal(minimumReceive('9007199254740993.23', '0', 2), '9007199254740993.23');
  assert.throws(() => minimumReceive('0.01', '50', 2), /positive/);
  console.log('Node.js quickstart: signing vectors and exact minimum receive pass');
}

if (process.argv.includes('--self-test')) selfTest();
else await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
