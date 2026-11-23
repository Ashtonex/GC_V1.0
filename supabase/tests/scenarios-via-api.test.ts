/**
 * M2 gate (Section 6): Scenarios A, B, B2 and C posted through the ingest API, by the right people at the right
 * trip states, produce the same engine results as the pure M1 run. Also: projections rebuild from events.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TripEvent } from '@gc/schema';
import { economics, operational, type EconomicsContext } from '@gc/engine';
import {
  COSTS,
  PRICES,
  TRIP,
  asDeviceEvents,
  scenarioA,
  scenarioB,
  scenarioB2,
  scenarioC,
} from '../../packages/engine/src/fixtures/section6.ts';
import { TestDb } from './harness/db.ts';
import { seedWorld, toNames, type World } from './harness/fixtures.ts';
import { postScenario } from './harness/scenario.ts';

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await TestDb.create();
  w = await seedWorld(db);
});
afterAll(() => db.close());

const opsCtx = { currency: 'USD', prices: PRICES } as const;
const econCtx: EconomicsContext = { ...opsCtx, costs: COSTS, costBasis: 'provisional' };

function compare(name: string, fixture: () => TripEvent[]) {
  describe(`Scenario ${name} through the ingest API`, () => {
    let result: Awaited<ReturnType<typeof postScenario>>;
    beforeAll(async () => {
      result = await postScenario(db, w, fixture());
    });

    const apiCtx = () => ({
      currency: 'USD' as const,
      prices: Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [w.ids.of(k), v])),
    });

    it('server economics (with server-written cost snapshots) equal the M1 engine run', () => {
      const ctx: EconomicsContext = {
        ...apiCtx(),
        costs: Object.fromEntries(Object.entries(COSTS).map(([k, v]) => [w.ids.of(k), v])),
        costBasis: 'provisional',
      };
      const viaApi = toNames(economics(result.server, ctx), result.ids, result.trip, TRIP);
      expect(viaApi).toEqual(economics(fixture(), econCtx));
    });

    it('operational totals from the events a driver can read equal the M1 run', async () => {
      const driverEvents = await db.as<{ payload: TripEvent }>(
        w.s.driver,
        `select payload from public.trip_events where trip_id = $1 order by seq`,
        [result.trip],
      );
      const viaApi = toNames(
        operational(
          driverEvents.map((r) => r.payload),
          apiCtx(),
        ),
        result.ids,
        result.trip,
        TRIP,
      );
      expect(viaApi).toEqual(operational(asDeviceEvents(fixture()), opsCtx));
    });

    it('projections rebuild from events to exactly the same rows (Section 4)', async () => {
      const snapshot = async () => ({
        sales: await db.admin(`select * from public.sales where trip_id = $1 order by id`, [result.trip]),
        lines: await db.admin(
          `select l.* from public.sale_lines l join public.sales s on s.id = l.sale_id where s.trip_id = $1
           order by l.sale_id, l.line_id`,
          [result.trip],
        ),
        payments: await db.admin(`select * from public.payments where trip_id = $1 order by id`, [result.trip]),
        handovers: await db.admin(`select * from public.handovers where trip_id = $1 order by id`, [result.trip]),
        expenses: await db.admin(`select * from public.expenses where trip_id = $1 order by id`, [result.trip]),
      });
      const before = await snapshot();
      expect(before.sales.length).toBeGreaterThan(0);
      await db.service(`select gc.rebuild_projections($1)`, [result.trip]);
      expect(await snapshot()).toEqual(before);
    });
  });
}

compare('A', scenarioA);
compare('B', scenarioB);
compare('B2', scenarioB2);
compare('C', scenarioC);
