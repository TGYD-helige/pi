import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { productEvents } from './product/fixture.mjs';

const [outputDir, browserExecutable] = process.argv.slice(2);
assert(outputDir && browserExecutable && isAbsolute(browserExecutable),
  'Usage: node verify-product.mjs <new-output-directory> <absolute-browser-executable>');
const projectDir = dirname(fileURLToPath(import.meta.url));
const output = resolve(outputDir);
await mkdir(output);
const serveUrl = await bundle({ entryPoint: join(projectDir, 'src/index.tsx'), rootDir: projectDir });
const composition = await selectComposition({ serveUrl, id: 'ProductDemo', browserExecutable });
const times = [productEvents.result + 0.5, productEvents.typing + 1, productEvents.submit + 0.2, 0, productEvents.result + 0.5];
const samples = [];
for (const [index, timeSec] of times.entries()) {
  const frame = Math.round(timeSec * composition.fps);
  const path = join(output, `frame-${index}-${frame}.png`);
  await renderStill({ serveUrl, composition, frame, output: path, browserExecutable,
    timeoutInMilliseconds: 30_000 });
  samples.push({ frame, timeSec, path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
}
assert.equal(samples[0].sha256, samples[4].sha256, 'Same result frame changed after seeking backwards');
assert.equal(new Set(samples.slice(0, 4).map((sample) => sample.sha256)).size, 4,
  'Draft, typing, running and result frames must differ');
await writeFile(join(output, 'seek-report.json'), JSON.stringify({ compositionId: composition.id, samples }, null, 2) + '\n');
console.error(`[product-demo] Verified four distinct states and repeated-frame identity. Inspect ${output}; motion and audio remain separate checks.`);
