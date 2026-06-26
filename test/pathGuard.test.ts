import { describe, expect, it } from 'vitest';
import type { AccessConfig } from '../src/config/schema';
import { globToRegExp, isPathDenied, resolveInsideRepo } from '../src/tools/pathGuard';
import { BetterCodeError } from '../src/types';

const ACCESS: AccessConfig = {
  denyGlobs: ['**/.env', '**/node_modules/**', '**/*.pem', '**/secrets/**'],
  allowGlobs: ['**/*'],
  maxBinaryBytesProbe: 8192,
};

describe('resolveInsideRepo', () => {
  it('resolves a normal relative path', () => {
    const { relPath } = resolveInsideRepo('/repo', 'src/app.ts');
    expect(relPath).toBe('src/app.ts');
  });

  it('rejects path traversal', () => {
    expect(() => resolveInsideRepo('/repo', '../etc/passwd')).toThrow(BetterCodeError);
    expect(() => resolveInsideRepo('/repo', 'src/../../x')).toThrow(/escapes/);
  });

  it('rejects absolute paths and null bytes', () => {
    expect(() => resolveInsideRepo('/repo', '/etc/passwd')).toThrow(/absolute/);
    expect(() => resolveInsideRepo('/repo', 'a\0b')).toThrow(/null byte/);
  });
});

describe('globToRegExp', () => {
  it('matches ** across segments and * within a segment', () => {
    expect(globToRegExp('**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('**/node_modules/**').test('a/node_modules/x/y.js')).toBe(true);
  });
});

describe('isPathDenied', () => {
  it('denies secret/dependency paths, allows source', () => {
    expect(isPathDenied('.env', ACCESS)).toBe(true);
    expect(isPathDenied('config/.env', ACCESS)).toBe(true);
    expect(isPathDenied('node_modules/pkg/index.js', ACCESS)).toBe(true);
    expect(isPathDenied('certs/server.pem', ACCESS)).toBe(true);
    expect(isPathDenied('secrets/prod/value', ACCESS)).toBe(true);
    expect(isPathDenied('src/app.ts', ACCESS)).toBe(false);
  });
});
