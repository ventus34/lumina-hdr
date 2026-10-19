/**
 * Color math shared by the CPU export path and the WebGL renderer.
 *
 * Canonical application RGB is linear Rec.709. Absolute HDR decoders use the
 * scRGB convention where 1.0 represents 80 cd/m²; relative SDR images use
 * values in [0, 1] and are mapped to the selected SDR white during rendering.
 */

export const SDR_WHITE_NITS = 80;
export const DEFAULT_HLG_PEAK_NITS = 1000;
export const DEFAULT_HLG_SYSTEM_GAMMA = 1.2;

const LUMA_709 = [0.2126, 0.7152, 0.0722];
const PRIMARIES_TO_XYZ = {
  rec709: [
    0.4123907993, 0.3575843394, 0.1804807884,
    0.2126390059, 0.7151686788, 0.0721923154,
    0.0193308187, 0.1191947798, 0.9505321522
  ],
  rec2020: [
    0.6369580483, 0.1446169036, 0.1688809752,
    0.2627002120, 0.6779980715, 0.0593017165,
    0.0000000000, 0.0280726930, 1.0609850577
  ],
  displayP3: [
    0.4865709486, 0.2656676932, 0.1982172852,
    0.2289745641, 0.6917385218, 0.0792869141,
    0.0000000000, 0.0451133819, 1.0439443689
  ]
};

const XYZ_TO_PRIMARIES = {
  rec709: [
    3.2409699419, -1.5373831776, -0.4986107603,
    -0.9692436363, 1.8759675015, 0.0415550574,
    0.0556300797, -0.2039769589, 1.0569715142
  ],
  rec2020: [
    1.7166511880, -0.3556707838, -0.2533662814,
    -0.6666843518, 1.6164812366, 0.0157685458,
    0.0176398574, -0.0427706133, 0.9421031212
  ],
  displayP3: [
    2.4934969119, -0.9313836179, -0.4027107845,
    -0.8294889696, 1.7626640603, 0.0236246858,
    0.0358458302, -0.0761723893, 0.9568845240
  ]
};

function signPow(value, power) {
  return Math.sign(value) * Math.pow(Math.abs(value), power);
}

/** IEC 61966-2-1 sRGB EOTF. Negative scRGB values use a signed extension. */
export function srgbToLinear(value) {
  const sign = Math.sign(value);
  const v = Math.abs(value);
  return sign * (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
}

/** IEC 61966-2-1 sRGB OETF. Negative scRGB values use a signed extension. */
export function linearToSrgb(value) {
  const sign = Math.sign(value);
  const v = Math.abs(value);
  return sign * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
}

export function pqToNits(value) {
  const v = Math.min(1, Math.max(0, value));
  if (v === 0) return 0;
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  const p = Math.pow(v, 1 / m2);
  const numerator = Math.max(p - c1, 0);
  const denominator = c2 - c3 * p;
  return denominator <= 0 ? 10000 : 10000 * Math.pow(numerator / denominator, 1 / m1);
}

export function nitsToPq(nits) {
  const v = Math.min(10000, Math.max(0, nits)) / 10000;
  if (v === 0) return 0;
  const m1 = 0.1593017578125;
  const m2 = 78.84375;
  const c1 = 0.8359375;
  const c2 = 18.8515625;
  const c3 = 18.6875;
  const p = Math.pow(v, m1);
  return Math.pow((c1 + c2 * p) / (1 + c3 * p), m2);
}

export function hlgToSceneLinear(value) {
  const v = Math.min(1, Math.max(0, value));
  if (v <= 0.5) return (v * v) / 3;
  const a = 0.17883277;
  const b = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);
  return (Math.exp((v - c) / a) + b) / 12;
}

export function sceneLinearToHlg(value) {
  const v = Math.max(0, value);
  if (v <= 1 / 12) return Math.sqrt(3 * v);
  const a = 0.17883277;
  const b = 1 - 4 * a;
  const c = 0.5 - a * Math.log(4 * a);
  return a * Math.log(12 * v - b) + c;
}

const REC2020_LUMA = [0.2627, 0.6780, 0.0593];

function luma2020(rgb) {
  return rgb[0] * REC2020_LUMA[0] + rgb[1] * REC2020_LUMA[1] + rgb[2] * REC2020_LUMA[2];
}

/** Decode Rec.2100 HLG RGB to display-linear Rec.2020 RGB in reference-white units. */
export function decodeHlgRgb(rgb, {
  peakNits = DEFAULT_HLG_PEAK_NITS,
  gamma = DEFAULT_HLG_SYSTEM_GAMMA,
  referenceWhiteNits = SDR_WHITE_NITS
} = {}) {
  const peak = Math.max(1, Number.isFinite(peakNits) ? peakNits : DEFAULT_HLG_PEAK_NITS);
  const systemGamma = Math.max(0.01, Number.isFinite(gamma) ? gamma : DEFAULT_HLG_SYSTEM_GAMMA);
  const white = Math.max(1, Number.isFinite(referenceWhiteNits) ? referenceWhiteNits : SDR_WHITE_NITS);
  const scene = rgb.map((value) => hlgToSceneLinear(value));
  const sceneLuma = Math.max(0, luma2020(scene));
  if (sceneLuma === 0) return [0, 0, 0];
  const ootfScale = (peak / white) * Math.pow(sceneLuma, systemGamma - 1);
  return scene.map((value) => value * ootfScale);
}

/** Encode display-linear Rec.2020 RGB in reference-white units using inverse OOTF plus HLG OETF. */
export function encodeHlgRgb(rgb, {
  peakNits = DEFAULT_HLG_PEAK_NITS,
  gamma = DEFAULT_HLG_SYSTEM_GAMMA,
  referenceWhiteNits = SDR_WHITE_NITS
} = {}) {
  const peak = Math.max(1, Number.isFinite(peakNits) ? peakNits : DEFAULT_HLG_PEAK_NITS);
  const systemGamma = Math.max(0.01, Number.isFinite(gamma) ? gamma : DEFAULT_HLG_SYSTEM_GAMMA);
  const white = Math.max(1, Number.isFinite(referenceWhiteNits) ? referenceWhiteNits : SDR_WHITE_NITS);
  const display = rgb.map((value) => Math.max(0, value) * white);
  const displayLuma = Math.max(0, luma2020(display));
  if (displayLuma === 0) return [0, 0, 0];
  const sceneLuma = Math.pow(displayLuma / peak, 1 / systemGamma);
  const ootfScale = peak * Math.pow(sceneLuma, systemGamma - 1);
  const scene = display.map((value) => value / ootfScale);
  return scene.map((value) => sceneLinearToHlg(value));
}

/** Decode a single channel to linear light. PQ is returned in scRGB units. */
export function decodeTransfer(value, transfer = 'srgb', options = {}) {
  switch (String(transfer).toLowerCase()) {
    case 'srgb':
    case 'iec61966-2-1':
      return srgbToLinear(value);
    case 'gamma22':
    case 'gamma-2.2':
      return signPow(value, 2.2);
    case 'pq':
    case 'smpte2084':
      return pqToNits(value) / (options.referenceWhiteNits || SDR_WHITE_NITS);
    case 'hlg': {
      const peakNits = options.hlgPeakNits || DEFAULT_HLG_PEAK_NITS;
      const gamma = options.hlgGamma || DEFAULT_HLG_SYSTEM_GAMMA;
      return Math.pow(hlgToSceneLinear(value), gamma) * peakNits / (options.referenceWhiteNits || SDR_WHITE_NITS);
    }
    case 'linear':
    case 'scrgb':
    case 'linear-rec709':
    default:
      return value;
  }
}

/** Encode one linear channel. PQ input is interpreted in scRGB units (80 nit). */
export function encodeTransfer(value, transfer = 'srgb', options = {}) {
  switch (String(transfer).toLowerCase()) {
    case 'srgb':
    case 'iec61966-2-1':
      return linearToSrgb(value);
    case 'gamma22':
    case 'gamma-2.2':
      return signPow(value, 1 / 2.2);
    case 'pq':
    case 'smpte2084':
      return nitsToPq(value * (options.referenceWhiteNits || SDR_WHITE_NITS));
    case 'hlg': {
      const peakNits = options.hlgPeakNits || DEFAULT_HLG_PEAK_NITS;
      const gamma = options.hlgGamma || DEFAULT_HLG_SYSTEM_GAMMA;
      const referenceWhiteNits = options.referenceWhiteNits || SDR_WHITE_NITS;
      const scene = Math.pow(Math.max(0, value * referenceWhiteNits / peakNits), 1 / gamma);
      return sceneLinearToHlg(scene);
    }
    case 'linear':
    case 'scrgb':
    case 'linear-rec709':
    default:
      return value;
  }
}

function multiply3(m, rgb) {
  return [
    m[0] * rgb[0] + m[1] * rgb[1] + m[2] * rgb[2],
    m[3] * rgb[0] + m[4] * rgb[1] + m[5] * rgb[2],
    m[6] * rgb[0] + m[7] * rgb[1] + m[8] * rgb[2]
  ];
}

/** Convert linear RGB between Rec.709, Rec.2020 and Display-P3 primaries. */
export function convertPrimaries(rgb, from = 'rec709', to = 'rec709') {
  const source = String(from).toLowerCase().replace(/[-_]/g, '');
  const destination = String(to).toLowerCase().replace(/[-_]/g, '');
  const aliases = { '709': 'rec709', bt709: 'rec709', rec709: 'rec709', '2020': 'rec2020', bt2020: 'rec2020', rec2020: 'rec2020', p3: 'displayP3', displayp3: 'displayP3', dcip3: 'displayP3' };
  const fromKey = aliases[source] || 'rec709';
  const toKey = aliases[destination] || 'rec709';
  if (fromKey === toKey) return [...rgb];
  const xyz = multiply3(PRIMARIES_TO_XYZ[fromKey], rgb);
  return multiply3(XYZ_TO_PRIMARIES[toKey], xyz);
}

export function luminance709(rgb) {
  return rgb[0] * LUMA_709[0] + rgb[1] * LUMA_709[1] + rgb[2] * LUMA_709[2];
}

/** Apply the shared linear-light exposure and color-grading stage. */
export function applyGrade(rgb, options = {}) {
  let [r, g, b] = rgb;
  const absoluteSource = options.luminanceUnit === 'scRGB-80-nit';
  const sourceHDR = (options.decodedHDR ?? options.sourceHDR) === true || absoluteSource;
  const sdrBoost = options.sdrBoost ?? 1;
  const smartUpmix = !sourceHDR && Boolean(options.smartUpmix);

  if (smartUpmix) {
    const luma = luminance709([r, g, b]);
    if (luma > 0) {
      const t = Math.max(0, (luma - 0.75) / 0.25);
      const newLuma = luma <= 0.75 ? luma : 0.75 + (luma - 0.75) * (1 + (sdrBoost - 1) * t);
      const scale = newLuma / luma;
      r *= scale; g *= scale; b *= scale;
    }
  } else if (!sourceHDR) {
    r *= sdrBoost; g *= sdrBoost; b *= sdrBoost;
  }

  const sdrWhite = options.sdrWhite || 200;
  let exposure = options.exposure || 0;
  if (options.autoExposureCorrect && !absoluteSource && !options.exposureResolved) {
    exposure += Math.log2(SDR_WHITE_NITS / sdrWhite);
  }
  const expFactor = Math.pow(2, exposure);
  r *= expFactor; g *= expFactor; b *= expFactor;

  const temp = options.temp || 0;
  const tint = options.tint || 0;
  r += temp * 0.12 - tint * 0.06;
  g += tint * 0.12;
  b += -temp * 0.12 - tint * 0.06;

  const luma = luminance709([r, g, b]);
  const shadowMask = Math.pow(1 - Math.min(1, Math.max(0, luma)), 2);
  const highlightMask = Math.pow(Math.min(1, Math.max(0, luma)), 2);
  const shadowScale = Math.max(0, 1 + (options.shadows || 0) * shadowMask);
  const highlightScale = Math.max(0, 1 + (options.highlights || 0) * highlightMask);
  r *= shadowScale * highlightScale;
  g *= shadowScale * highlightScale;
  b *= shadowScale * highlightScale;

  const saturation = options.saturation ?? 1;
  if (saturation !== 1) {
    const satLuma = luminance709([r, g, b]);
    r = satLuma + (r - satLuma) * saturation;
    g = satLuma + (g - satLuma) * saturation;
    b = satLuma + (b - satLuma) * saturation;
  }
  return [r, g, b];
}

function reinhard(v, white) {
  return (v * (1 + v / (white * white))) / (v + 1);
}

function aces(v) {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return Math.min(1, Math.max(0, (v * (a * v + b)) / (v * (c * v + d) + e)));
}

function hableOperator(v) {
  const A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((v * (A * v + C * B) + D * E) / (v * (A * v + B) + D * F)) - E / F;
}

function lottes(v, white) {
  const a = 1.6, d = 0.977, midIn = 0.18, midOut = 0.267;
  const denom = Math.max(1e-5, Math.pow(white, a * d) * midOut - Math.pow(midIn, a * d) * midOut);
  const b = (-Math.pow(midIn, a) + Math.pow(white, a) * midOut) / ((Math.pow(white, a * d) - Math.pow(midIn, a * d)) * midOut);
  const c = (Math.pow(white, a * d) * Math.pow(midIn, a) - Math.pow(white, a) * Math.pow(midIn, a * d) * midOut) / denom;
  const z = Math.pow(Math.max(v, 0), a);
  return Math.min(1, Math.max(0, z / (Math.pow(z, d) * b + c)));
}

function uchimura(v, white) {
  const P = 1, a = 1, m = 0.22, l = 0.4, c = 1.33, b = 0;
  const x = v * (5 / white);
  const l0 = ((P - m) * l) / a;
  const S0 = m + l0;
  const S1 = m + a * l0;
  const C2 = (a * P) / (P - S1);
  const CP = -C2 / P;
  const t = Math.min(1, Math.max(0, x / m));
  const smooth = t * t * (3 - 2 * t);
  const actualW0 = 1 - smooth;
  const w2 = x >= m + l0 ? 1 : 0;
  const w1 = 1 - actualW0 - w2;
  const T = m * Math.pow(Math.max(x / m, 0), c) + b;
  const S = P - (P - S1) * Math.exp(CP * (x - S0));
  const L = m + a * (x - m);
  return T * actualW0 + L * w1 + S * w2;
}

/** Tone map linear RGB into linear SDR RGB (before display transfer encoding). */
export function toneMapRgb(rgb, operator = 'aces', white = 5) {
  const w = Math.max(0.01, Number.isFinite(white) ? white : 5);
  const name = typeof operator === 'number' ? ['linear', 'reinhard', 'aces', 'hable', 'lottes', 'uchimura'][operator] || 'linear' : String(operator).toLowerCase();
  const acesWhite = aces(w);
  const hableWhite = hableOperator(w);
  return rgb.map((component) => {
    const v = Math.max(0, component);
    let mapped;
    switch (name) {
      case 'reinhard': mapped = reinhard(v, w); break;
      case 'aces':
      case 'acesfilmic': mapped = aces(v) / Math.max(acesWhite, 1e-8); break;
      case 'hable': mapped = hableOperator(v) / Math.max(hableWhite, 1e-8); break;
      case 'lottes': mapped = lottes(v, w); break;
      case 'uchimura': mapped = uchimura(v, w); break;
      default: mapped = v;
    }
    return Math.min(1, Math.max(0, mapped));
  });
}

/** Encode a tone-mapped linear channel using exact sRGB by default. */
export function encodeSdrChannel(value, gamma = 2.2) {
  const v = Math.min(1, Math.max(0, value));
  const encoded = linearToSrgb(v);
  if (Math.abs(gamma - 2.2) < 1e-12) return encoded;
  return Math.pow(Math.max(0, encoded), 2.2 / Math.max(0.01, gamma));
}

export function getReferenceNits(options = {}) {
  if (options.luminanceUnit === 'scRGB-80-nit') return SDR_WHITE_NITS;
  // Auto exposure maps relative inputs to 80 nits in applyGrade; retaining the
  // selected white here keeps the output scale and tone-map white consistent.
  return options.sdrWhite || 200;
}

export function toneMapLinearRgb(rgb, options = {}) {
  const graded = applyGrade(rgb, options);
  const referenceNits = getReferenceNits(options);
  const white = options.targetPeak ? options.targetPeak / referenceNits : (options.toneMapWhite || 1000 / referenceNits);
  const mapped = toneMapRgb(graded, options.toneMapper ?? 'aces', white);
  const contrast = options.contrast ?? 1;
  return mapped.map((v) => Math.pow(Math.max(v, 0), contrast));
}

/** Shared SDR renderer/export result in sRGB encoded RGB. */
export function renderSdrRgb(rgb, options = {}) {
  return toneMapLinearRgb(rgb, options).map((v) => encodeSdrChannel(v, options.gamma ?? 2.2));
}

function normalizeBackground(backgroundColor = [1, 1, 1]) {
  if (Array.isArray(backgroundColor)) return backgroundColor.slice(0, 3);
  if (typeof backgroundColor === 'string' && /^#[\da-f]{6}$/i.test(backgroundColor)) {
    const vals = [1, 3, 5].map((i) => parseInt(backgroundColor.slice(i, i + 2), 16) / 255);
    return vals.map(srgbToLinear);
  }
  return [1, 1, 1];
}

/** Process all pixels; result remains linear RGB with straight alpha. */
export function processImagePixels(image, options = {}, { mode = 'hdr', alphaMode = 'preserve', backgroundColor = '#ffffff', pixelMode = 'processed' } = {}) {
  const { width, height, data } = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new TypeError('Image width and height must be positive integers.');
  if (!data || data.length !== width * height * 4) throw new TypeError('Image data must contain exactly width × height × 4 RGBA values.');
  const out = new Float32Array(data.length);
  const isOriginal = pixelMode === 'original';
  const alphaPolicy = alphaMode || 'preserve';
  const background = normalizeBackground(backgroundColor);
  const sdrMode = mode === 'sdr';
  for (let i = 0; i < data.length; i += 4) {
    let rgb = [data[i], data[i + 1], data[i + 2]];
    if (!isOriginal) rgb = sdrMode ? toneMapLinearRgb(rgb, options) : applyGrade(rgb, options);
    let alpha = Number.isFinite(data[i + 3]) ? Math.min(1, Math.max(0, data[i + 3])) : 1;
    if (alphaPolicy === 'flatten') {
      rgb = rgb.map((v, c) => v * alpha + background[c] * (1 - alpha));
      alpha = 1;
    } else if (alphaPolicy === 'opaque') {
      alpha = 1;
    } else if (alphaPolicy !== 'preserve') {
      throw new TypeError(`Unknown alpha mode: ${alphaPolicy}`);
    }
    out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; out[i + 3] = alpha;
  }
  return out;
}
