import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDecodedInfo } from '../src/ui/image-metadata.js';

test('AVIF metadata distinguishes unknown source HDR from a known SDR source', () => {
  const unknown = formatDecodedInfo('sample.avif', {
    sourceHDR: false,
    sourceHDRKnown: false,
    decodedHDR: false
  });
  assert.equal(unknown.format, 'AVIF (source HDR unknown; decoded SDR)');
  assert.equal(unknown.sourceHDRKnown, false);
  assert.equal(unknown.depth, '8-bit Integer (SDR)');
  assert.equal(formatDecodedInfo('legacy.avif', { decodedHDR: false }).sourceHDRKnown, false);

  const knownSdr = formatDecodedInfo('sample.avif', {
    sourceHDR: false,
    sourceHDRKnown: true,
    decodedHDR: false
  });
  assert.equal(knownSdr.format, 'AVIF (SDR)');
  assert.equal(formatDecodedInfo('source.avif', {
    sourceHDR: true,
    sourceHDRKnown: true,
    decodedHDR: false
  }).format, 'AVIF (HDR source; decoded SDR fallback)');
});

test('metadata uses available sample depth and avoids calling RGBE floats', () => {
  assert.equal(formatDecodedInfo('sample.jxr', { sourceHDR: false, bitDepth: '16' }).depth, '16-bit Integer (SDR)');
  assert.equal(formatDecodedInfo('sample.wdp', { sourceHDR: true, bitDepth: '16Float' }).depth, '16-bit Float (HDR)');
  assert.equal(formatDecodedInfo('sample.hdr', { sourceHDR: true }).depth, '32-bit RGBE (HDR)');
  assert.equal(formatDecodedInfo('sample.jxr', { sourceHDR: false }).depth, 'Integer samples (SDR)');
});
