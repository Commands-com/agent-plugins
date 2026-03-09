import fs from 'node:fs';
import path from 'node:path';

/**
 * Check whether a resolved real path falls under any of the given root directories.
 */
function isUnderAnyRoot(realPath, realRoots) {
  return realRoots.some(
    (root) => realPath === root || realPath.startsWith(root + path.sep),
  );
}

/**
 * Enforce that non-flag path arguments resolve within the allowed directories.
 * Accepts a single projectDir (string) or an array of allowed roots.
 * This catches direct paths and symlink escapes.
 */
export function validatePathArgsWithinProject(projectDirOrRoots, program, args, fileReadingPrograms) {
  if (!fileReadingPrograms.has(program)) return;

  const roots = Array.isArray(projectDirOrRoots) ? projectDirOrRoots : [projectDirOrRoots];
  const realRoots = roots.map((r) => fs.realpathSync(r));
  const primaryRoot = realRoots[0];

  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('-')) continue;

    // Resolve relative paths against the primary root
    const resolved = path.resolve(primaryRoot, arg);
    let realPath = resolved;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      // Non-existent paths still resolve relative to primaryRoot and must stay contained.
      realPath = resolved;
    }

    if (!isUnderAnyRoot(realPath, realRoots)) {
      throw new Error(`Path argument escapes allowed directories: ${arg}`);
    }
  }
}
