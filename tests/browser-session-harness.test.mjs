import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'vitest';
import { createBrowserSessionRunner } from './fixtures/browser-session-harness.mjs';

it('reports safe child diagnostics without exposing raw browser credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-browser-harness-'));
  const preload = join(root, 'fail.mjs');
  await writeFile(
    preload,
    `
    console.error('raw failure: wss://browser.invalid?token=private-token');
    console.error('PI_BROWSER_SESSION_TEST_ERROR ' + JSON.stringify({step:'load-extension',name:'TypeError',property:'registerFlag'}));
    process.exit(1);
  `,
  );
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  const runner = createBrowserSessionRunner(root, join(root, 'config.json'), 'about:blank');
  try {
    await assert.rejects(runner.run('retain'), (error) => {
      assert.equal(error.browserSessionDiagnostic, true);
      assert.match(error.message, /load-extension/);
      assert.match(error.message, /TypeError/);
      assert.doesNotMatch(error.message, /private-token|wss:/);
      return true;
    });
  } finally {
    runner.stop();
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await rm(root, { recursive: true, force: true });
  }
});
