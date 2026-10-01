// Shared origin-fetch planner.
//
// When several parallel clients ask for overlapping pieces of the same
// resource, a cache/edge node can collapse their requests into a small set of
// upstream Range fetches shared by every client. Given the resource size, one
// closed interval per client, a per-fetch byte cap and the largest gap worth
// bridging, this module plans those shared fetches:
//
//   1. merge every client's demanded interval (overlapping or adjacent) into
//      a de-duplicated demand list;
//   2. split each demand into candidate fetches of at most `chunkBytes`;
//   3. walk the candidates left to right, bridging two neighbours only when
//      the gap between them is at most `maxGapBytes` and the merged length
//      stays within `chunkBytes`.
//
// All intervals are closed (both endpoints inclusive) and byte offsets count
// from zero, matching RFC 9110 byte-range semantics.

export const MAX_CLIENTS = 10000;
export const MAX_CLIENT_ID_LENGTH = 256;

/**
 * Plan the shared origin fetches covering every client's demanded bytes.
 *
 * @returns a result object with `statusCode` 200 carrying the fetch list,
 *          per-client coverage and byte accounting, or a 400 result
 *          describing the first validation failure.
 */
export function planSharedFetch(options) {
  const { size, clients, chunkBytes, maxGapBytes } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    return fail('INVALID_CHUNK_BYTES', 'chunkBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxGapBytes) || maxGapBytes < 0) {
    return fail(
      'INVALID_MAX_GAP_BYTES',
      'maxGapBytes must be a non-negative safe integer',
    );
  }
  if (!Array.isArray(clients)) {
    return fail('INVALID_CLIENTS', 'clients must be an array of {id, start, end} demands');
  }
  if (clients.length > MAX_CLIENTS) {
    return fail(
      'TOO_MANY_CLIENTS',
      `clients carries ${clients.length} demands; at most ${MAX_CLIENTS} are allowed`,
    );
  }

  // An empty resource has no bytes anyone can demand: empty plan, no matter
  // whether the client list is empty or not.
  if (size === 0) {
    return {
      statusCode: 200,
      resource: { size },
      params: { chunkBytes, maxGapBytes },
      demandsCount: 0,
      demands: [],
      clientsCount: 0,
      clients: [],
      fetchesCount: 0,
      fetches: [],
      bytes: { demanded: 0, fetched: 0, extra: 0 },
    };
  }

  const seenIds = new Set();
  const demands = [];
  for (let i = 0; i < clients.length; i += 1) {
    const client = clients[i];
    if (client === null || typeof client !== 'object' || Array.isArray(client)) {
      return fail('INVALID_CLIENT', `clients[${i}] must be an object with id, start and end`);
    }
    const { id, start, end } = client;
    if (typeof id !== 'string' || id.trim().length === 0) {
      return fail(
        'INVALID_CLIENT_ID',
        `clients[${i}].id must be a non-empty string`,
      );
    }
    if (id.length > MAX_CLIENT_ID_LENGTH) {
      return fail(
        'INVALID_CLIENT_ID',
        `clients[${i}].id must be at most ${MAX_CLIENT_ID_LENGTH} characters`,
      );
    }
    if (seenIds.has(id)) {
      return fail('DUPLICATE_CLIENT_ID', `duplicate client id ${JSON.stringify(id)}`);
    }
    seenIds.add(id);

    if (!Number.isSafeInteger(start) || start < 0) {
      return fail(
        'INVALID_CLIENT_RANGE',
        `clients[${i}].start must be a non-negative safe integer`,
      );
    }
    if (!Number.isSafeInteger(end) || end < 0) {
      return fail(
        'INVALID_CLIENT_RANGE',
        `clients[${i}].end must be a non-negative safe integer`,
      );
    }
    if (start > end) {
      return fail(
        'INVALID_CLIENT_RANGE',
        `clients[${i}] has start ${start} after end ${end}`,
      );
    }
    if (end >= size) {
      return fail(
        'CLIENT_RANGE_OUT_OF_BOUNDS',
        `clients[${i}] end ${end} lies outside the ${size}-byte resource`,
      );
    }
    demands.push({ id, start, end });
  }

  // Empty resource or no demands: nothing to fetch.
  if (demands.length === 0) {
    return {
      statusCode: 200,
      resource: { size },
      params: { chunkBytes, maxGapBytes },
      demandsCount: 0,
      demands: [],
      clientsCount: 0,
      clients: [],
      fetchesCount: 0,
      fetches: [],
      bytes: { demanded: 0, fetched: 0, extra: 0 },
    };
  }

  // Step 1: merge overlapping or adjacent demands. Union size is the
  // de-duplicated demand; overlapping bytes are counted once.
  const mergedDemands = mergeIntervals(demands);
  const demandedBytes = mergedDemands.reduce(
    (sum, interval) => sum + (interval.end - interval.start + 1),
    0,
  );

  // Step 2: split each demand into aligned chunks of at most chunkBytes.
  const candidates = [];
  for (const demand of mergedDemands) {
    const length = demand.end - demand.start + 1;
    const chunks = Math.ceil(length / chunkBytes);
    for (let c = 0; c < chunks; c += 1) {
      const start = demand.start + c * chunkBytes;
      const end = Math.min(start + chunkBytes - 1, demand.end);
      candidates.push({ start, end });
    }
  }

  // Step 3: left-to-right bridge. A candidate joins the running fetch when the
  // gap is small enough and the merged closed interval stays within the cap;
  // otherwise the running fetch is sealed and a new one begins.
  const fetches = [];
  let current = null;
  for (const candidate of candidates) {
    if (current === null) {
      current = { start: candidate.start, end: candidate.end };
      continue;
    }
    const gap = candidate.start - current.end - 1;
    const mergedLength = candidate.end - current.start + 1;
    if (gap >= 0 && gap <= maxGapBytes && mergedLength <= chunkBytes) {
      current.end = candidate.end;
    } else {
      fetches.push(current);
      current = { start: candidate.start, end: candidate.end };
    }
  }
  if (current !== null) fetches.push(current);

  const indexedFetches = fetches.map((fetchRange, index) => ({
    index: index + 1,
    start: fetchRange.start,
    end: fetchRange.end,
    bytes: fetchRange.end - fetchRange.start + 1,
    rangeHeader: `bytes=${fetchRange.start}-${fetchRange.end}`,
  }));

  const fetchedBytes = indexedFetches.reduce((sum, fetchRange) => sum + fetchRange.bytes, 0);

  // Per-client view, kept in input order: one entry per fetch that actually
  // intersects that client's demand, with the exact bytes of the client's
  // interval the fetch covers. The entries are ascending, never overlap and
  // their union is exactly the client's demand.
  const clientResults = demands.map(({ id, start, end }) => {
    const coverage = [];
    for (const fetchRange of indexedFetches) {
      const startCovered = Math.max(start, fetchRange.start);
      const endCovered = Math.min(end, fetchRange.end);
      if (startCovered <= endCovered) {
        coverage.push({
          fetchIndex: fetchRange.index,
          start: startCovered,
          end: endCovered,
          bytes: endCovered - startCovered + 1,
        });
      }
    }
    return {
      id,
      start,
      end,
      bytes: end - start + 1,
      coverage,
    };
  });

  return {
    statusCode: 200,
    resource: { size },
    params: { chunkBytes, maxGapBytes },
    demandsCount: mergedDemands.length,
    demands: mergedDemands,
    clientsCount: clientResults.length,
    clients: clientResults,
    fetchesCount: indexedFetches.length,
    fetches: indexedFetches,
    bytes: {
      demanded: demandedBytes,
      fetched: fetchedBytes,
      extra: fetchedBytes - demandedBytes,
    },
  };
}

/**
 * Sort intervals by start offset and merge overlapping or adjacent ones
 * ([0-9] and [10-19] are adjacent: no byte sits between them).
 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
