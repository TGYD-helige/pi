import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function makeHyperframesProject(project: string, sourcePath: string) {
  const bin = join(project, 'node_modules', 'hyperframes', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(project, 'package.json'), '{}');
  writeFileSync(
    join(project, 'index.html'),
    '<!doctype html><html><head></head><body><div data-composition-id="promo" data-width="160" data-height="90" data-duration="2"></div></body></html>',
  );
  writeFileSync(join(bin, '..', 'package.json'), '{"version":"0.9.26","type":"module"}');
  writeFileSync(
    join(bin, 'hyperframes.mjs'),
    `
    import {copyFileSync, readFileSync, mkdirSync, writeFileSync, existsSync} from 'node:fs';
    import {join} from 'node:path';
    const args = process.argv.slice(2);
    const dir = args[1];
    const output = args[args.indexOf('--output') + 1];
    if (args[0] === 'info') {console.log(JSON.stringify({duration:2})); process.exit(0);}
    if (!readFileSync(join(dir, 'index.html'), 'utf8').includes('window.videoGenAssets=')) process.exit(1);
    if (existsSync(join(dir, 'fail'))) {console.error('secret-provider-body'); process.exit(1);}
    if (existsSync(join(dir, 'wait'))) {
      writeFileSync(readFileSync(join(dir, 'wait'), 'utf8'), String(process.pid));
      setInterval(() => {}, 1000);
    } else if (args[0] === 'snapshot') {
      mkdirSync(output, {recursive:true}); writeFileSync(join(output, 'frame.png'), 'frame');
    } else copyFileSync(${JSON.stringify(sourcePath)}, output);
  `,
  );
}
