/* eslint-disable no-void */
import { createHash } from 'crypto';

import type { EvalRunnerInitPayload } from './protocol';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const canonicalizeForHash = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForHash(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeForHash(value[key])])
    );
  }

  return value;
};

// Hash everything in the init payload that affects whether the runner needs
// a fresh INIT. `entrypoint` only controls __filename/__dirname rebinding and
// is deliberately excluded so callers can memoize the stable configuration.
export const getStableInitPayloadHash = (
  payload: EvalRunnerInitPayload
): string => {
  const { entrypoint, ...stable } = payload;
  void entrypoint;

  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(stable)))
    .digest('hex');
};
