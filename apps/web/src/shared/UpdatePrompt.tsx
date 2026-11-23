import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * Registers the service worker and shows "Update available" when a new version is waiting.
 * Section 4: updates apply only when no events are pending and no sale is in progress.
 * M0 has no outbox, so the button applies the update directly; M3 adds the gate.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-3 top-3 z-50 flex items-center justify-between gap-3 rounded-xl bg-amber-400 p-3 text-slate-950 shadow-lg"
    >
      <span className="font-semibold">Update available</span>
      <button
        type="button"
        className="min-h-11 rounded-lg bg-slate-950 px-4 font-semibold text-white active:scale-95"
        onClick={() => void updateServiceWorker(true)}
      >
        Update
      </button>
    </div>
  );
}
