import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPiPolicyProfilesAsync } from '../settings.js';

const root = join(tmpdir(), 'pi-shared-policy-profiles-async');
const policyDir = join(root, '.pi', 'policy');
const profile = join(policyDir, 'async-test-unique.json');
describe('loadPiPolicyProfilesAsync', () => {
  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(policyDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rechecks trust, modifications, and deletion on the next read', async () => {
    const options = { cwd: root, configDir: join(root, 'config') };
    await writeFile(profile, JSON.stringify({ action: 'allow' }));
    expect((await loadPiPolicyProfilesAsync(options))['async-test-unique']).toBeUndefined();
    expect(
      (await loadPiPolicyProfilesAsync({ ...options, projectTrusted: true }))['async-test-unique'],
    ).toEqual({ action: 'allow' });
    await writeFile(profile, JSON.stringify({ action: 'deny' }));
    expect(
      (await loadPiPolicyProfilesAsync({ ...options, projectTrusted: true }))['async-test-unique'],
    ).toEqual({ action: 'deny' });
    await rm(profile);
    expect(
      (await loadPiPolicyProfilesAsync({ ...options, projectTrusted: true }))['async-test-unique'],
    ).toBeUndefined();
  });
});
