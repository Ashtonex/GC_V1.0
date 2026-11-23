/**
 * Text for the sync status pill (Section 4 "Offline rules", Section 4C #2).
 * Offline is a normal state, so the wording is neutral, never an error.
 * In M0 nothing is queued yet; the real outbox count arrives in M3.
 */
export interface SyncStatusInput {
  online: boolean;
  pending: number;
  lastSync: Date | null;
}

export function formatHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function syncStatusLabel({ online, pending, lastSync }: SyncStatusInput): string {
  if (!online) return `Offline · ${pending} queued`;
  if (pending > 0) return `${pending} ${pending === 1 ? 'event' : 'events'} pending`;
  return lastSync ? `Synced ${formatHHMM(lastSync)}` : 'Online';
}
