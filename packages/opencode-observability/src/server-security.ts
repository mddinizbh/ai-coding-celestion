import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto';
import type { Buffer } from 'node:buffer';

export type TokenFactory = {
  readonly generateToken: () => string;
};

export type AuthorizationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 };

export type OriginCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403 };

export type SecurityHeaders = Record<string, string>;

const unauthorizedResult = { ok: false, status: 401 } as const;
const forbiddenResult = { ok: false, status: 403 } as const;
const okResult = { ok: true } as const;
const tokenByteLength = 32;
const bearerPrefix = 'Bearer ';

const dashboardSecurityHeaders = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
} as const satisfies SecurityHeaders;

export function createTokenFactory(randomBytes: (n: number) => Buffer = cryptoRandomBytes): TokenFactory {
  return {
    generateToken: () => randomBytes(tokenByteLength).toString('base64url')
  };
}

export function checkBearerAuthorization(header: string | undefined, token: string): AuthorizationResult {
  if (header === undefined || !header.startsWith(bearerPrefix)) {
    return unauthorizedResult;
  }

  const presentedToken = header.slice(bearerPrefix.length);
  if (presentedToken.length === 0 || presentedToken.includes(' ') || presentedToken.trim() !== presentedToken) {
    return unauthorizedResult;
  }

  return timingSafeDigestEqual(presentedToken, token) ? okResult : unauthorizedResult;
}

export function securityHeaders(): SecurityHeaders {
  return { ...dashboardSecurityHeaders };
}

export function checkOrigin(origin: string | undefined, expectedOrigin: string): OriginCheckResult {
  return origin === undefined || origin === expectedOrigin ? okResult : forbiddenResult;
}

function timingSafeDigestEqual(presentedToken: string, expectedToken: string): boolean {
  const presentedDigest = createHash('sha256').update(presentedToken).digest();
  const expectedDigest = createHash('sha256').update(expectedToken).digest();

  return timingSafeEqual(presentedDigest, expectedDigest);
}
