import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type { AccessConfig } from '../config/schema';
import { BetterCodeError } from '../types';

/**
 * Path & access guards. Every file the tools touch passes through here. The
 * threat model assumes the LLM (and the repo contents) are adversarial, so this
 * enforces: (1) no escape from the pinned worktree, (2) denylist for secret /
 * non-source files, (3) optional allowlist.
 */

/** Convert a possibly Windows path to forward-slash, repo-relative posix form. */
function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Resolve a model-supplied relative path against the worktree root and prove it
 * stays inside. Rejects absolute paths, `..` traversal, and (via realpath at the
 * call site) symlink escapes. Returns the absolute path and the normalized
 * repo-relative path.
 */
export function resolveInsideRepo(
  worktreeRoot: string,
  inputPath: string,
): { absPath: string; relPath: string } {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new BetterCodeError('INTERNAL', 'path must be a non-empty string');
  }
  if (inputPath.includes('\0')) {
    throw new BetterCodeError('INTERNAL', 'path contains a null byte');
  }
  if (isAbsolute(inputPath)) {
    throw new BetterCodeError('INTERNAL', 'absolute paths are not allowed');
  }
  const root = resolve(worktreeRoot);
  const abs = resolve(root, normalize(inputPath));
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new BetterCodeError('INTERNAL', `path escapes repo root: ${inputPath}`);
  }
  return { absPath: abs, relPath: toPosix(rel) };
}

/**
 * Second line of defense against symlinks that point outside the worktree.
 * Call after resolveInsideRepo, before reading, on the *real* resolved path.
 */
export async function assertRealPathInside(worktreeRoot: string, absPath: string): Promise<void> {
  const root = await realpath(resolve(worktreeRoot));
  let real: string;
  try {
    real = await realpath(absPath);
  } catch {
    // Non-existent path: nothing to escape via symlink. Existence is checked
    // separately by the caller.
    return;
  }
  const rel = relative(root, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new BetterCodeError('INTERNAL', 'symlink escapes repo root');
  }
}

/** Compile a glob (supporting **, *, ?) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` matches zero or more leading segments
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(relPath: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(relPath));
}

/** True if the path is blocked by the access policy (deny wins over allow). */
export function isPathDenied(relPath: string, access: AccessConfig): boolean {
  if (matchesAny(relPath, access.denyGlobs)) return true;
  if (access.allowGlobs.length > 0 && !matchesAny(relPath, access.allowGlobs)) return true;
  return false;
}

export function assertPathAllowed(relPath: string, access: AccessConfig): void {
  if (isPathDenied(relPath, access)) {
    throw new BetterCodeError('INTERNAL', `access denied by policy: ${relPath}`);
  }
}

/** Heuristic binary sniff: a NUL byte in the probe window means binary. */
export function looksBinary(buf: Buffer, probeBytes: number): boolean {
  const n = Math.min(buf.length, probeBytes);
  for (let i = 0; i < n; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}
