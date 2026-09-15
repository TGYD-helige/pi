import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import toolManifest from '../generated/cua-driver-tools.js';

describe('bundled tool manifest', () => {
  it('matches the pinned Cua Driver release', () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const release = JSON.parse(readFileSync(resolve(packageDir, 'driver-release.json'), 'utf8'));

    expect(release.version).toBe(toolManifest.driverVersion);
    expect(release.tag).toBe(`cua-driver-rs-v${toolManifest.driverVersion}`);
  });

  it('documents the upstream cursor tool migration', () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const readme = readFileSync(resolve(packageDir, 'README.md'), 'utf8');
    const toolNames = toolManifest.tools.map(({ name }) => name);

    expect(toolNames).toContain('set_agent_cursor_theme');
    expect(toolNames).not.toContain('set_agent_cursor_style');
    expect(readme).toContain('`set_agent_cursor_style`');
    expect(readme).toContain('`set_agent_cursor_theme`');
  });
});
