import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestOperationManager } from '../src/app/latest-operation.js';

test('starting a new viewer request aborts the old request and makes only the new request current', () => {
  const operations = createLatestOperationManager();
  const first = operations.begin();
  const second = operations.begin();

  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.signal.aborted, false);
  assert.equal(second.isCurrent(), true);
  assert.ok(second.id > first.id);
});

test('finishing a stale request cannot clear the current request', () => {
  const operations = createLatestOperationManager();
  const first = operations.begin();
  const second = operations.begin();

  assert.equal(operations.finish(first), false);
  assert.equal(operations.current, second);
  assert.equal(second.isCurrent(), true);

  assert.equal(operations.finish(second), true);
  assert.equal(operations.current, null);
  assert.equal(second.isCurrent(), false);
});
