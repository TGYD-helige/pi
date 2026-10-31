import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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

  it.skipIf(process.platform === 'win32')(
    'rejects a policy FIFO without waiting for a writer',
    async () => {
      await promisify(execFile)('mkfifo', [profile], { timeout: 5000 });
      const pending = loadPiPolicyProfilesAsync({
        cwd: root,
        configDir: join(root, 'config'),
        projectTrusted: true,
      });
      void pending.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        pending.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      clearTimeout(timer);
      if (!settled) {
        const writer = await open(profile, constants.O_WRONLY | constants.O_NONBLOCK);
        await writer.close();
        await pending.catch(() => {});
      }
      expect(settled).toBe(true);
      await expect(pending).rejects.toThrow(/limit/i);
    },
  );

  it('rejects oversized policy files instead of authorizing without them', async () => {
    await writeFile(profile, JSON.stringify({ padding: 'x'.repeat(128 * 1024) }));
    await expect(
      loadPiPolicyProfilesAsync({
        cwd: root,
        configDir: join(root, 'config'),
        projectTrusted: true,
      }),
    ).rejects.toThrow(/limit/i);
  });

  it('rejects excessive policy counts', async () => {
    await Promise.all(
      Array.from({ length: 129 }, (_, i) => writeFile(join(policyDir, `${i}.json`), '{}')),
    );
    await expect(
      loadPiPolicyProfilesAsync({
        cwd: root,
        configDir: join(root, 'config'),
        projectTrusted: true,
      }),
    ).rejects.toThrow(/limit/i);
  });

  it('enforces the aggregate byte budget across files', async () => {
    await Promise.all(
      Array.from({ length: 17 }, (_, i) =>
        writeFile(join(policyDir, `${i}.json`), JSON.stringify({ padding: 'x'.repeat(125_000) })),
      ),
    );
    await expect(
      loadPiPolicyProfilesAsync({
        cwd: root,
        configDir: join(root, 'config'),
        projectTrusted: true,
      }),
    ).rejects.toThrow(/limit/i);
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
