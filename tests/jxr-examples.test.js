import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeImageBuffer } from '../src/services/decode-image.js';

const directory = new URL('../docs/examples/', import.meta.url);
const scenes = [
  'Forza_Horizon_6_native_hdr_scene1.jxr',
  'Ghost_of_Tsushima_native_hdr_scene1.jxr',
  'Forza_Horizon_6_native_hdr_scene2.jxr',
  'Ghost_of_Tsushima_native_hdr_scene1.jxr',
  'Indiana_Jones_And_The_Great_Circle_native_hdr_scene1.jxr',
  'Neverness_To_Everness_rtx_hdr_scene1.jxr'
];

test('real JXR examples switch between half/float codecs without reading stale heap alpha', {
  skip: scenes.every(name => existsSync(new URL(name, directory))) ? false : 'Optional game example dataset is not installed'
}, async () => {
  let ghostHash;
  for (const name of scenes) {
    const image = await decodeImageBuffer(readFileSync(new URL(name, directory)), name, { type: 'application/octet-stream' });
    assert.equal(image.width, 3840, name);
    assert.equal(image.height, 2160, name);
    assert.equal(image.alpha, 'opaque', name);
    assert.equal(image.sourceAlphaDecoded, false, name);
    for (let i = 3; i < image.data.length; i += 4) assert.equal(image.data[i], 1, name);
    if (name.startsWith('Ghost')) {
      const hash = createHash('sha256').update(new Uint8Array(image.data.buffer)).digest('hex');
      if (ghostHash) assert.equal(hash, ghostHash, 'RGB output must be stable after decoding a half-float image');
      ghostHash = hash;
    }
  }
});
