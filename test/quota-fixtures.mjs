// Fixture quota documents for the panel tests and the headless shots (scripts/quota-shots.mjs). Times are built from LOCAL
// date parts so the tests read the same in every time zone. NOW is 23:41 on 23-10-2026, the instant the approved concept was drawn at.
const at = (d, h, m, mo = 10, y = 2026) => new Date(y, mo - 1, d, h, m).toISOString();
export const NOW = new Date(2026, 9, 23, 23, 41).getTime();
export const minutesBefore = (min, now = NOW) => new Date(now - min * 60000).toISOString();

export const premiumA = {
  id: 'premium-a', label: 'Premium A', machine: 'Main PC · this machine', reach: { status: 'ok', checked_at: at(23, 23, 41) },
  window5h: { pct: 62, resets_at: at(24, 2, 30), as_of: at(23, 23, 41) },
  week: { pct: 41, resets_at: at(28, 6, 0), as_of: at(23, 23, 41) },
  tokens: { today: 18_400_000, d7: 96_100_000, today_cache_read: 212_000_000, d7_cache_read: 1_300_000_000, as_of: at(23, 23, 41) }
};
export const premiumB = {
  id: 'premium-b', label: 'Premium B', machine: 'Spare PC · 203.0.113.5', reach: { status: 'ok', checked_at: at(23, 23, 41) },
  window5h: { pct: 88, resets_at: at(24, 1, 10), as_of: at(23, 23, 39) },
  week: null,
  tokens: { today: 9_700_000, d7: 54_300_000, today_cache_read: 131_000_000, as_of: at(23, 23, 39) }
};
export const acme = {
  id: 'acme', label: 'Acme Tours', machine: 'Laptop · 203.0.113.7', reach: { status: 'ok', checked_at: at(23, 23, 40) },
  window5h: { pct: 34, resets_at: at(3, 23, 10), as_of: at(3, 18, 14) },
  week: { pct: 19, resets_at: at(8, 6, 0), as_of: at(3, 18, 14) },
  tokens: { today: 0, d7: 0, last_activity: at(3, 18, 14), as_of: at(23, 23, 40) }
};
export const sampleDoc = { schema: 1, generated_at: at(23, 23, 41), accounts: [premiumA, premiumB, acme] };
