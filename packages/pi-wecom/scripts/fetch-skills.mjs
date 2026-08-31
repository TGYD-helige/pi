/**
 * Fetches the latest wecom-cli skills from GitHub and writes them to the skills/ directory.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', 'skills');
const REPO = 'WecomTeam/wecom-cli';
const REMOTE_PATH = 'skills';

async function fetchSkills() {
  console.log('[pi-wecom] Fetching skills from github.com/%s ...', REPO);

  const tmpDir = join(__dirname, '..', '.tmp-skills-fetch');
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    execSync(
      `git clone --depth 1 --filter=blob:none --sparse https://github.com/${REPO}.git .`,
      { cwd: tmpDir, stdio: 'pipe' },
    );
    execSync(`git sparse-checkout set ${REMOTE_PATH}`, { cwd: tmpDir, stdio: 'pipe' });

    const srcSkills = join(tmpDir, REMOTE_PATH);
    if (!existsSync(srcSkills)) {
      throw new Error(`Skills directory not found at ${srcSkills}`);
    }

    rmSync(SKILLS_DIR, { recursive: true, force: true });
    cpSync(srcSkills, SKILLS_DIR, { recursive: true });
    console.log('[pi-wecom] Skills fetched successfully.');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

fetchSkills().catch((err) => {
  console.error('[pi-wecom] Failed to fetch skills:', err.message);
  process.exitCode = 1;
});
