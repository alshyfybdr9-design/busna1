import type { Db } from '../db/pool.js';

export type OutboxKind =
  | 'trip_started'
  | 'trip_cancelled'
  | 'rider_event'
  | 'safety_alert'
  | 'absence_updated'
  | 'ticket_event'
  | 'broadcast'
  | 'bus_approaching'
  | 'no_receiver'
  | 'stop_change_updated';

/**
 * يُكتب الحدث في نفس معاملة التغيير (Transactional Outbox)،
 * ثم يعالجه العامل الخلفي ويحوّله إلى إشعارات بدون تكرار.
 */
export async function enqueue(c: Db, tenantId: string, kind: OutboxKind, payload: Record<string, unknown>, dedupeKey?: string) {
  await c.query(
    `insert into outbox_events (tenant_id, kind, payload, dedupe_key) values ($1, $2, $3, $4) on conflict do nothing`,
    [tenantId, kind, JSON.stringify(payload), dedupeKey ?? null],
  );
}
