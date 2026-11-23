import { describe, expect, it } from 'vitest';
import { syncStatusLabel } from './syncStatus';
import { shellForPath } from './shellForPath';

describe('syncStatusLabel', () => {
  const at1402 = new Date(2026, 10, 22, 14, 2);

  it('treats offline as a normal state with a queue count', () => {
    expect(syncStatusLabel({ online: false, pending: 3, lastSync: at1402 })).toBe('Offline · 3 queued');
  });

  it('shows pending events when online but not yet synced', () => {
    expect(syncStatusLabel({ online: true, pending: 1, lastSync: null })).toBe('1 event pending');
    expect(syncStatusLabel({ online: true, pending: 5, lastSync: null })).toBe('5 events pending');
  });

  it('shows a short label when online with nothing ever synced (fits a 360px header)', () => {
    expect(syncStatusLabel({ online: true, pending: 0, lastSync: null })).toBe('Online');
  });

  it('shows last sync time as HH:MM', () => {
    expect(syncStatusLabel({ online: true, pending: 0, lastSync: at1402 })).toBe('Synced 14:02');
  });
});

describe('shellForPath', () => {
  it('routes /office to the office shell and everything else to the driver shell', () => {
    expect(shellForPath('/office')).toBe('office');
    expect(shellForPath('/office/trips')).toBe('office');
    expect(shellForPath('/')).toBe('driver');
    expect(shellForPath('/officers')).toBe('driver');
  });
});
