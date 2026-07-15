import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTsModule } from './helpers/load-ts-module.mjs';

function selectorFixture(kind) {
  return {
    closest(selector) {
      const normalized = String(selector).toLowerCase();
      if (kind === 'search-result' && /pingrid|search.?result/.test(normalized)) {
        return { selector };
      }
      if (kind === 'recommendation' && /related|recommend|more.?like/.test(normalized)) {
        return { selector };
      }
      return null;
    }
  };
}

test('Pinterest source classifier separates search results from recommendations only on search pages', async () => {
  const {
    classifyPinterestImage
  } = await loadTsModule('src/content/image-classifier.ts');

  const searchCard = selectorFixture('search-result');
  const recommendationCard = selectorFixture('recommendation');
  const ordinaryCard = selectorFixture('page');

  assert.equal(
    classifyPinterestImage('https://www.pinterest.com/search/pins/?q=desk', searchCard),
    'search-result'
  );
  assert.equal(
    classifyPinterestImage('https://www.pinterest.com/search/pins/?q=desk', recommendationCard),
    'recommendation'
  );
  assert.equal(
    classifyPinterestImage('https://www.pinterest.com/pin/123/', ordinaryCard),
    'page'
  );
  assert.equal(
    classifyPinterestImage('https://www.pinterest.com/pin/123/', recommendationCard),
    'page',
    'recommendation classification must not change normal-page auto eligibility'
  );
  assert.equal(
    classifyPinterestImage('https://www.pinterest.com/search/pins/?q=desk', ordinaryCard),
    'recommendation',
    'unknown search containers stay in the page session but fail closed for automatic eligibility'
  );
});

test('automatic eligible windows exclude interleaved recommendations without mutating the page session', async () => {
  const { buildAutoEligibleWindow } = await loadTsModule('src/content/eligible-window.ts');
  const records = [
    { id: 'result-1', source: 'search-result' },
    { id: 'recommendation-1', source: 'recommendation' },
    { id: 'result-2', source: 'search-result' },
    { id: 'recommendation-2', source: 'recommendation' },
    { id: 'result-3', source: 'search-result' },
    { id: 'result-4', source: 'search-result' }
  ];

  const window = buildAutoEligibleWindow(records, {
    pageUrl: 'https://www.pinterest.com/search/pins/?q=desk',
    baseOffset: 0,
    cursor: 0,
    limit: 3,
    exhausted: false
  });

  assert.deepEqual(window.records.map((record) => record.id), [
    'result-1',
    'result-2',
    'result-3'
  ]);
  assert.equal(window.startOffset, 0);
  assert.equal(window.endOffset, 3);
  assert.equal(window.finalWindow, false);
  assert.equal(records.length, 6, 'recommendations remain available to overlays/manual/single flows');
});

test('an exhausted 80-result tail is emitted as a partial batch and is never padded by recommendations', async () => {
  const { buildAutoEligibleWindow } = await loadTsModule('src/content/eligible-window.ts');
  const records = Array.from({ length: 80 }, (_, index) => ({
    id: `result-${index + 1}`,
    source: 'search-result'
  })).concat(Array.from({ length: 30 }, (_, index) => ({
    id: `recommendation-${index + 1}`,
    source: 'recommendation'
  })));

  const window = buildAutoEligibleWindow(records, {
    pageUrl: 'https://www.pinterest.com/search/pins/?q=desk',
    baseOffset: 0,
    cursor: 0,
    limit: 100,
    exhausted: true
  });

  assert.equal(window.records.length, 80);
  assert.equal(window.records.every((record) => record.source === 'search-result'), true);
  assert.equal(window.startOffset, 0);
  assert.equal(window.endOffset, 80);
  assert.equal(window.finalWindow, true);
});

test('ten compacted windows preserve absolute ordinals and retain at most two batch limits of references', async () => {
  const { compactAutoSessionWindow } = await loadTsModule('src/content/session-window.ts');
  const limit = 10;
  let records = [];
  let baseOffset = 0;
  const emittedOrdinals = [];

  for (let batch = 0; batch < 10; batch++) {
    const batchStart = batch * limit;
    for (let index = 0; index < limit; index++) {
      const absoluteOrdinal = batchStart + index;
      emittedOrdinals.push(absoluteOrdinal);
      records.push({
        id: `result-${absoluteOrdinal}`,
        source: 'search-result',
        absoluteOrdinal,
        connected: true,
        element: { id: `element-${absoluteOrdinal}` },
        controls: { id: `controls-${absoluteOrdinal}` }
      });
      records.push({
        id: `recommendation-${absoluteOrdinal}`,
        source: 'recommendation',
        connected: true,
        element: { id: `recommendation-element-${absoluteOrdinal}` },
        controls: { id: `recommendation-controls-${absoluteOrdinal}` }
      });
    }

    const result = compactAutoSessionWindow(records, {
      settledThroughOffset: batchStart + limit,
      autoBatchLimit: limit
    });
    records = result.records;
    baseOffset = result.baseOffset;

    assert.equal(baseOffset, batchStart + limit);
    assert.ok(records.length <= 2 * limit, `batch ${batch + 1} retained ${records.length} records`);
    assert.equal(
      records.some((record) => result.removedIds.includes(record.id)),
      false,
      'removed image/control references must not remain reachable from the compacted window'
    );
  }

  assert.deepEqual(emittedOrdinals, Array.from({ length: 100 }, (_, index) => index));
  assert.equal(new Set(emittedOrdinals).size, 100, 'no eligible image may repeat across windows');

  const incompleteEligible = Array.from({ length: 5 }, (_, index) => ({
    id: `future-${baseOffset + index}`,
    source: 'search-result',
    absoluteOrdinal: baseOffset + index,
    connected: true,
    element: {},
    controls: {}
  }));
  const disconnected = {
    id: 'disconnected-recommendation',
    source: 'recommendation',
    connected: false,
    element: {},
    controls: {}
  };
  const finalResult = compactAutoSessionWindow([...records, ...incompleteEligible, disconnected], {
    settledThroughOffset: baseOffset,
    autoBatchLimit: limit
  });

  assert.deepEqual(
    finalResult.records.filter((record) => record.source === 'search-result').map((record) => record.id),
    incompleteEligible.map((record) => record.id),
    'unprocessed eligible records are never pruned'
  );
  assert.equal(finalResult.records.some((record) => record.id === disconnected.id), false);
  assert.ok(finalResult.records.length <= 2 * limit);
});

test('compaction removes recommendations before a settled result but retains those after it', async () => {
  const { compactAutoSessionWindow } = await loadTsModule('src/content/session-window.ts');
  const records = [
    { id: 'before', source: 'recommendation', absoluteOrdinal: 0, connected: true },
    { id: 'settled', source: 'search-result', absoluteOrdinal: 0, connected: true },
    { id: 'after', source: 'recommendation', absoluteOrdinal: 1, connected: true },
    { id: 'future', source: 'search-result', absoluteOrdinal: 1, connected: true }
  ];

  const result = compactAutoSessionWindow(records, {
    settledThroughOffset: 1,
    autoBatchLimit: 10
  });

  assert.deepEqual(result.removedIds, ['before', 'settled']);
  assert.deepEqual(result.records.map((record) => record.id), ['after', 'future']);
});
