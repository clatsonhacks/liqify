/**
 * Sui data-access client for the liquifi plane.
 *
 * Standardizes on the Sui GraphQL RPC (JSON-RPC is deprecated, deactivated 2026-07).
 * Replaces the role of mirror-client.js for the Sui chain: event paging + object reads.
 *
 * Verified against testnet (https://graphql.testnet.sui.io/graphql):
 *   - EventFilter inputFields: afterCheckpoint, atCheckpoint, beforeCheckpoint, sender, module, type
 *     (module = "package" or "package::module"; module and type CANNOT be combined)
 *   - event node shape: contents { type { repr } json } timestamp sender { address } transaction { digest }
 *   - pageInfo { hasNextPage endCursor }  — endCursor is an opaque ~32-char string
 */

import { SuiGraphQLClient } from '@mysten/sui/graphql';

const EVENTS_QUERY = `
  query LiquifiEvents($filter: EventFilter!, $first: Int!, $after: String) {
    events(filter: $filter, first: $first, after: $after) {
      nodes {
        contents { type { repr } json }
        timestamp
        sender { address }
        transaction { digest }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const OBJECT_QUERY = `
  query LiquifiObject($address: SuiAddress!) {
    object(address: $address) {
      address
      version
      asMoveObject { contents { type { repr } json } }
    }
  }
`;

export class SuiClient {
  /**
   * @param {object} opts
   * @param {string} opts.url     GraphQL endpoint (cfg.suiGraphqlUrl)
   * @param {function} [opts.fetchImpl]
   */
  constructor({ url, fetchImpl = fetch }) {
    if (!url) throw new Error('SuiClient requires a GraphQL url');
    this.url = url;
    this.client = new SuiGraphQLClient({ url, fetch: fetchImpl });
  }

  /**
   * Page one batch of events for a module/type filter.
   * @param {object} args
   * @param {string} [args.module]  package or package::module (mutually exclusive with type)
   * @param {string} [args.type]    fully-qualified event type (mutually exclusive with module)
   * @param {string|null} [args.after]  opaque endCursor from a previous page
   * @param {number} [args.first]   page size (default 50)
   * @returns {Promise<{nodes: Array, endCursor: string|null, hasNextPage: boolean}>}
   */
  async queryEvents({ module, type, after = null, first = 50 }) {
    if (module && type) {
      throw new Error('queryEvents: `module` and `type` cannot be combined in one filter');
    }
    if (!module && !type) {
      throw new Error('queryEvents: provide either `module` or `type`');
    }
    const filter = module ? { module } : { type };
    const res = await this.client.query({
      query: EVENTS_QUERY,
      variables: { filter, first, after },
    });
    if (res.errors && res.errors.length > 0) {
      throw new Error(`Sui GraphQL events error: ${JSON.stringify(res.errors).slice(0, 400)}`);
    }
    const ev = res.data?.events;
    return {
      nodes: ev?.nodes ?? [],
      endCursor: ev?.pageInfo?.endCursor ?? null,
      hasNextPage: Boolean(ev?.pageInfo?.hasNextPage),
    };
  }

  /**
   * Read the latest Move object contents (JSON) for live state reads
   * (vault, snapshot, policy, etc.).
   * @param {string} address object id
   * @returns {Promise<{address:string, version:any, type:string|null, json:any}|null>}
   */
  async getObjectJson(address) {
    if (!address) return null;
    const res = await this.client.query({
      query: OBJECT_QUERY,
      variables: { address },
    });
    if (res.errors && res.errors.length > 0) {
      throw new Error(`Sui GraphQL object error: ${JSON.stringify(res.errors).slice(0, 400)}`);
    }
    const obj = res.data?.object;
    if (!obj) return null;
    return {
      address: obj.address,
      version: obj.version,
      type: obj.asMoveObject?.contents?.type?.repr ?? null,
      json: obj.asMoveObject?.contents?.json ?? null,
    };
  }
}
