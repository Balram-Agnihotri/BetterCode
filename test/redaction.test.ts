import { describe, expect, it } from 'vitest';
import { redact } from '../src/tools/redaction';

describe('redact', () => {
  it('redacts AWS access keys', () => {
    expect(redact('key=AKIAIOSFODNN7EXAMPLE here')).toContain('«redacted:aws-access-key»');
  });

  it('redacts private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabcDEF123\n-----END RSA PRIVATE KEY-----';
    expect(redact(pem)).toBe('«redacted:private-key»');
  });

  it('redacts slack and github tokens', () => {
    expect(redact('xoxb-TEST1234567890')).toContain('«redacted:slack-token»');
    expect(redact('ghp_TESTtoken1234567890ABCDE')).toContain('«redacted:github-token»');
  });

  it('redacts inline secret assignments but keeps the key name', () => {
    const out = redact('const password = "hunter2supersecret"');
    expect(out).toContain('password=«redacted:secret»');
    expect(out).not.toContain('hunter2supersecret');
  });

  it('leaves ordinary code untouched', () => {
    const code = 'function add(a, b) { return a + b; }';
    expect(redact(code)).toBe(code);
  });
});
