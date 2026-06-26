import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectConfig } from '../config/schema';
import type { Logger } from '../observability/logger';
import { BetterCodeError, type RepoSnapshot } from '../types';
import { runCommand } from '../util/exec';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function gitEnv(sshKeyPath?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (sshKeyPath) {
    env.GIT_SSH_COMMAND = `ssh -i "${sshKeyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
  }
  return env;
}

export interface SnapshotOptions {
  /** Path to a materialized read-only SSH deploy key (from Secrets Manager). */
  sshKeyPath?: string | undefined;
}

/**
 * Manages a single plain clone of the repo under cacheRoot/<project>.
 * On every job: git fetch + reset --hard to get the latest commit, then
 * return that directory as the read-only worktree.
 *
 * Trade-offs (chosen for simplicity at ~100 req/day):
 *   - All concurrent jobs share one working directory (no per-SHA isolation).
 *   - Shallow clone (--depth 100); increase if git blame/log depth is needed.
 */
export class SimpleRepoManager {
  constructor(
    private readonly cacheRoot: string,
    private readonly logger: Logger,
  ) {}

  private repoDir(project: string): string {
    return join(this.cacheRoot, project);
  }

  async getSnapshot(
    project: string,
    cfg: ProjectConfig,
    opts: SnapshotOptions = {},
  ): Promise<RepoSnapshot> {
    const repoDir = this.repoDir(project);
    const env = gitEnv(opts.sshKeyPath);
    try {
      if (await pathExists(join(repoDir, '.git'))) {
        // Existing clone: fetch latest and hard-reset to branch tip.
        this.logger.info({ project }, 'pulling latest repo changes');
        await runCommand('git', ['-C', repoDir, 'fetch', 'origin', cfg.branch], { env, timeoutMs: 180_000 });
        await runCommand('git', ['-C', repoDir, 'reset', '--hard', `origin/${cfg.branch}`], { env, timeoutMs: 30_000 });
        if (cfg.submodules) {
          await runCommand(
            'git',
            ['-C', repoDir, 'submodule', 'update', '--init', '--recursive'],
            { env, timeoutMs: 300_000 },
          );
        }
      } else {
        // First run: shallow clone.
        this.logger.info({ project }, 'cloning repo for the first time');
        await mkdir(this.cacheRoot, { recursive: true });
        await runCommand(
          'git',
          ['clone', '--depth', '100', '--branch', cfg.branch, cfg.repoUrl, repoDir],
          { env, timeoutMs: 300_000 },
        );
        if (cfg.submodules) {
          await runCommand(
            'git',
            ['-C', repoDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1'],
            { env, timeoutMs: 300_000 },
          );
        }
      }

      const { stdout } = await runCommand('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
      const commitSha = stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(commitSha)) {
        throw new BetterCodeError('REPO_UNAVAILABLE', 'could not resolve HEAD to a commit');
      }

      return {
        project,
        commitSha,
        branch: cfg.branch,
        worktreeRoot: repoDir,
        githubWebBaseUrl: cfg.githubWebBaseUrl,
      };
    } catch (err) {
      if (err instanceof BetterCodeError) throw err;
      throw new BetterCodeError('REPO_UNAVAILABLE', `repo sync failed: ${(err as Error).message}`, true);
    }
  }
}
