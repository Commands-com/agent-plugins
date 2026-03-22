import fs from 'node:fs';
import path from 'node:path';

function isUnderAnyRoot(realPath, realRoots) {
  return realRoots.some(
    (root) => realPath === root || realPath.startsWith(root + path.sep),
  );
}

export function validatePathArgsWithinProject(projectDirOrRoots, program, args, fileReadingPrograms) {
  if (!fileReadingPrograms.has(program)) return;

  const roots = Array.isArray(projectDirOrRoots) ? projectDirOrRoots : [projectDirOrRoots];
  const realRoots = roots.map((r) => fs.realpathSync(r));
  const primaryRoot = realRoots[0];

  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('-')) continue;

    const resolved = path.resolve(primaryRoot, arg);
    let realPath = resolved;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      realPath = resolved;
    }

    if (!isUnderAnyRoot(realPath, realRoots)) {
      throw new Error(`Path argument escapes allowed directories: ${arg}`);
    }
  }
}
