// Current regression suite for the issues found by the 2026-10-19 audit.
// The historical reproducer is preserved as reproduce-baseline.mjs and belongs
// to baseline commit f984d56263d0cb169ac014eaa0dc172120a4ea3d.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)),
  stdio: 'inherit',
});
if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
