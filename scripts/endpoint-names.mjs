// Short names for the API reference sidebar, the endpoint map and the Postman collection. The spec's
// summaries are sentences; these are the names people skim. One form for every name:
//   List <records>        a collection (paged)
//   Get <record or view>  one record, or one computed view such as balances or a plan
//   Create / Update / Delete <record>
//   <Action> <record>     a transition or a call that does something: Place, Cancel, Request, Stream…
// No articles, about 2 to 4 words, unique across the API. A new operation fails the sync until it has
// a name here, and a name whose operation is gone fails it too.
export const ENDPOINT_NAMES = {
  'GET /api/v1/me': 'Get current credential',
  'POST /api/v1/oauth/token': 'Create access token',

  'GET /api/v1/assets': 'List assets',
  'GET /api/v1/prices': 'Get prices',
  'GET /api/v1/prices/stream': 'Stream prices',

  'POST /api/v1/quotes': 'Request quotes',
  'GET /api/v1/quotes/requests/{quoteRequestId}': 'Get quote request',

  'GET /api/v1/orders': 'List orders',
  'POST /api/v1/orders': 'Place order',
  'GET /api/v1/orders/by-quote/{quoteId}': 'Get order by quote',
  'GET /api/v1/orders/{orderId}': 'Get order',
  'POST /api/v1/orders/{orderId}/cancel': 'Cancel order',

  'GET /api/v1/workspaces/{workspaceId}/trades': 'List trades',
  'GET /api/v1/workspaces/{workspaceId}/trades/{tradeId}': 'Get trade',
  'GET /api/v1/workspaces/{workspaceId}/trades/{tradeId}/settlement': 'Get trade settlement',
  'GET /api/v1/workspaces/{workspaceId}/trades/{tradeId}/settlement/obligations': 'List trade obligations',

  'GET /api/v1/workspaces/{workspaceId}/settlement/plan': 'Get settlement plan',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/settlement/movements': 'List movements',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/settlement/movements/{movementId}': 'Get movement',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/settlement/obligations': 'List obligations',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/settlement/obligations/{obligationId}': 'Get obligation',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/settlement/schedules': 'List schedules',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/settlement/windows': 'List windows',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/settlement/windows/{windowId}': 'Get window',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/settlement/windows/{windowId}/matches': 'List window matches',

  'GET /api/v1/workspaces/{workspaceId}/balances': 'Get balances',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/balances': 'Get account balances',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/credit': 'Get account credit',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/deposit-history': 'List deposits',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/deposit-instructions': 'Get deposit instructions',
  'GET /api/v1/workspaces/{workspaceId}/venue-accounts/{venueAccountId}/ledger': 'Get account ledger',
  'GET /api/v1/workspaces/{workspaceId}/venue-enablements': 'List venue accounts',
  'GET /api/v1/workspaces/{workspaceId}/capabilities': 'Get capabilities',
  'GET /api/v1/workspaces/{workspaceId}/fee-schedule': 'Get fee schedule',

  'GET /api/v1/workspaces/{workspaceId}/webhooks': 'List webhooks',
  'POST /api/v1/workspaces/{workspaceId}/webhooks': 'Create webhook',
  'GET /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}': 'Get webhook',
  'PATCH /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}': 'Update webhook',
  'DELETE /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}': 'Delete webhook',
  'GET /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}/deliveries': 'List deliveries',
  'POST /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}/deliveries': 'Send test delivery',
  'POST /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}/deliveries/{deliveryId}/retry': 'Retry delivery',
  'POST /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}/resume': 'Resume webhook',
  'POST /api/v1/workspaces/{workspaceId}/webhooks/{webhookId}/rotate': 'Rotate webhook secret',

  'POST /api/v1/batch': 'Batch reads',
};

const FORM = /^(List|Get|Create|Update|Delete|Place|Cancel|Request|Stream|Send|Retry|Resume|Rotate|Batch) \S+( \S+){0,3}$/;

export function endpointName(method, route) {
  const name = ENDPOINT_NAMES[`${method.toUpperCase()} ${route}`];
  if (!name) throw new Error(`ENDPOINT_NAME_MISSING ${method.toUpperCase()} ${route} (add it to scripts/endpoint-names.mjs)`);
  return name;
}

// Every operation has a name, every name an operation, each name fits the form and none repeats.
export function checkEndpointNames(operations) {
  const keys = new Set(operations.map(({ method, route }) => `${method.toUpperCase()} ${route}`));
  for (const key of keys) if (!ENDPOINT_NAMES[key]) throw new Error(`ENDPOINT_NAME_MISSING ${key} (add it to scripts/endpoint-names.mjs)`);
  for (const key of Object.keys(ENDPOINT_NAMES)) if (!keys.has(key)) throw new Error(`ENDPOINT_NAME_STALE ${key} (the spec no longer has it)`);
  const seen = new Set();
  for (const name of Object.values(ENDPOINT_NAMES)) {
    if (!FORM.test(name)) throw new Error(`ENDPOINT_NAME_FORM ${name}`);
    if (seen.has(name)) throw new Error(`ENDPOINT_NAME_DUPLICATE ${name}`);
    seen.add(name);
  }
}
