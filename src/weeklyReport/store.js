import { savePeriod } from '../db';
import { STUDIOS } from './constants';

// Ported from Lauren's wtc-weekly-report app (lib/store.js emptyData()), but
// persisted through this app's existing Supabase `periods` table (see
// ../db.js) under a single period_id key ('weekly_report') instead of a
// separate Vercel KV store — same table, same upsert-by-id pattern already
// used for 'period1' / 'period2' / 'fixed_expenses'.
export const WEEKLY_REPORT_KEY = 'weekly_report';

export function emptyWeeklyReportData() {
  const emptyStudio = () => ({ all_weeks: [], month_totals: [] });
  const byStudio = fn => STUDIOS.reduce((o, s) => ((o[s] = fn()), o), {});
  return {
    studios: byStudio(emptyStudio),
    employees: byStudio(() => ({})),
    activeEmployees: byStudio(() => []),
    currentMonthKey: null,
    supserv: { ...byStudio(() => []), Consolidated: [], 'July Goal': [] },
    memberships: { history: [] },
    collections: { records: [] },
    guestRetention: { history: [] },
    goals: byStudio(() => ({})),
  };
}

export function saveWeeklyReportData(data) {
  return savePeriod(WEEKLY_REPORT_KEY, data);
}
