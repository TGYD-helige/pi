import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('bundled Cua Driver', () => {
  it('documents the upstream cursor tool migration', () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const readme = readFileSync(resolve(packageDir, 'README.md'), 'utf8');
    expect(readme).toContain('`set_agent_cursor_style`');
    expect(readme).toContain('`set_agent_cursor_theme`');
  });
});
