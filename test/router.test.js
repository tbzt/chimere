import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, DEFAULT_ROUTE } from '../src/router.js';

test('known routes are parsed from the hash', () => {
  assert.equal(parseRoute('#/bibliotheque'), 'bibliotheque');
  assert.equal(parseRoute('#/reglages?threads=4'), 'reglages');
  assert.equal(parseRoute('#mashups'), 'mashups');
  assert.equal(parseRoute('#/SEPARER/extra'), 'separer');
});

test('empty or unknown hash falls back to the default view', () => {
  assert.equal(parseRoute(''), DEFAULT_ROUTE);
  assert.equal(parseRoute('#/'), DEFAULT_ROUTE);
  assert.equal(parseRoute('#/nope'), DEFAULT_ROUTE);
  assert.equal(parseRoute(undefined), DEFAULT_ROUTE);
});
