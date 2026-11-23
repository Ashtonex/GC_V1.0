import { useOnline } from '../shared/useOnline';
import { syncStatusLabel } from '../shared/syncStatus';

const NAV = ['Trip', 'Sell', 'Cash', 'More'] as const;

/**
 * M0 placeholder driver shell. Proves layout rules from Section 4C (status pill, thumb-zone bottom bar
 * with safe-area padding, 44px targets, full-width primary action) and that the shell opens offline.
 * No map, ever, in the driver app (Section 3).
 */
export function DriverShell() {
  const online = useOnline();
  const label = syncStatusLabel({ online, pending: 0, lastSync: null });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3">
        <h1 className="text-lg font-bold tracking-tight">Game Command</h1>
        <span
          data-testid="sync-pill"
          className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium ${online ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-200'}`}
        >
          {label}
        </span>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p data-testid="placeholder" className="text-2xl font-bold">
          Driver app — M0 shell
        </p>
        <p className="text-slate-300">Installed and working. Trips, sales and cash arrive in later milestones.</p>
        <p className="text-sm text-slate-400">Version {__APP_VERSION__}</p>
      </main>

      <div className="px-4 pb-3">
        <button
          type="button"
          disabled
          className="min-h-14 w-full rounded-xl bg-amber-500 text-lg font-bold text-slate-950 active:scale-95 disabled:opacity-40"
        >
          No trip assigned
        </button>
      </div>

      <nav className="grid grid-cols-4 border-t border-slate-800 bg-slate-900 pb-[env(safe-area-inset-bottom)]">
        {NAV.map((item) => (
          <button key={item} type="button" className="min-h-14 text-sm font-medium text-slate-300 active:scale-95">
            {item}
          </button>
        ))}
      </nav>
    </div>
  );
}
