import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const governedTools = new Set(['read', 'fffind', 'ffgrep']);
const blocked = {
  block: true,
  reason: 'Read-only review tools may only access the pull request workspace and trusted review inputs',
};

function realFile(filePath, label) {
  if (!filePath) throw new Error(`Pi review ${label} is not configured`);
  if (lstatSync(filePath).isSymbolicLink()) throw new Error(`Pi review ${label} must not be a symbolic link`);
  return realpathSync(filePath);
}

function validateSymlinks(directory, root, rootPrefix = `${root}${path.sep}`) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === '.git') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(entryPath);
      } catch {
        throw new Error('Pi review workspace contains an unsafe symbolic link');
      }
      if (target !== root && !target.startsWith(rootPrefix)) {
        throw new Error('Pi review workspace contains an unsafe symbolic link');
      }
    } else if (entry.isDirectory()) {
      validateSymlinks(entryPath, root, rootPrefix);
    }
  }
}

function safeWorkspacePath(value, workspace, root) {
  if (value === undefined || value === '') return true;
  if (typeof value !== 'string' || value.includes('\0')) return false;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const normalized = trimmed.replaceAll('\\', '/');
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('~') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized)) return false;
  const resolved = path.resolve(workspace, trimmed);
  return resolved === workspace
    || resolved.startsWith(`${workspace}${path.sep}`)
    || resolved === root
    || resolved.startsWith(`${root}${path.sep}`);
}

export function createReviewToolGuard({ workspace, diffPath, skillPath }) {
  const workspacePath = path.resolve(workspace);
  const root = realFile(workspace, 'workspace');
  const allowedFiles = new Set([
    realFile(diffPath, 'diff'),
    realFile(skillPath, 'Ponytail skill'),
  ]);
  validateSymlinks(root, root);

  return (event, context) => {
    if (!governedTools.has(event?.toolName)) return;
    try {
      if (realpathSync(context?.cwd) !== root) return blocked;
    } catch {
      return blocked;
    }
    if (event.toolName !== 'read') return safeWorkspacePath(event?.input?.path, workspacePath, root) ? undefined : blocked;
    const requested = event?.input?.path;
    if (typeof requested !== 'string' || !requested || requested.includes('\0')) return blocked;
    if (safeWorkspacePath(requested, workspacePath, root)) return;
    try {
      const resolved = path.isAbsolute(requested) ? requested : path.resolve(context.cwd, requested);
      const real = realpathSync(resolved);
      return allowedFiles.has(real) ? undefined : blocked;
    } catch {
      return blocked;
    }
  };
}

export default function reviewReadonlyGuard(pi) {
  const guard = createReviewToolGuard({
    workspace: process.env.PI_REVIEW_WORKSPACE,
    diffPath: process.env.PI_REVIEW_DIFF,
    skillPath: process.env.PI_PONYTAIL_REVIEW_SKILL,
  });
  pi.on('tool_call', guard);
}
