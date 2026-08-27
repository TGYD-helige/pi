import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { createReviewToolGuard } from './pi-review-readonly-guard.mjs';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-review-guard-'));
  const workspace = path.join(directory, 'pull-request');
  const diffPath = path.join(directory, 'pull-request.diff');
  const skillPath = path.join(directory, 'ponytail-review', 'SKILL.md');
  const secretPath = path.join(directory, 'secret.txt');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'example.ts'), 'export {}\n');
  await writeFile(diffPath, 'diff --git a/src/example.ts b/src/example.ts\n');
  await writeFile(skillPath, '# Ponytail review\n');
  await writeFile(secretPath, 'secret\n');
  return { directory, workspace, diffPath, skillPath, secretPath };
}

test('allows only review files and workspace-local search roots', async () => {
  const paths = await fixture();
  try {
    const guard = createReviewToolGuard(paths);
    const context = { cwd: paths.workspace };
    assert.equal(guard({ toolName: 'read', input: { path: 'src/example.ts' } }, context), undefined);
    assert.equal(guard({ toolName: 'read', input: { path: paths.diffPath } }, context), undefined);
    assert.equal(guard({ toolName: 'read', input: { path: paths.skillPath } }, context), undefined);
    assert.equal(guard({ toolName: 'fffind', input: { pattern: 'example' } }, context), undefined);
    assert.equal(guard({ toolName: 'ffgrep', input: { query: 'export', path: 'src/**' } }, context), undefined);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('blocks reads and searches that can escape the PR workspace', async () => {
  const paths = await fixture();
  try {
    const guard = createReviewToolGuard(paths);
    const context = { cwd: paths.workspace };
    for (const event of [
      { toolName: 'read', input: { path: paths.secretPath } },
      { toolName: 'read', input: { path: '../secret.txt' } },
      { toolName: 'read', input: { path: '/proc/self/environ' } },
      { toolName: 'fffind', input: { pattern: 'secret', path: '..' } },
      { toolName: 'ffgrep', input: { query: 'secret', path: '/tmp' } },
      { toolName: 'ffgrep', input: { query: 'secret', path: '~/secrets' } },
      { toolName: 'fffind', input: { pattern: 'secret', path: ' ../secret' } },
      { toolName: 'ffgrep', input: { query: 'secret', path: ' /proc/self' } },
      { toolName: 'ffgrep', input: { query: 'secret', path: ' ~/secrets' } },
    ]) {
      assert.deepEqual(guard(event, context), {
        block: true,
        reason: 'Read-only review tools may only access the pull request workspace and trusted review inputs',
      });
    }
    assert.deepEqual(
      guard({ toolName: 'fffind', input: { pattern: 'secret' } }, { cwd: paths.directory }),
      {
        block: true,
        reason: 'Read-only review tools may only access the pull request workspace and trusted review inputs',
      },
    );
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('fails closed when the PR checkout contains a symbolic link', async () => {
  const paths = await fixture();
  try {
    await symlink(paths.secretPath, path.join(paths.workspace, 'src', 'linked-secret'));
    assert.throws(() => createReviewToolGuard(paths), /symbolic link/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('allows symbolic links whose targets stay inside the PR workspace', async () => {
  const paths = await fixture();
  try {
    await symlink('example.ts', path.join(paths.workspace, 'src', 'linked-example'));
    assert.doesNotThrow(() => createReviewToolGuard(paths));
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});
