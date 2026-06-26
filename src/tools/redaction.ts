/**
 * Secret redaction for tool outputs and logs. Defense-in-depth: even though the
 * denylist blocks reading secret *files*, source files and search snippets can
 * still contain inline credentials. Everything returned to the model or written
 * to logs passes through `redact`.
 */

interface Pattern {
  type: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  {
    type: 'private-key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  { type: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    type: 'assignment-secret',
    // password = "...", api_key: '...', secret=...
    re: /\b(pass(?:word)?|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"]?([^\s'"]{6,})['"]?/gi,
  },
];

/** Replace any detected secrets with a typed placeholder. */
export function redact(text: string): string {
  let out = text;
  for (const { type, re } of PATTERNS) {
    if (type === 'assignment-secret') {
      out = out.replace(re, (_m, key: string) => `${key}=«redacted:secret»`);
    } else {
      out = out.replace(re, `«redacted:${type}»`);
    }
  }
  return out;
}

/** Bound a string to a max length, appending a clear truncation marker. */
export function clamp(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n…«truncated»`, truncated: true };
}
