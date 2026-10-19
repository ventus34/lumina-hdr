import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const dependencyLicenses = [
  ['@jsquash/avif', 'LICENSE'],
  ['wasm-feature-detect', 'LICENSE'],
  ['jpegxr', 'license.md'],
  ['parse-exr', 'LICENSE.md']
].map(([name, file]) => `${name}\n${readFileSync(resolve('node_modules', name, file), 'utf8')}`).join('\n\n');
const licenseText = dependencyLicenses.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export default defineConfig(({ mode }) => {
  const isPagesBuild = mode === 'pages';
  const examplesManifest = resolve(process.cwd(), 'docs/examples/examples.json');
  const defaultExamplesPath = mode === 'development'
    ? (existsSync(examplesManifest) ? 'docs/examples/' : '')
    : isPagesBuild && existsSync(examplesManifest)
      ? 'examples/'
      : '';
  const examplesPath = process.env.VITE_EXAMPLES_BASE_PATH ?? defaultExamplesPath;
  const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'lumina-hdr';

  return {
    base: isPagesBuild ? `/${repositoryName}/` : './',
    define: {
      'import.meta.env.VITE_EXAMPLES_BASE_PATH': JSON.stringify(examplesPath)
    },
    publicDir: false,
    plugins: [viteSingleFile(), {
      name: 'bundled-dependency-notices',
      transformIndexHtml() {
        return [{ tag: 'template', attrs: { id: 'third-party-notices' }, children: licenseText, injectTo: 'body' }];
      }
    }],
    build: {
      outDir: isPagesBuild ? 'dist/pages' : 'dist',
      emptyOutDir: true,
      // Keep embedded application assets in the standalone HTML.
      assetsInlineLimit: 100000000,
      chunkSizeWarningLimit: 100000000,
      cssCodeSplit: false
    }
  };
});
