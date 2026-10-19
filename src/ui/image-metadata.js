function getDecodedBitDepth(decoded) {
  const value = decoded?.bitDepth ?? decoded?.bitsPerSample ?? decoded?.pixelInfo?.bitDepth;
  if (Number.isInteger(value) && value > 0) {
    const sampleType = decoded?.sampleType ?? decoded?.pixelInfo?.sampleType;
    return `${value}-bit ${/float/i.test(String(sampleType || '')) ? 'Float' : 'Integer'}`;
  }
  if (typeof value !== 'string') return null;

  const match = /^(\d+)\s*(float|integer|uint|unorm)?$/i.exec(value.trim());
  if (!match) return null;
  const sampleType = /float/i.test(match[2] || '') ? 'Float' : 'Integer';
  return `${match[1]}-bit ${sampleType}`;
}

export function formatDecodedInfo(name, decoded = {}) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const sourceHDRKnown = Boolean(decoded.sourceHDRKnown ?? (ext !== 'avif'));
  const sourceHDR = Boolean(decoded.sourceHDR ?? decoded.isHDR ?? false);
  const decodedHDR = Boolean(decoded.decodedHDR ?? decoded.isHDR ?? sourceHDR);
  const actualDepth = getDecodedBitDepth(decoded);

  let format;
  let depth;
  switch (ext) {
    case 'jxr':
    case 'wdp':
      format = ext === 'jxr' ? 'JPEG XR (.jxr)' : 'JPEG XR (.wdp)';
      depth = actualDepth || (decodedHDR ? 'Floating-point samples' : 'Integer samples');
      break;
    case 'exr':
      format = 'OpenEXR (.exr)';
      depth = actualDepth || '32-bit Float';
      break;
    case 'hdr':
      format = 'Radiance HDR (.hdr)';
      depth = '32-bit RGBE';
      break;
    case 'avif':
      format = !sourceHDRKnown
        ? `AVIF (source HDR unknown; decoded ${decodedHDR ? 'HDR' : 'SDR'})`
        : sourceHDR && !decodedHDR
          ? 'AVIF (HDR source; decoded SDR fallback)'
          : sourceHDR
            ? 'AVIF (HDR source; decoded HDR)'
            : decodedHDR
              ? 'AVIF (SDR source; decoded HDR)'
              : 'AVIF (SDR)';
      depth = actualDepth || (decodedHDR ? '10-bit PQ/HLG' : '8-bit Integer');
      break;
    case 'png':
      format = decodedHDR ? 'Image (PNG)' : 'SDR Image (PNG)';
      depth = actualDepth || (decodedHDR ? 'Floating-point' : '8-bit Integer');
      break;
    case 'jpg':
    case 'jpeg':
      format = 'SDR Image (JPEG)';
      depth = actualDepth || '8-bit Integer';
      break;
    case 'webp':
      format = 'SDR Image (WebP)';
      depth = actualDepth || '8-bit Integer';
      break;
    default:
      format = 'Image';
      depth = actualDepth || (decodedHDR ? '32-bit Float' : '8-bit Integer');
  }

  return {
    format,
    depth: `${depth} (${decodedHDR ? 'HDR' : 'SDR'})`,
    sourceHDR,
    sourceHDRKnown,
    decodedHDR
  };
}
