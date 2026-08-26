import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(path), 'utf8');

describe('security-sensitive workflows', () => {
  it.each(['.github/workflows/ci.yml', '.github/workflows/pr-checks.yml'])(
    'runs fork pull requests with read-only permissions on GitHub-hosted runners in %s',
    (path) => {
      const workflow = read(path);

      expect(workflow).toContain('permissions:\n  contents: read');
      expect(workflow).toContain('runs-on: ubuntu-latest');
      expect(workflow).not.toContain('self-hosted');
      expect(workflow).not.toContain(
        "github.event.pull_request.head.repo.full_name == github.repository",
      );
    },
  );

  it('installs a pinned, checksum-verified Multica release', () => {
    const workflow = read('.github/workflows/integration.yml');

    expect(workflow).not.toContain('multica/main/scripts/install.sh');
    expect(workflow).not.toContain('if ! command -v multica');
    expect(workflow).toContain('multica-cli-0.4.15-linux-amd64.tar.gz');
    expect(workflow).toContain('a7e6db95d24b8fb679c0d46d8756e0a324d5231a249fd1393e9f15a17f80e2aa');
    expect(workflow).toContain('sha256sum -c');
  });

  it('passes matrix prompts through the environment and enforces requested tool counts', () => {
    const workflow = read('.github/workflows/integration.yml');
    const matrix = read('.github/scripts/integration-matrix.mjs');

    expect(workflow).toContain('EXTENSION_PROMPT: ${{ matrix.prompt }}');
    expect(workflow).toContain('-p "$EXTENSION_PROMPT"');
    expect(workflow).not.toContain("-p '${{ matrix.prompt }}'");
    expect(matrix).toContain('assert_tool_count: 1');
    expect(workflow).toContain('--argjson expected_count');
  });
});
