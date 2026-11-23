export type Shell = 'driver' | 'office';

/** `/office` and anything below it is the office shell; everything else is the driver shell. */
export function shellForPath(pathname: string): Shell {
  return pathname === '/office' || pathname.startsWith('/office/') ? 'office' : 'driver';
}
