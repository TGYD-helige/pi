import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';

export const CREDENTIAL_BROWSER_TCB = Object.freeze({
  package: 'chrome-devtools-mcp',
  version: '1.6.0',
  mode: 'puppeteer_pipe',
  buildFileCount: 348,
  buildTreeSha256: 'c75935d92332a872c15afb42b36d8488347d03e0f257cd87b107556f9adf1e5c',
});

const require = createRequire(import.meta.url);

export function credentialBrowserConfig(userDataDir: string) {
  return {
    sessionMode: 'persistent' as const,
    userDataDir,
    usageStatistics: false,
    categoryNetwork: false,
    experimentalPageIdRouting: true,
  };
}

export function credentialBrowserChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = source[key];
      return typeof value === 'string' && value.length > 0 ? [[key, value]] : [];
    }),
  );
}

export function attestCredentialBrowserTcb(
  packageManifestPath = require.resolve('chrome-devtools-mcp/package.json'),
): typeof CREDENTIAL_BROWSER_TCB {
  const manifest = JSON.parse(readFileSync(packageManifestPath, 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    manifest.name !== CREDENTIAL_BROWSER_TCB.package ||
    manifest.version !== CREDENTIAL_BROWSER_TCB.version
  ) {
    throw new Error('browser_credential_tcb_version_mismatch');
  }
  const buildRoot = join(dirname(packageManifestPath), 'build', 'src');
  const { fileCount, sha256 } = hashRegularFileTree(buildRoot);
  if (
    fileCount !== CREDENTIAL_BROWSER_TCB.buildFileCount ||
    sha256 !== CREDENTIAL_BROWSER_TCB.buildTreeSha256
  ) {
    throw new Error('browser_credential_tcb_digest_mismatch');
  }
  return CREDENTIAL_BROWSER_TCB;
}

export function hashRegularFileTree(root: string): { fileCount: number; sha256: string } {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(path);
    }
  };
  walk(root);
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(relative(root, file).replaceAll('\\', '/'));
    digest.update(Buffer.from([0]));
    digest.update(readFileSync(file));
    digest.update(Buffer.from([0]));
  }
  return { fileCount: files.length, sha256: digest.digest('hex') };
}
