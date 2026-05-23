/**
 * Pure JavaScript Radiance HDR (.hdr / RGBE) Decoder and Encoder.
 * Supports standard Run-Length Encoding (RLE) parsing and uncompressed RGBE writing.
 */

// Helper to convert RGBE bytes to float RGB values
function rgbeToFloat(r, g, b, e) {
  if (e === 0) {
    return [0, 0, 0];
  }
  const f = Math.pow(2.0, e - 128 - 8);
  return [r * f, g * f, b * f];
}

// Helper to convert float RGB values to RGBE bytes
function floatToRgbe(r, g, b) {
  const maxVal = Math.max(r, g, b);
  if (maxVal < 1e-32) {
    return [0, 0, 0, 0];
  }

  // Calculate exponent
  let exp = Math.ceil(Math.log2(maxVal));
  let scale = Math.pow(2.0, exp - 8);
  
  let re = Math.round(r / scale);
  let ge = Math.round(g / scale);
  let be = Math.round(b / scale);

  // If rounding pushed any channel to 256, rescale
  if (re > 255 || ge > 255 || be > 255) {
    exp++;
    scale = Math.pow(2.0, exp - 8);
    re = Math.round(r / scale);
    ge = Math.round(g / scale);
    be = Math.round(b / scale);
  }

  // Clamp values
  re = Math.min(255, Math.max(0, re));
  ge = Math.min(255, Math.max(0, ge));
  be = Math.min(255, Math.max(0, be));
  const exponent = exp + 128;

  return [re, ge, be, exponent];
}

/**
 * Decodes a Radiance HDR (.hdr) file buffer.
 * @param {ArrayBuffer|Uint8Array} buffer 
 * @returns {{width: number, height: number, data: Float32Array}}
 */
export function decodeRGBE(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let offset = 0;

  // 1. Read Header
  let header = '';
  let line = '';
  let format = '';
  
  while (offset < bytes.length) {
    const char = String.fromCharCode(bytes[offset++]);
    if (char === '\n') {
      if (line.trim() === '') {
        // Blank line ends the header section
        break;
      }
      if (line.startsWith('FORMAT=')) {
        format = line.substring(7).trim();
      }
      header += line + '\n';
      line = '';
    } else {
      line += char;
    }
  }

  if (format && format !== '32-bit_rle_rgbe' && format !== '32-bit_rle_xyze') {
    console.warn(`Unsupported HDR format: ${format}, attempting to decode anyway.`);
  }

  // 2. Read Resolution Line (e.g. "-Y 1080 +X 1920")
  let resLine = '';
  while (offset < bytes.length) {
    const char = String.fromCharCode(bytes[offset++]);
    if (char === '\n') {
      resLine = line;
      break;
    }
    line += char;
  }

  const resRegex = /^\s*([\-\+]Y)\s+(\d+)\s+([\-\+]X)\s+(\d+)/;
  const match = resLine.match(resRegex);
  if (!match) {
    throw new Error(`Invalid HDR resolution line: "${resLine}"`);
  }

  const ySign = match[1];
  const height = parseInt(match[2], 10);
  const xSign = match[3];
  const width = parseInt(match[4], 10);

  if (ySign !== '-Y' || xSign !== '+X') {
    // Only standard top-to-bottom, left-to-right scanning is handled directly here.
    // (Other orientations are very rare in practice)
    console.warn(`Non-standard scanline orientation: ${ySign} ${xSign}. Image might be flipped.`);
  }

  const numPixels = width * height;
  const floatData = new Float32Array(numPixels * 4); // RGBA format for WebGL compatibility

  // Check if uncompressed or RLE
  // If scanline width is short (< 8 or > 32767), RLE is disabled or uses old format
  const isRLE = (width >= 8 && width <= 32767) && (offset + 4 <= bytes.length) &&
                (bytes[offset] === 2 && bytes[offset + 1] === 2 && !(bytes[offset + 2] & 128));

  if (!isRLE) {
    // Uncompressed / Old RGBE format
    let pixelIdx = 0;
    while (offset < bytes.length && pixelIdx < numPixels) {
      const r = bytes[offset++];
      const g = bytes[offset++];
      const b = bytes[offset++];
      const e = bytes[offset++];
      const [fr, fg, fb] = rgbeToFloat(r, g, b, e);
      
      const outIdx = pixelIdx * 4;
      floatData[outIdx] = fr;
      floatData[outIdx + 1] = fg;
      floatData[outIdx + 2] = fb;
      floatData[outIdx + 3] = 1.0; // Alpha
      pixelIdx++;
    }
    return { width, height, data: floatData };
  }

  // 3. Decode RLE Scanlines
  const scanlineBuffer = new Uint8Array(width * 4);
  const channelBuffer = new Uint8Array(width);

  for (let y = 0; y < height; y++) {
    if (offset + 4 > bytes.length) {
      throw new Error('Truncated HDR file (missing scanline header)');
    }

    const rleMarker1 = bytes[offset++];
    const rleMarker2 = bytes[offset++];
    const wHi = bytes[offset++];
    const wLo = bytes[offset++];
    const scanWidth = (wHi << 8) | wLo;

    if (rleMarker1 !== 2 || rleMarker2 !== 2 || scanWidth !== width) {
      throw new Error(`Invalid RLE scanline header at row ${y}`);
    }

    // Decode 4 channels (R, G, B, E) separately for this scanline
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      while (x < width) {
        if (offset >= bytes.length) {
          throw new Error(`Truncated HDR file in scanline ${y}, channel ${channel}`);
        }
        
        const code = bytes[offset++];
        if (code > 128) {
          // Run
          const count = code - 128;
          if (x + count > width) {
            throw new Error(`RLE run exceeds scanline width in row ${y}`);
          }
          const val = bytes[offset++];
          for (let i = 0; i < count; i++) {
            channelBuffer[x++] = val;
          }
        } else {
          // Literal
          const count = code;
          if (x + count > width) {
            throw new Error(`RLE literal run exceeds scanline width in row ${y}`);
          }
          for (let i = 0; i < count; i++) {
            channelBuffer[x++] = bytes[offset++];
          }
        }
      }

      // Copy decoded channel values to scanline buffer (channel group: R=0, G=1, B=2, E=3)
      for (let i = 0; i < width; i++) {
        scanlineBuffer[i * 4 + channel] = channelBuffer[i];
      }
    }

    // Convert scanline pixels to float RGB and save
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = x * 4;
      const r = scanlineBuffer[idx];
      const g = scanlineBuffer[idx + 1];
      const b = scanlineBuffer[idx + 2];
      const e = scanlineBuffer[idx + 3];

      const [fr, fg, fb] = rgbeToFloat(r, g, b, e);
      const outIdx = rowOffset + x * 4;
      floatData[outIdx] = fr;
      floatData[outIdx + 1] = fg;
      floatData[outIdx + 2] = fb;
      floatData[outIdx + 3] = 1.0; // Alpha
    }
  }

  return { width, height, data: floatData };
}

/**
 * Encodes floating point RGBA data into a Radiance HDR (.hdr) file buffer.
 * Uses uncompressed format for extreme simplicity and perfect compatibility.
 * @param {number} width 
 * @param {number} height 
 * @param {Float32Array} rgbaData 
 * @returns {Uint8Array}
 */
export function encodeRGBE(width, height, rgbaData) {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const headerBytes = new TextEncoder().encode(header);
  
  const pixelBytes = new Uint8Array(width * height * 4);
  let pixelOffset = 0;

  for (let i = 0; i < width * height; i++) {
    const r = rgbaData[i * 4];
    const g = rgbaData[i * 4 + 1];
    const b = rgbaData[i * 4 + 2];

    const [re, ge, be, exponent] = floatToRgbe(r, g, b);
    pixelBytes[pixelOffset++] = re;
    pixelBytes[pixelOffset++] = ge;
    pixelBytes[pixelOffset++] = be;
    pixelBytes[pixelOffset++] = exponent;
  }

  const fileBytes = new Uint8Array(headerBytes.length + pixelBytes.length);
  fileBytes.set(headerBytes, 0);
  fileBytes.set(pixelBytes, headerBytes.length);

  return fileBytes;
}
