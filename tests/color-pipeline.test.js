import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGrade,
  convertPrimaries,
  decodeTransfer,
  encodeSdrChannel,
  encodeTransfer,
  linearToSrgb,
  renderSdrRgb,
  srgbToLinear,
  toneMapRgb
} from '../src/color/pipeline.js';

test('sRGB transfer round-trips known encoded samples and leaves alpha outside the transform', () => {
  const encoded = 128 / 255;
  const linear = srgbToLinear(encoded);
  assert.ok(Math.abs(linear - 0.2158605) < 1e-7);
  assert.ok(Math.abs(linearToSrgb(linear) - encoded) < 1e-7);
  assert.equal(srgbToLinear(0.04045), 0.0031308049535603713);
});

test('PQ uses an absolute 80-nit app unit and HLG uses a fixed peak scale', () => {
  const pq40 = encodeTransfer(0.5, 'pq', { referenceWhiteNits: 80 });
  assert.ok(Math.abs(decodeTransfer(pq40, 'pq', { referenceWhiteNits: 80 }) - 0.5) < 1e-8);
  assert.ok(Math.abs(decodeTransfer(pq40, 'pq', { referenceWhiteNits: 80 }) * 80 - 40) < 1e-6);

  const hlg = encodeTransfer(1, 'hlg', { referenceWhiteNits: 80, hlgPeakNits: 1000 });
  assert.ok(Math.abs(decodeTransfer(hlg, 'hlg', { referenceWhiteNits: 80, hlgPeakNits: 1000 }) - 1) < 1e-7);
  assert.ok(Math.abs(hlg - encodeTransfer(1, 'hlg', { referenceWhiteNits: 80, hlgPeakNits: 1000 })) < 1e-12);
});

test('Rec.2020 gamut excursions survive grading and convert back without red hue loss', () => {
  const rec709 = convertPrimaries([1, 0, 0], 'rec2020', 'rec709');
  assert.ok(rec709[0] > 1.6);
  assert.ok(rec709[1] < 0);
  assert.ok(rec709[2] < 0);
  const graded = applyGrade(rec709, { sourceHDR: true, luminanceUnit: 'scRGB-80-nit' });
  assert.deepEqual(graded, rec709);
  const roundTrip = convertPrimaries(graded, 'rec709', 'rec2020');
  assert.ok(Math.abs(roundTrip[0] - 1) < 1e-6);
  assert.ok(Math.abs(roundTrip[1]) < 1e-6);
  assert.ok(Math.abs(roundTrip[2]) < 1e-6);
});

test('default gamma 2.2 is exact sRGB and artistic gamma stays continuous', () => {
  const neutralLinear = 0.2158605001;
  assert.ok(Math.abs(encodeSdrChannel(neutralLinear, 2.2) - 128 / 255) < 1e-7);
  const at2199 = encodeSdrChannel(0.003, 2.199);
  const at2200 = encodeSdrChannel(0.003, 2.2);
  const at2201 = encodeSdrChannel(0.003, 2.201);
  assert.ok(Math.abs(at2199 - at2200) < 0.0001);
  assert.ok(Math.abs(at2201 - at2200) < 0.0001);
  assert.ok(Math.abs(renderSdrRgb([neutralLinear, neutralLinear, neutralLinear], { toneMapper: 0 })[0] - 128 / 255) < 1e-7);
});

test('Lottes anchors mid-gray at 0.267 and the configured white at 1', () => {
  const mappedGray = toneMapRgb([0.18, 0.18, 0.18], 'lottes', 5);
  const mappedWhite = toneMapRgb([5, 5, 5], 'lottes', 5);
  assert.ok(Math.abs(mappedGray[0] - 0.267) < 1e-7);
  assert.ok(Math.abs(mappedWhite[0] - 1) < 1e-7);
});

test('exposure compensation is applied once for relative data and not to absolute scRGB', () => {
  const relative = applyGrade([0.5, 0.5, 0.5], { autoExposureCorrect: true, sdrWhite: 200 });
  const absolute = applyGrade([0.5, 0.5, 0.5], { autoExposureCorrect: true, sdrWhite: 200, luminanceUnit: 'scRGB-80-nit' });
  assert.ok(Math.abs(relative[0] - 0.2) < 1e-7);
  assert.deepEqual(absolute, [0.5, 0.5, 0.5]);
});

test('HDR provenance does not disable SDR grading when the fallback decoder returned SDR', () => {
  const fallbackSdr = applyGrade([0.5, 0.5, 0.5], {
    sourceHDR: true,
    decodedHDR: false,
    luminanceUnit: 'relative',
    sdrBoost: 2
  });
  const decodedHdr = applyGrade([0.5, 0.5, 0.5], {
    sourceHDR: true,
    decodedHDR: true,
    luminanceUnit: 'relative',
    sdrBoost: 2
  });
  assert.deepEqual(fallbackSdr, [1, 1, 1]);
  assert.deepEqual(decodedHdr, [0.5, 0.5, 0.5]);
});
