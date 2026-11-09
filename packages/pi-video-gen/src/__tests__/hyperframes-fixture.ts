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
    import {runInNewContext} from 'node:vm';
    const args = process.argv.slice(2);
    const dir = args[1];
    const output = args[args.indexOf('--output') + 1];
    if (args[0] === 'info') {console.log(JSON.stringify({duration:2})); process.exit(0);}
    const html = readFileSync(join(dir, 'index.html'), 'utf8').replace(/<!--[\\s\\S]*?-->/g, '');
    const executableHtml = html.replace(/<(iframe|xmp|noembed|noframes)(?=[\\s/>])[^>]*>[\\s\\S]*?<\\/\\1\\s*>/gi, '');
    const markup = executableHtml.replace(/<script>[\\s\\S]*?<\\/script>/gi, '');
    const authoredBase = markup.match(/<base href="([^"]+)"/i)?.[1];
    let effectiveBase = authoredBase ?? '/';
    const baseElement = {getAttribute: () => authoredBase, set href(value) {effectiveBase = value;}};
    const window = {};
    for (const script of executableHtml.matchAll(/<script>([\\s\\S]*?)<\\/script>/gi)) {
      runInNewContext(script[1], {window, document:{currentScript:{previousElementSibling:baseElement}}, location:{href:'http://localhost/index.html'}, URL});
    }
    if (!window.videoGenAssets || ('assetAtAuthorTime' in window && !window.assetAtAuthorTime)) process.exit(1);
    if (Object.values(window.videoGenAssets).some(path => new URL(path, new URL(effectiveBase, 'http://localhost/index.html')).origin !== 'http://localhost')) process.exit(1);
    if (html.includes('data-review-relative')) {
      const resource = new URL('poster.png', new URL(effectiveBase, 'http://localhost/'));
      if (!existsSync(join(dir, resource.pathname))) process.exit(1);
    }
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
