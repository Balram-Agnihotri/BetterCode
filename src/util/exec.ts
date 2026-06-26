import { execFile } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Hard cap on captured stdout bytes; output beyond this is dropped. */
  maxBuffer?: number;
  signal?: AbortSignal;
  /** Treat these non-zero exit codes as success (e.g. ripgrep "no match" = 1). */
  okExitCodes?: number[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Safe command runner. Uses execFile (no shell) so arguments are never word-split
 * or interpreted — this is the only way external binaries (git, rg) are invoked.
 * There is deliberately NO function that takes a shell string.
 */
export function runCommand(
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const { okExitCodes = [0], timeoutMs = 30_000, maxBuffer = 16 * 1024 * 1024 } = opts;
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: timeoutMs,
        maxBuffer,
        signal: opts.signal,
        env: opts.env ?? process.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((error as unknown as { code: number }).code ?? 0)
            : 0;
        if (error && !okExitCodes.includes(code)) {
          // Preserve ENOENT (binary missing) and AbortError for callers.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error(`command not found: ${file}`));
            return;
          }
          if (error.name === 'AbortError') {
            reject(error);
            return;
          }
          reject(new Error(`${file} exited ${code}: ${stderr.slice(0, 2000)}`));
          return;
        }
        resolvePromise({ stdout, stderr, code });
      },
    );
  });
}
