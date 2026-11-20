// The journeys a client walks through the API, in call order. Each endpoint page opens with one line
// placing its operation in its journey ("Step 3 of 5: … → **Order** → …"), so a reader of one page
// knows what comes before and after it. An operation's primary journey is the first one that lists
// it; a second journey adds "also step N of …". An operation in no journey is STANDALONE: its line
// names only its permission and walkthrough. A new operation fails the sync until it is placed here,
// and a step naming an operation the spec no longer has fails it too.
import { readFileSync } from 'node:fs';

const W = '/api/v1/workspaces/{workspaceId}';
const ACCOUNT = `${W}/venue-accounts/{venueAccountId}`;

const JOURNEYS = [
  { id: 'trade', title: 'Trade', guide: '/trade/how-a-trade-runs', steps: [
    { label: 'Assets and prices', ops: ['GET /api/v1/assets', 'GET /api/v1/pairs', 'GET /api/v1/prices', 'GET /api/v1/prices/stream'] },
    { label: 'Quote', ops: ['POST /api/v1/quotes', 'GET /api/v1/quotes/requests/{quoteRequestId}'] },
    { label: 'Order', ops: ['POST /api/v1/orders'] },
    { label: 'Status', ops: ['GET /api/v1/orders/{orderId}', 'GET /api/v1/orders/by-quote/{quoteId}', 'GET /api/v1/orders'] },
    { label: 'Settle', ops: [`GET ${W}/trades`, `GET ${W}/trades/{tradeId}`, `GET ${W}/trades/{tradeId}/settlement`] },
  ] },
  { id: 'own-wallet', title: 'Own wallet', guide: '/trade/sign-with-your-own-wallet', steps: [
    { label: 'Quote', ops: ['POST /api/v1/quotes'] },
    { label: 'Order', ops: ['POST /api/v1/orders'] },
    { label: 'Sign step', ops: ['POST /api/v1/orders/{orderId}/steps/{stepId}'] },
    { label: 'Status', ops: ['GET /api/v1/orders/{orderId}'] },
  ] },
  { id: 'venue-setup', title: 'Venue setup', guide: '/before-you-trade', steps: [
    { label: 'Accounts', ops: [`GET ${W}/venue-enablements`, `GET ${W}/capabilities`] },
    { label: 'Balances', ops: [`GET ${ACCOUNT}/balances`, `GET ${W}/balances`] },
    { label: 'Deposit', ops: [`GET ${ACCOUNT}/deposit-instructions`, `GET ${ACCOUNT}/deposit-history`] },
  ] },
  { id: 'webhooks', title: 'Webhooks', guide: '/trade/webhooks', steps: [
    { label: 'Create', ops: [`POST ${W}/webhooks`] },
    { label: 'Test', ops: [`POST ${W}/webhooks/{webhookId}/deliveries`] },
    { label: 'Deliveries', ops: [`GET ${W}/webhooks/{webhookId}/deliveries`, `POST ${W}/webhooks/{webhookId}/deliveries/{deliveryId}/retry`, `POST ${W}/webhooks/{webhookId}/resume`] },
  ] },
];

const STANDALONE = [
  'GET /api/v1/me', 'POST /api/v1/oauth/token', 'POST /api/v1/orders/{orderId}/cancel', 'POST /api/v1/batch',
  `GET ${W}/trades/{tradeId}/settlement/obligations`, `GET ${W}/settlement/plan`,
  `GET ${ACCOUNT}/settlement/movements`, `GET ${ACCOUNT}/settlement/movements/{movementId}`,
  `GET ${ACCOUNT}/settlement/obligations`, `GET ${ACCOUNT}/settlement/obligations/{obligationId}`,
  `GET ${ACCOUNT}/settlement/schedule-selection`, `GET ${ACCOUNT}/settlement/schedules`,
  `GET ${ACCOUNT}/settlement/windows`, `GET ${ACCOUNT}/settlement/windows/{windowId}`,
  `GET ${ACCOUNT}/settlement/windows/{windowId}/matches`,
  `GET ${W}/venue-account-credit`, `GET ${ACCOUNT}/credit`, `GET ${ACCOUNT}/ledger`, `GET ${W}/fee-schedule`,
  `GET ${W}/wallets`, `POST ${W}/wallets`, `GET ${W}/wallets/{walletId}`, `POST ${W}/wallets/{walletId}/cancel`,
  `GET ${W}/webhooks`, `GET ${W}/webhooks/{webhookId}`, `PATCH ${W}/webhooks/{webhookId}`, `DELETE ${W}/webhooks/{webhookId}`,
  `POST ${W}/webhooks/{webhookId}/rotate`,
];

// Generator tests point TETRAFI_JOURNEYS at a JSON file { journeys, standalone } that places their fixture spec.
function data() {
  const file = process.env.TETRAFI_JOURNEYS;
  if (!file) return { journeys: JOURNEYS, standalone: new Set(STANDALONE) };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return { journeys: parsed.journeys, standalone: new Set(parsed.standalone) };
}

// Every operation is placed exactly once as journey steps or standalone, and every placed operation exists.
export function checkJourneys(opKeys) {
  const { journeys, standalone } = data();
  const known = new Set(opKeys);
  const placed = new Set(journeys.flatMap((j) => j.steps.flatMap((s) => s.ops)));
  for (const key of [...placed, ...standalone]) if (!known.has(key)) throw new Error(`JOURNEY_OPERATION_UNKNOWN ${key} (remove it from scripts/journeys.mjs)`);
  for (const key of placed) if (standalone.has(key)) throw new Error(`JOURNEY_OPERATION_TWICE ${key} (in a journey and standalone)`);
  for (const key of opKeys) if (!placed.has(key) && !standalone.has(key)) throw new Error(`JOURNEY_OPERATION_UNPLACED ${key} (place it in scripts/journeys.mjs)`);
}

// The strip under an endpoint's method box: where it sits (one line), then what it needs and where it is explained.
export function fitsLine(opKey, needs, walkthrough) {
  const { journeys } = data();
  const homes = journeys.map((j) => ({ j, at: j.steps.findIndex((s) => s.ops.includes(opKey)) })).filter(({ at }) => at >= 0);
  const access = `${needs} · ${walkthrough}`;
  if (!homes.length) return access;
  const [{ j, at }, ...others] = homes;
  const path = j.steps.map((s, i) => (i === at ? `**${s.label}**` : s.label)).join(' → ');
  const also = others.map((other) => ` · also step ${other.at + 1} of [${other.j.title}](${other.j.guide})`).join('');
  return `**Step ${at + 1} of ${j.steps.length}:** ${path}${also}<br />\n${access}`;
}
