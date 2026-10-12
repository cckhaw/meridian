import { createHash } from 'node:crypto';

export const LOGICAL_SHARDS = 1024;

/** Stable routing key. Must match `abs(hashtext(..)) % 1024` semantics only in spirit:
 *  the app layer is the source of truth, the value is persisted in `shard_id`. */
export function shardFor(customerId: string): number {
  const digest = createHash('sha256').update(customerId).digest();
  return digest.readUInt32BE(0) % LOGICAL_SHARDS;
}
