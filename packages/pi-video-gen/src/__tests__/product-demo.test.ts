import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('product demo frame adapter', () => {
  it('reconstructs the request and result from time even when seeking backwards', async () => {
    const fixtureUrl = pathToFileURL(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../skills/video-gen/examples/continuous-demo/product/fixture.mjs',
      ),
    ).href;
    const { stateAtTime } = await import(fixtureUrl);
    const result = stateAtTime(6);
    expect(result).toMatchObject({
      request: '整理本周已发布的更新',
      status: 'done',
      updates: ['接入产品组件', '独立调整音乐与音效', '检查转场前后的画面'],
    });
    expect(stateAtTime(0)).toEqual({ request: '', status: 'draft', updates: [] });
    expect(stateAtTime(3.2)).toMatchObject({ request: '整理本周已发布的更新', status: 'running' });
    expect(stateAtTime(1.5)).toMatchObject({ request: '整理本周', status: 'draft' });
    expect(stateAtTime(6)).toEqual(result);
  });
});
