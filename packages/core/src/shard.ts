import { createHash } from 'node:crypto';
import { LOGICAL_SHARDS } from './config.js';

/** Routing key persisted in every row's shard_id. Same algorithm as packages/db/src/shard.ts. */
export function shardFor(customerId: string, shards = LOGICAL_SHARDS): number {
  return createHash('sha256').update(customerId).digest().readUInt32BE(0) % shards;
}
