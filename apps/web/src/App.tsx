import { DriverShell } from './driver/DriverShell';
import { OfficeShell } from './office/OfficeShell';
import { UpdatePrompt } from './shared/UpdatePrompt';
import { shellForPath } from './shared/shellForPath';

// One PWA, two role-based shells (Section 4 repo structure). M0 picks the shell by path only;
// role-based routing after sign-in arrives in M2.
export function App() {
  const shell = shellForPath(window.location.pathname);
  return (
    <>
      {shell === 'office' ? <OfficeShell /> : <DriverShell />}
      <UpdatePrompt />
    </>
  );
}
