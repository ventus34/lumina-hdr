import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportToImageUV, panDeltaForClientDelta, panForZoom } from '../src/ui/viewport-math.js';

const dimensions = { width: 800, height: 400, imageWidth: 400, imageHeight: 400, previewMode: 'hdr' };
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }

test('HUD source coordinate uses the shader pan direction on both axes', () => {
  const uv = viewportToImageUV({ ...dimensions, x: 400, y: 200, panX: 0.1, panY: 0.2 });
  near(uv.u, 0.4); near(uv.v, 0.3);
});
test('letterboxing and both comparison panels address the same source pixels', () => {
  near(viewportToImageUV({ ...dimensions, x: 200, y: 0 }).u, 0);
  const side = { ...dimensions, previewMode: 'side-by-side' };
  const left = viewportToImageUV({ ...side, x: 100, y: 100 });
  const right = viewportToImageUV({ ...side, x: 500, y: 100 });
  assert.deepEqual(left, right);
});
test('drag distance moves a source pixel by the same client-pixel distance', () => {
  const camera = { zoom: 2, panX: 0.15, panY: -0.1 };
  const start = viewportToImageUV({ ...dimensions, ...camera, x: 350, y: 150 });
  const delta = panDeltaForClientDelta({ ...dimensions, zoom: camera.zoom, dx: 60, dy: 35 });
  const end = viewportToImageUV({ ...dimensions, ...camera, x: 410, y: 185,
    panX: camera.panX + delta.x, panY: camera.panY + delta.y });
  near(end.u, start.u); near(end.v, start.v);
});
test('wheel zoom preserves the source pixel under the cursor in every layout', () => {
  for (const previewMode of ['hdr', 'split', 'split-h', 'side-by-side', 'blend']) {
    const layout = { ...dimensions, previewMode };
    const start = viewportToImageUV({ ...layout, x: 570, y: 70, zoom: 1.3, panX: -0.1, panY: 0.08 });
    const pan = panForZoom({ ...layout, x: 570, y: 70, oldZoom: 1.3, newZoom: 2.6, panX: -0.1, panY: 0.08 });
    const end = viewportToImageUV({ ...layout, x: 570, y: 70, zoom: 2.6, panX: pan.x, panY: pan.y });
    near(start.u, end.u); near(start.v, end.v);
  }
});
test('hidden or zero-sized viewport never produces non-finite camera coordinates', () => {
  assert.equal(viewportToImageUV({ ...dimensions, width: 0, x: 0, y: 0 }), null);
  assert.deepEqual(panDeltaForClientDelta({ ...dimensions, height: 0, dx: 10, dy: 10 }), { x: 0, y: 0 });
});
