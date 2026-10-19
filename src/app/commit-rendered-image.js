/** Upload an image successfully before publishing it as the visible image. */
export function commitRenderedImage(renderer, image, commit) {
  renderer.setImage(image.width, image.height, image.data);
  commit(image);
  return image;
}
