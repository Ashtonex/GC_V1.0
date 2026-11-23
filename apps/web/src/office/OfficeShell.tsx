/** M0 placeholder office shell (Owner / Accounts / Warehouse). Sign-in and real screens arrive from M2/M4. */
export function OfficeShell() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-3 p-6">
      <h1 className="text-3xl font-bold">Game Command — Office</h1>
      <p data-testid="placeholder" className="text-slate-300">
        Office shell — M0 placeholder. Products, trips and the trip-close report arrive in later milestones.
      </p>
      <p className="text-sm text-slate-400">Version {__APP_VERSION__}</p>
    </div>
  );
}
