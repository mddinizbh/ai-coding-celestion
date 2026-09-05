import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkBearerAuthorization,
  checkOrigin,
  createTokenFactory,
  securityHeaders
} from '../src/server-security';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_BYTE_COUNT = 32;
const BASE64URL_TOKEN_LENGTH = 43; // 32 bytes -> 43 unpadded base64url chars

const EXPECTED_SECURITY_HEADERS: Record<string, string> = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'"
};

const EXPECTED_ORIGIN = 'http://127.0.0.1:9911';

/** Deterministic different token with the same length as a real one (43 chars). */
function equalLengthWrongToken(realToken: string): string {
  const firstChar = realToken.charAt(0);
  const replacement = firstChar === 'A' ? 'B' : 'A';
  return replacement + realToken.slice(1);
}

describe('server security token factory', () => {
  it('generates a 43-char base64url token without padding for every generation', () => {
    const factory = createTokenFactory();
    for (let index = 0; index < 200; index += 1) {
      const token = factory.generateToken();
      assert.match(token, BASE64URL_PATTERN);
      assert.equal(token.length, BASE64URL_TOKEN_LENGTH);
      assert.ok(!token.includes('='));
      assert.ok(!token.includes('+'));
      assert.ok(!token.includes('/'));
    }
  });

  it('generates unique tokens across 1000 generations', () => {
    const factory = createTokenFactory();
    const seen = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      seen.add(factory.generateToken());
    }
    assert.equal(seen.size, 1000);
  });

  it('requests exactly 32 random bytes per generation', () => {
    const requestedByteCounts: number[] = [];
    const factory = createTokenFactory((byteCount) => {
      requestedByteCounts.push(byteCount);
      return Buffer.alloc(byteCount, 1);
    });
    factory.generateToken();
    factory.generateToken();
    assert.deepEqual(requestedByteCounts, [TOKEN_BYTE_COUNT, TOKEN_BYTE_COUNT]);
  });

  it('encodes the injected random bytes as base64url', () => {
    const factory = createTokenFactory(() => Buffer.alloc(TOKEN_BYTE_COUNT, 1));
    const expectedToken = Buffer.alloc(TOKEN_BYTE_COUNT, 1).toString('base64url');
    assert.equal(factory.generateToken(), expectedToken);
    assert.equal(factory.generateToken(), expectedToken);
  });
});

describe('checkBearerAuthorization', () => {
  const token = createTokenFactory().generateToken();

  it('accepts an exact case-sensitive "Bearer <token>" header', () => {
    const result = checkBearerAuthorization(`Bearer ${token}`, token);
    assert.deepEqual(result, { ok: true });
  });

  const failureHeaders: readonly string[] = [
    '',
    `Basic ${token}`,
    `bearer ${token}`,
    `BEARER ${token}`,
    `Bearer${token}`,
    'Bearer',
    'Bearer ',
    `Bearer  ${token}`,
    `Bearer ${token} `,
    ` Bearer ${token}`,
    `Bearer ${token} extra`
  ];

  for (const [index, header] of failureHeaders.entries()) {
    it(`rejects malformed header #${index + 1} with generic 401`, () => {
      const result = checkBearerAuthorization(header, token);
      assert.deepEqual(result, { ok: false, status: 401 });
    });
  }

  it('rejects a missing header with generic 401', () => {
    const result = checkBearerAuthorization(undefined, token);
    assert.deepEqual(result, { ok: false, status: 401 });
  });

  it('rejects a wrong token of the SAME length as the real one (constant-time path)', () => {
    const wrongToken = equalLengthWrongToken(token);
    assert.equal(wrongToken.length, token.length);
    assert.notEqual(wrongToken, token);
    const result = checkBearerAuthorization(`Bearer ${wrongToken}`, token);
    assert.deepEqual(result, { ok: false, status: 401 });
  });

  it('rejects a wrong-length token without throwing (length-safe comparison)', () => {
    const shortResult = checkBearerAuthorization('Bearer a', token);
    assert.deepEqual(shortResult, { ok: false, status: 401 });
    const longResult = checkBearerAuthorization(`Bearer ${token}${token}`, token);
    assert.deepEqual(longResult, { ok: false, status: 401 });
  });

  it('never reflects the token or presented credential in any failure result', () => {
    const presentedCredentials = [
      token,
      equalLengthWrongToken(token),
      'tooshortwrongsecret',
      `${token}${token}`,
      'wrong-credential-value'
    ];
    for (const credential of presentedCredentials) {
      const result = checkBearerAuthorization(`Bearer ${credential}`, token);
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(credential), 'failure result leaked the presented credential');
      assert.ok(!serialized.includes(token), 'failure result leaked the expected token');
    }
    const missingResult = checkBearerAuthorization(undefined, token);
    assert.ok(!JSON.stringify(missingResult).includes(token));
  });
});

describe('securityHeaders', () => {
  it('returns the exact security headers map', () => {
    assert.deepEqual(securityHeaders(), EXPECTED_SECURITY_HEADERS);
  });

  it('CSP pins base-uri, object-src and frame-ancestors to none', () => {
    const headers = securityHeaders();
    const csp = headers['Content-Security-Policy'];
    assert.ok(csp !== undefined);
    assert.ok(csp.includes("base-uri 'none'"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
  });

  it('never emits Access-Control-Allow-Origin', () => {
    const serialized = JSON.stringify(securityHeaders());
    assert.ok(!serialized.includes('Access-Control-Allow-Origin'));
    assert.ok(!serialized.includes('*'));
  });

  it('returns a fresh map per call (caller mutation cannot poison other responses)', () => {
    const first = securityHeaders();
    const second = securityHeaders();
    assert.notEqual(first, second);
    first['X-Frame-Options'] = 'SAMEORIGIN';
    assert.equal(second['X-Frame-Options'], 'DENY');
  });
});

describe('checkOrigin', () => {
  it('allows an absent Origin (same-origin or non-browser client)', () => {
    assert.deepEqual(checkOrigin(undefined, EXPECTED_ORIGIN), { ok: true });
  });

  it('allows an Origin exactly equal to the expected origin', () => {
    assert.deepEqual(checkOrigin(EXPECTED_ORIGIN, EXPECTED_ORIGIN), { ok: true });
  });

  const foreignOrigins: readonly string[] = [
    'http://localhost:9911',
    'http://127.0.0.1:9912',
    'https://127.0.0.1:9911',
    'http://evil.example.com',
    'http://127.0.0.1:9911.evil.example.com',
    'null',
    '',
    'not-a-url'
  ];

  for (const [index, origin] of foreignOrigins.entries()) {
    it(`rejects foreign origin #${index + 1} with generic 403`, () => {
      const result = checkOrigin(origin, EXPECTED_ORIGIN);
      assert.deepEqual(result, { ok: false, status: 403 });
    });
  }

  it('never reflects the presented origin in the failure result', () => {
    const result = checkOrigin('http://evil.example.com', EXPECTED_ORIGIN);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('evil.example.com'));
    assert.ok(!serialized.includes(EXPECTED_ORIGIN));
  });
});

describe('server security module surface canary', () => {
  it('exports exactly the four security functions and no CORS helper', async () => {
    const moduleNamespace = await import('../src/server-security');
    assert.deepEqual(Object.keys(moduleNamespace).sort(), [
      'checkBearerAuthorization',
      'checkOrigin',
      'createTokenFactory',
      'securityHeaders'
    ]);
  });

  it('no serialized output of any branch contains a secret or CORS header', () => {
    const token = createTokenFactory().generateToken();
    const wrongToken = equalLengthWrongToken(token);
    const outputs: readonly unknown[] = [
      checkBearerAuthorization(undefined, token),
      checkBearerAuthorization('Basic abc', token),
      checkBearerAuthorization(`Bearer ${wrongToken}`, token),
      checkBearerAuthorization(`Bearer ${token}`, token),
      checkBearerAuthorization(`Bearer ${wrongToken}${wrongToken}`, token),
      checkOrigin(undefined, EXPECTED_ORIGIN),
      checkOrigin(EXPECTED_ORIGIN, EXPECTED_ORIGIN),
      checkOrigin('http://evil.example.com', EXPECTED_ORIGIN),
      securityHeaders()
    ];
    const serializedOutputs = outputs.map((output) => JSON.stringify(output)).join('\n');
    assert.ok(!serializedOutputs.includes(token), 'outputs leaked the expected token');
    assert.ok(!serializedOutputs.includes(wrongToken), 'outputs leaked the presented credential');
    assert.ok(!serializedOutputs.includes('Access-Control-Allow-Origin'), 'outputs emitted CORS');
  });
});
