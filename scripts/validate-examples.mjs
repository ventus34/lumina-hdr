import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplesDirectory = path.join(repositoryRoot, 'docs', 'examples');
const manifestPath = path.join(examplesDirectory, 'examples.json');

let manifestText;
try {
  manifestText = await readFile(manifestPath, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('Pages build: example dataset is absent; the gallery will be disabled.');
    process.exit(0);
  }
  throw error;
}

let entries;
try {
  entries = JSON.parse(manifestText);
} catch (error) {
  throw new Error(`Invalid example manifest JSON at ${manifestPath}: ${error.message}`, { cause: error });
}

if (!Array.isArray(entries)) {
  throw new TypeError('Example manifest must contain a JSON array.');
}

const filenames = new Set();
for (const [index, entry] of entries.entries()) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`Example manifest entry ${index} must be an object.`);
  }
  if (typeof entry.filename !== 'string' || !/^[\w .-]+\.(?:avif|jxr|exr|hdr)$/i.test(entry.filename)) {
    throw new TypeError(`Example manifest entry ${index} has an invalid filename.`);
  }
  if (filenames.has(entry.filename)) {
    throw new Error(`Duplicate example filename: ${entry.filename}`);
  }
  filenames.add(entry.filename);

  const filepath = path.resolve(examplesDirectory, entry.filename);
  if (!filepath.startsWith(`${examplesDirectory}${path.sep}`)) {
    throw new Error(`Example path escapes the dataset directory: ${entry.filename}`);
  }
  let fileInfo;
  try {
    fileInfo = await lstat(filepath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Example referenced by the manifest is missing: ${entry.filename}`, { cause: error });
    }
    throw error;
  }
  if (!fileInfo.isFile() || fileInfo.size === 0) {
    throw new Error(`Example must be a non-empty regular file: ${entry.filename}`);
  }
}

console.log(`Validated ${filenames.size} example manifest entries; assets stay in place and are not copied.`);
