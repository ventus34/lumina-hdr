import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtHtml = path.join(repositoryRoot, 'dist', 'pages', 'index.html');
const pagesHtml = path.join(repositoryRoot, 'docs', 'index.html');
const builtHtmlInfo = await stat(builtHtml);

if (!builtHtmlInfo.isFile() || builtHtmlInfo.size === 0) {
  throw new Error(`Pages build did not produce a non-empty HTML file: ${builtHtml}`);
}

await mkdir(path.dirname(pagesHtml), { recursive: true });
await copyFile(builtHtml, pagesHtml);
console.log(`Copied ${builtHtmlInfo.size} bytes of app HTML to docs/index.html; examples remain in place.`);
