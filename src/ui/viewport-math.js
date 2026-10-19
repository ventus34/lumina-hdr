/** Client-pixel geometry matching the renderer's top-to-bottom texture UVs. */
export function viewportGeometry({ width, height, imageWidth, imageHeight, previewMode }) {
  if (![width, height, imageWidth, imageHeight].every(value => Number.isFinite(value) && value > 0)) return null;
  const sideBySide = previewMode === 'side-by-side';
  const panelWidth = sideBySide ? width / 2 : width;
  const canvasAspect = panelWidth / height;
  const imageAspect = imageWidth / imageHeight;
  return {
    panelWidth,
    height,
    sideBySide,
    scaleX: canvasAspect > imageAspect ? imageAspect / canvasAspect : 1,
    scaleY: canvasAspect > imageAspect ? 1 : canvasAspect / imageAspect,
  };
}

export function viewportToImageUV({ x, y, zoom = 1, panX = 0, panY = 0, ...dimensions }) {
  const geometry = viewportGeometry(dimensions);
  if (!geometry || !Number.isFinite(zoom) || zoom <= 0) return null;
  const panelX = geometry.sideBySide && x >= geometry.panelWidth ? x - geometry.panelWidth : x;
  return {
    u: (panelX / geometry.panelWidth - 0.5) / geometry.scaleX / zoom + 0.5 - panX,
    v: (y / geometry.height - 0.5) / geometry.scaleY / zoom + 0.5 - panY,
  };
}

export function panDeltaForClientDelta({ dx, dy, zoom = 1, ...dimensions }) {
  const geometry = viewportGeometry(dimensions);
  if (!geometry || !Number.isFinite(zoom) || zoom <= 0) return { x: 0, y: 0 };
  return {
    x: dx / geometry.panelWidth / geometry.scaleX / zoom,
    y: dy / geometry.height / geometry.scaleY / zoom,
  };
}

/** Keep the same source pixel under the cursor when changing zoom. */
export function panForZoom({ x, y, oldZoom, newZoom, panX = 0, panY = 0, ...dimensions }) {
  const before = viewportToImageUV({ x, y, zoom: oldZoom, panX, panY, ...dimensions });
  const after = viewportToImageUV({ x, y, zoom: newZoom, panX, panY, ...dimensions });
  if (!before || !after) return { x: panX, y: panY };
  return { x: panX + after.u - before.u, y: panY + after.v - before.v };
}
