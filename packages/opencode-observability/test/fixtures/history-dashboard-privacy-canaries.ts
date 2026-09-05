import { createHash } from 'node:crypto';

// Private canary definitions - NEVER exported as raw values; only through builder
const PRIVATE_CANARIES = Object.freeze({
  promptBody: 'CANARY_PROMPT_9f3k2mPqXvR7tYbN',
  toolInput: 'CANARY_TOOLINPUT_4jK8sL2mN9pQ',
  toolOutput: 'CANARY_TOOLOUTPUT_3xZ7vB4nM2kL',
  generationOptions: 'CANARY_GENOPTS_6pQ2mX8vR4tY',
  providerOptions: 'CANARY_PROVIDER_5kL9nM3xZ7vB',
  headerValue: 'CANARY_HEADER_2mPqXvR7tYbN4jK',
  authorizationBearer: 'CANARY_BEARER_7x2pQ8sL3mN9vB',
  launchToken: 'CANARY_LAUNCH_4kL2mPqXvR7tYbN9',
  unrestrictedPath: '/CANARY_PATH_9f3k2mPqXvR7tY',
  rawStack: 'CANARY_STACK_5xZ7vB4nM2kL9pQ3',
  rawError: 'CANARY_ERROR_3mN9vB4kL2pQ8sL',
  credentialTitle: 'sk-CANARYCRED6pQ2mX8vR4tYbN9jK'
} as const);

export type CanaryKey = keyof typeof PRIVATE_CANARIES;

export interface CanarySet {
  readonly values: readonly string[];
  readonly hash: string;
  scan(haystack: string, label: string): { totalOccurrences: number; locations: string[] };
  assertNo(r: { totalOccurrences: number }, label: string): void;
  get<K extends CanaryKey>(k: K): string;
}

export function createCanarySet(): CanarySet {
  const ALL = Object.values(PRIVATE_CANARIES);
  const HASH = createHash('sha256').update(ALL.join('|')).digest('hex').slice(0, 16);

  function scan(haystack: string, label: string) {
    const locations: string[] = [];
    let total = 0;
    for (const c of ALL) {
      let i = haystack.indexOf(c);
      while (i !== -1) {
        total++;
        locations.push(`${label}@${i}`);
        i = haystack.indexOf(c, i + 1);
      }
    }
    return { totalOccurrences: total, locations };
  }

  function assertNo(r: { totalOccurrences: number }, label: string) {
    if (r.totalOccurrences !== 0) {
      throw new Error(`Leak in ${label}`);
    }
  }

  return {
    values: ALL,
    hash: HASH,
    scan,
    assertNo,
    get: (k) => PRIVATE_CANARIES[k]
  };
}
