import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { planSharedFetch } from '../src/shared-fetch.js';

const app = buildApp();
const url = '/shared-fetch-plan';

function sharedFetchPlan(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

test('overlapping client demands merge into one capped fetch', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [
      { id: 'a', start: 0, end: 99 },
      { id: 'b', start: 50, end: 199 },
    ],
    chunkBytes: 300,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.demandsCount, 1);
  assert.deepEqual(body.demands, [{ start: 0, end: 199 }]);
  assert.equal(body.fetchesCount, 1);
  assert.deepEqual(body.fetches, [
    { index: 1, start: 0, end: 199, bytes: 200, rangeHeader: 'bytes=0-199' },
  ]);
  assert.deepEqual(body.bytes, { demanded: 200, fetched: 200, extra: 0 });
});

test('demand longer than the cap is split at chunkBytes boundaries', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [{ id: 'a', start: 0, end: 249 }],
    chunkBytes: 100,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end, f.bytes]),
    [
      [0, 99, 100],
      [100, 199, 100],
      [200, 249, 50],
    ],
  );
  assert.deepEqual(
    body.fetches.map((f) => f.rangeHeader),
    ['bytes=0-99', 'bytes=100-199', 'bytes=200-249'],
  );
  assert.equal(body.bytes.demanded, 250);
  assert.equal(body.bytes.fetched, 250);
  assert.equal(body.bytes.extra, 0);
});

test('a gap within the threshold is bridged when the merged fetch fits', async () => {
  // Demands [0,79] and [100,149]: gap bytes 80..99 (20 bytes) == maxGapBytes,
  // merged length 150 == chunkBytes -> one bridged fetch.
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [
      { id: 'a', start: 0, end: 79 },
      { id: 'b', start: 100, end: 149 },
    ],
    chunkBytes: 150,
    maxGapBytes: 20,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.demandsCount, 2);
  assert.equal(body.fetchesCount, 1);
  assert.deepEqual(body.fetches[0], {
    index: 1,
    start: 0,
    end: 149,
    bytes: 150,
    rangeHeader: 'bytes=0-149',
  });
  assert.deepEqual(body.bytes, { demanded: 130, fetched: 150, extra: 20 });

  // Each client only sees its own bytes within the shared fetch.
  assert.deepEqual(body.clients[0].coverage, [
    { fetchIndex: 1, start: 0, end: 79, bytes: 80 },
  ]);
  assert.deepEqual(body.clients[1].coverage, [
    { fetchIndex: 1, start: 100, end: 149, bytes: 50 },
  ]);
});

test('a gap above the threshold is not bridged', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [
      { id: 'a', start: 0, end: 79 },
      { id: 'b', start: 100, end: 149 },
    ],
    chunkBytes: 1000,
    maxGapBytes: 19,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end]),
    [
      [0, 79],
      [100, 149],
    ],
  );
  assert.equal(body.bytes.extra, 0);
});

test('a gap within the threshold that would overflow the cap is not bridged', async () => {
  // Same 20-byte gap as above, but bridging would yield 150 > chunkBytes 140.
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [
      { id: 'a', start: 0, end: 79 },
      { id: 'b', start: 100, end: 149 },
    ],
    chunkBytes: 140,
    maxGapBytes: 20,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end, f.bytes]),
    [
      [0, 79, 80],
      [100, 149, 50],
    ],
  );
  assert.equal(body.bytes.fetched, 130);
  assert.equal(body.bytes.extra, 0);
});

test('adjacent demands merge before splitting, never counting a gap', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [
      { id: 'a', start: 0, end: 49 },
      { id: 'b', start: 50, end: 149 },
    ],
    chunkBytes: 100,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.demandsCount, 1);
  assert.deepEqual(body.demands, [{ start: 0, end: 149 }]);
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end]),
    [
      [0, 99],
      [100, 149],
    ],
  );
  assert.equal(body.bytes.extra, 0);
});

test('chunks across a demand boundary do not merge across chunks', async () => {
  // [0,99] split at 100 -> [0,99]; [120,199] -> [120,199]. Gap is 20 but
  // merging 0..199 is 200 bytes > 150 cap; even the 100-byte first chunk
  // cannot extend: 0..199 would overflow, so both fetches stay separate.
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [
      { id: 'a', start: 0, end: 99 },
      { id: 'b', start: 120, end: 199 },
    ],
    chunkBytes: 150,
    maxGapBytes: 100,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end]),
    [
      [0, 99],
      [120, 199],
    ],
  );
});

test('a client demand spanning multiple fetches lists one coverage entry per fetch', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [
      { id: 'a', start: 0, end: 249 },
      { id: 'b', start: 320, end: 349 },
    ],
    chunkBytes: 100,
    // Gap between the last chunk of a ([200,249]) and b ([320,349]) is 70:
    // bridging would be 150 bytes (200..349) > 100, so never bridged.
    maxGapBytes: 100,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(
    body.fetches.map((f) => [f.start, f.end]),
    [
      [0, 99],
      [100, 199],
      [200, 249],
      [320, 349],
    ],
  );
  const clientA = body.clients.find((c) => c.id === 'a');
  assert.equal(clientA.bytes, 250);
  assert.deepEqual(clientA.coverage, [
    { fetchIndex: 1, start: 0, end: 99, bytes: 100 },
    { fetchIndex: 2, start: 100, end: 199, bytes: 100 },
    { fetchIndex: 3, start: 200, end: 249, bytes: 50 },
  ]);
  const clientB = body.clients.find((c) => c.id === 'b');
  assert.deepEqual(clientB.coverage, [
    { fetchIndex: 4, start: 320, end: 349, bytes: 30 },
  ]);
  assert.equal(body.bytes.demanded, 280);
  assert.equal(body.bytes.fetched, 280);
});

test('client results stay in input order regardless of offsets', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [
      { id: 'zeta', start: 500, end: 599 },
      { id: 'alpha', start: 0, end: 99 },
    ],
    chunkBytes: 1000,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.json().clients.map((c) => c.id),
    ['zeta', 'alpha'],
  );
});

test('empty client list yields an empty plan', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [],
    chunkBytes: 100,
    maxGapBytes: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.demandsCount, 0);
  assert.equal(body.fetchesCount, 0);
  assert.deepEqual(body.fetches, []);
  assert.deepEqual(body.clients, []);
  assert.deepEqual(body.bytes, { demanded: 0, fetched: 0, extra: 0 });
});

test('empty resource yields an empty plan even with demands present', async () => {
  const res = await sharedFetchPlan({
    size: 0,
    clients: [{ id: 'a', start: 0, end: 0 }],
    chunkBytes: 100,
    maxGapBytes: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.fetchesCount, 0);
  assert.deepEqual(body.fetches, []);
  assert.equal(body.clientsCount, 0);
});

test('duplicate client ids are rejected', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [
      { id: 'a', start: 0, end: 9 },
      { id: 'a', start: 10, end: 19 },
    ],
    chunkBytes: 100,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'DUPLICATE_CLIENT_ID');
});

test('blank client ids are rejected', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [{ id: '   ', start: 0, end: 9 }],
    chunkBytes: 100,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CLIENT_ID');
});

test('reversed intervals are rejected', async () => {
  const res = await sharedFetchPlan({
    size: 1000,
    clients: [{ id: 'a', start: 50, end: 10 }],
    chunkBytes: 100,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CLIENT_RANGE');
});

test('intervals reaching past the resource are rejected', async () => {
  const res = await sharedFetchPlan({
    size: 100,
    clients: [{ id: 'a', start: 0, end: 100 }],
    chunkBytes: 100,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CLIENT_RANGE_OUT_OF_BOUNDS');
});

test('non-safe-integer values are rejected by the strict validator', async () => {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      size: 1000,
      clients: [{ id: 'a', start: '0', end: 9 }],
      chunkBytes: 100,
      maxGapBytes: 0,
    }),
  });
  assert.equal(res.statusCode, 400);
});

test('invalid chunkBytes and maxGapBytes are rejected', async () => {
  let res = await sharedFetchPlan({
    size: 1000,
    clients: [],
    chunkBytes: 0,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 400);

  res = await sharedFetchPlan({
    size: 1000,
    clients: [],
    chunkBytes: 100,
    maxGapBytes: -1,
  });
  assert.equal(res.statusCode, 400);
});

test('planner-level validation codes (bypassing HTTP schema)', () => {
  for (const [options, code] of [
    [{ size: 1000, clients: [], chunkBytes: 0, maxGapBytes: 0 }, 'INVALID_CHUNK_BYTES'],
    [{ size: 1000, clients: [], chunkBytes: 100, maxGapBytes: -1 }, 'INVALID_MAX_GAP_BYTES'],
    [{ size: -1, clients: [], chunkBytes: 100, maxGapBytes: 0 }, 'INVALID_SIZE'],
    [{ size: 1000, clients: 'nope', chunkBytes: 100, maxGapBytes: 0 }, 'INVALID_CLIENTS'],
  ]) {
    assert.equal(planSharedFetch(options).code, code);
  }
});

test('unknown properties are rejected by the strict validator', async () => {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      size: 1000,
      clients: [{ id: 'a', start: 0, end: 9, extra: 1 }],
      chunkBytes: 100,
      maxGapBytes: 0,
    }),
  });
  assert.equal(res.statusCode, 400);
});

test('end-to-end bridge example: three parallel clients, one shared fetch', async () => {
  const res = await sharedFetchPlan({
    size: 10000,
    clients: [
      { id: 'ios-1', start: 0, end: 999 },
      { id: 'tv-7', start: 950, end: 1999 },
      { id: 'web-3', start: 2100, end: 2299 },
    ],
    chunkBytes: 2500,
    maxGapBytes: 100,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // First two demands overlap and merge into [0,1999]; the third starts at
  // 2100, a 100-byte gap exactly at the threshold; merged length 2300 fits
  // the 2500 cap, so the whole thing is a single fetch.
  assert.equal(body.fetchesCount, 1);
  assert.deepEqual(body.fetches[0], {
    index: 1,
    start: 0,
    end: 2299,
    bytes: 2300,
    rangeHeader: 'bytes=0-2299',
  });
  assert.deepEqual(body.bytes, { demanded: 2200, fetched: 2300, extra: 100 });
  assert.deepEqual(
    body.clients.map((c) => [c.id, c.coverage[0].start, c.coverage[0].end]),
    [
      ['ios-1', 0, 999],
      ['tv-7', 950, 1999],
      ['web-3', 2100, 2299],
    ],
  );
});
