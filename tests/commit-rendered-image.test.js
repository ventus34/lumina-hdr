import test from 'node:test';
import assert from 'node:assert/strict';
import { commitRenderedImage } from '../src/app/commit-rendered-image.js';

test('a rendered image is published only after the renderer accepts its texture', () => {
  const previous = { name: 'previous' };
  let visible = previous;
  const image = { width: 2, height: 1, data: new Float32Array(8) };
  const calls = [];
  const renderer = { setImage(width, height, data) { calls.push(['upload', width, height, data]); } };

  commitRenderedImage(renderer, image, candidate => {
    calls.push(['commit']);
    visible = candidate;
  });

  assert.equal(visible, image);
  assert.deepEqual(calls, [['upload', 2, 1, image.data], ['commit']]);
});

test('a renderer upload failure preserves the previously visible image', () => {
  const previous = { name: 'previous' };
  let visible = previous;
  const renderer = { setImage() { throw new Error('GPU upload failed'); } };

  assert.throws(() => commitRenderedImage(renderer, { width: 1, height: 1, data: new Float32Array(4) }, candidate => {
    visible = candidate;
  }), /GPU upload failed/);
  assert.equal(visible, previous);
});
