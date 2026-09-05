import { z } from 'zod';

const CREDENTIAL_PATTERNS = [
  /\bauthorization\s*:\s*bearer\s+[a-zA-Z0-9._~+/=-]{10,}\b/gi,
  /\bbearer\s+[a-zA-Z0-9._~+/=-]{10,}\b/gi,
  /sk-[a-zA-Z0-9]{10,}/g,
  /AIza[0-9A-Za-z\-_]{20,}/g,
  /\bgh(?:p|o|u|s|r)_[a-zA-Z0-9_]{20,}\b/g,
  /\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /password[=:]\S+/gi,
  /api[_-]?key[=:]\S+/gi,
  /secret[=:]\S+/gi,
  /token[=:]\S+/gi
];

const SAFE_EMPTY_TITLE = '(untitled session)';

export function sanitizeSessionTitle(input: string): string {
  if (input.length === 0) {
    return SAFE_EMPTY_TITLE;
  }

  let normalized = input
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const pattern of CREDENTIAL_PATTERNS) {
    normalized = normalized.replace(pattern, '[REDACTED]');
  }

  if (normalized.length === 0) {
    return SAFE_EMPTY_TITLE;
  }

  // Unicode code-point cap (preserves surrogate pairs)
  const codePoints = Array.from(normalized);
  if (codePoints.length > 160) {
    normalized = codePoints.slice(0, 160).join('');
  }

  return normalized;
}

export const titleSanitizerSchema = z.string().transform((val) => sanitizeSessionTitle(val));
