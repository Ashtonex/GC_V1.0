import { z } from 'zod';
import { TripEvent } from './events.ts';

/**
 * Wire format of the `ingest-events` API (M2). The driver's outbox (M3) sends batches like this.
 *
 * - Every id is a client-generated UUID (Section 2 #8). The engine accepts any string (readable fixtures);
 *   ingestion is strict.
 * - `sentAt` is the device clock at upload. The server compares it with its own clock to detect a wrong
 *   phone clock and flags every event in the batch (D-024, approved).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export const MAX_BATCH = 500;

export const IngestBatch = z.object({
  /** The registered device sending the batch. Office users on a browser may omit it. */
  deviceId: z.string().regex(UUID, 'deviceId must be a UUID').optional(),
  sentAt: z.iso.datetime({ offset: true }),
  events: z.array(z.unknown()).min(1).max(MAX_BATCH),
});
export type IngestBatch = z.infer<typeof IngestBatch>;

export const INGEST_STATUSES = ['accepted', 'duplicate', 'conflict', 'rejected', 'quarantined'] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

export interface IngestEventResult {
  id: string | null;
  status: IngestStatus;
  /** Plain-language reason for conflict / rejected / quarantined. */
  error?: string;
}

export interface IngestResponse {
  /** `device_revoked`: the phone must return to sign-in; its events went to quarantine (Scenario E). */
  batch: 'ok' | 'device_revoked';
  clockSkew: boolean;
  results: IngestEventResult[];
}

/** Every key that holds an id in a trip event. All must be UUIDs at ingestion. */
const ID_KEYS = new Set([
  'id',
  'tripId',
  'actorId',
  'deviceId',
  'handoverId',
  'issuerId',
  'receiverId',
  'productId',
  'saleId',
  'customerId',
  'lineId',
  'paymentId',
  'collectionId',
  'expenseId',
  'reversesEventId',
  'rateId',
]);

function nonUuidIds(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) value.forEach((v, i) => nonUuidIds(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (ID_KEYS.has(k) && !isUuid(v)) out.push(`${path}${k}`);
      else nonUuidIds(v, `${path}${k}.`, out);
    }
  }
}

/** Events a client may send. `TRIP_STATUS_CHANGED` is written only by the server. */
export const CLIENT_EVENT_TYPES = TripEvent.options
  .map((o) => o.def.shape.type.value)
  .filter((t) => t !== 'TRIP_STATUS_CHANGED');

export type ParsedIngestEvent = { ok: true; event: TripEvent } | { ok: false; id: string | null; error: string };

/** Validates one event for ingestion: the shared Zod schema, UUID ids, sale id = event id, client-sendable type. */
export function parseIngestEvent(raw: unknown): ParsedIngestEvent {
  const rawId = raw && typeof raw === 'object' && 'id' in raw ? (raw as { id: unknown }).id : null;
  const id = typeof rawId === 'string' ? rawId : null;
  const parsed = TripEvent.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, id, error: `invalid event: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim() };
  }
  const event = parsed.data;
  if (event.type === 'TRIP_STATUS_CHANGED') return { ok: false, id, error: 'TRIP_STATUS_CHANGED is server-only' };
  const bad: string[] = [];
  nonUuidIds(event, '', bad);
  if (bad.length) return { ok: false, id, error: `ids must be UUIDs: ${bad.join(', ')}` };
  // Section 6 D: the sale id is the idempotency key, so it must be the event id.
  if (event.type === 'SALE_RECORDED' && event.saleId !== event.id) {
    return { ok: false, id, error: 'saleId must equal the event id' };
  }
  if (event.type === 'SALE_RECORDED' && event.lines.some((l) => l.unitCostSnapshot)) {
    // Section 4B rule 5: cost snapshots are written by the server, never supplied by a device.
    return { ok: false, id, error: 'unitCostSnapshot must not be sent by a client' };
  }
  return { ok: true, event };
}
