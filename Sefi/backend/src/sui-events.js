/**
 * Sui Move event decoding/normalization for liquifi.
 *
 * Replaces the role of events.js (which decodes EVM topic0 signatures). Sui events
 * already carry a fully-qualified type string and a parsed JSON payload, so the work
 * here is: shorten the type to `module::Event`, decode byte-vector fields to utf8,
 * and provide fixed-point scaling helpers used by the deriver/agent.
 */

/**
 * `0xPKG::shield_executor::ShieldActivatedEvent` -> `shield_executor::ShieldActivatedEvent`.
 * Falls back to the last two `::` segments.
 */
export function shortEventName(typeRepr) {
  const repr = String(typeRepr || '');
  const parts = repr.split('::');
  if (parts.length >= 3) return `${parts[1]}::${parts[2]}`.replace(/<.*$/, '');
  return repr;
}

/** `0xPKG::shield_executor::ShieldActivatedEvent` -> `shield_executor`. */
export function moduleOf(typeRepr) {
  const parts = String(typeRepr || '').split('::');
  return parts.length >= 2 ? parts[1] : '';
}

/** `0xPKG::shield_executor::ShieldActivatedEvent` -> the package id (`0xPKG`). */
export function packageOf(typeRepr) {
  const parts = String(typeRepr || '').split('::');
  return parts.length >= 1 ? parts[0] : '';
}

/**
 * Move `vector<u8>` fields arrive as either a number array ([115,99,...]),
 * a comma string, or already-decoded text. Decode to utf8 best-effort.
 */
export function decodeByteVector(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    try {
      return Buffer.from(value.map((n) => Number(n) & 0xff)).toString('utf8');
    } catch {
      return '';
    }
  }
  if (typeof value === 'string') {
    // numeric csv like "115,99,97..."
    if (/^\d+(,\d+)*$/.test(value)) {
      try {
        return Buffer.from(value.split(',').map((n) => Number(n) & 0xff)).toString('utf8');
      } catch {
        return value;
      }
    }
    return value;
  }
  return String(value);
}

/** health_factor_x1000 (e.g. "900") -> 0.9 */
export function hfFromX1000(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n / 1000 : null;
}

/** collateral_price_usd_x1e6 (e.g. "98000000") -> 98.0 */
export function priceFromX1e6(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n / 1e6 : null;
}

/**
 * Normalize a raw GraphQL event node into a flat record for storage + downstream use.
 * @param {object} node  events.nodes[i] from sui-client.queryEvents
 * @param {string} sourceKey  manifest source key (e.g. 'liquidshield', 'scallop')
 */
export function normalizeEventNode(node, sourceKey) {
  const typeRepr = node?.contents?.type?.repr ?? '';
  const json = node?.contents?.json ?? {};
  return {
    sourceKey,
    typeRepr,
    eventName: shortEventName(typeRepr),
    module: moduleOf(typeRepr),
    packageId: packageOf(typeRepr),
    digest: node?.transaction?.digest ?? null,
    sender: node?.sender?.address ?? null,
    timestamp: node?.timestamp ?? null, // ISO string
    json,
  };
}
