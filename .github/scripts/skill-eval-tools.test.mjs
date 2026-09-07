import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import skillEvalTools, { readSkillReference } from './skill-eval-tools.mjs';

describe('skill-eval read boundary', () => {
  it('reads disclosed Markdown but rejects escapes, scripts, symlinks out and oversized files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pi-skill-eval-read-'));
    try {
      const skill = path.join(root, 'skill');
      mkdirSync(skill);
      writeFileSync(path.join(skill, 'SKILL.md'), 'workflow');
      writeFileSync(path.join(root, 'private.md'), 'outside');
      writeFileSync(path.join(skill, 'script.mjs'), 'throw new Error("must not run")');
      symlinkSync(path.join(root, 'private.md'), path.join(skill, 'link.md'));
      writeFileSync(path.join(skill, 'large.md'), 'x'.repeat(50_001));
      writeFileSync(path.join(skill, 'lines.md'), 'x\n'.repeat(2000));
      assert.equal(readSkillReference(skill, 'SKILL.md'), 'workflow');
      for (const file of ['../private.md', 'link.md', 'script.mjs', 'large.md', 'lines.md']) {
        assert.throws(() => readSkillReference(skill, file));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('returns Markdown without JSON escaping beyond the output budget', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pi-skill-eval-quotes-'));
    const previous = process.env.SKILL_EVAL_SKILL_DIR;
    try {
      process.env.SKILL_EVAL_SKILL_DIR = root;
      writeFileSync(path.join(root, 'SKILL.md'), '"'.repeat(30_000));
      const tools = [];
      skillEvalTools({ registerTool: (tool) => tools.push(tool) });
      const result = await tools.find((tool) => tool.name === 'read').execute('read', { path: 'SKILL.md' });
      assert.equal(Buffer.byteLength(result.content[0].text), 30_000);
    } finally {
      if (previous === undefined) delete process.env.SKILL_EVAL_SKILL_DIR;
      else process.env.SKILL_EVAL_SKILL_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exposes provider-compatible typed enums in the fixture schema', () => {
    const previous = process.env.SKILL_EVAL_MODE;
    try {
      process.env.SKILL_EVAL_MODE = 'tools';
      const tools = [];
      skillEvalTools({ registerTool: (tool) => tools.push(tool) });
      const image = tools.find((tool) => tool.name === 'image_generate');
      assert.deepEqual(image.parameters.properties.aspectRatio, { type: 'string', enum: ['1:1', '16:9', '9:16'] });
    } finally {
      if (previous === undefined) delete process.env.SKILL_EVAL_MODE;
      else process.env.SKILL_EVAL_MODE = previous;
    }
  });

});
