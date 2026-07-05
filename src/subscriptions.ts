/**
 * Fixed monthly subscription costs that don't show up as per-call token
 * usage in the trajectory (because they're hosting/subscription fees,
 * not API metered spend). These get amortized to an hourly rate and
 * folded into `/api/spend`, `/api/series`, and `/api/overview` results
 * so total cost matches Matt's actual credit-card spend.
 *
 * Attribution: each subscription targets a specific (provider, model)
 * pair so it appears under the right row when the UI groups by
 * provider or model. When grouped by agent or channel, subscriptions
 * are exposed as a synthetic row with `key = "(subscription: <name>)"`.
 */

export interface Subscription {
  /** Human-readable name, e.g. "Minimax cloud hosting" */
  name: string;
  /** USD per calendar month */
  monthlyUsd: number;
  /** Provider to attribute cost to when grouping by provider */
  provider: string;
  /** Model to attribute cost to when grouping by model */
  model: string;
  /** ISO timestamp when this fee started (inclusive). null = forever ago */
  activeFromMs: number | null;
  /** ISO timestamp when this fee ended (exclusive). null = still active */
  activeToMs: number | null;
}

export const SUBSCRIPTIONS: Subscription[] = [
  {
    name: 'Minimax cloud hosting',
    monthlyUsd: 20,
    provider: 'ollama',
    model: 'minimax-m2.5:cloud',
    // Best guess: subscription started when we first saw minimax-m2.5:cloud
    // calls in the trajectory (mid-April 2026). If earlier, adjust here.
    activeFromMs: Date.parse('2026-04-19T00:00:00-07:00'),
    activeToMs: null,
  },
];

/**
 * Convert a monthly USD amount to a per-hour rate.
 * Uses 30.4375 days/month (365.25/12) so long windows average out.
 */
export function monthlyToHourly(monthlyUsd: number): number {
  return monthlyUsd / (30.4375 * 24);
}

/**
 * Total subscription cost active during [sinceMs, endMs), filtered by
 * an optional provider/model. Handles multiple subscriptions and
 * partial-window overlap. Returns 0 when nothing matches.
 */
export function subscriptionCostForWindow(
  sinceMs: number,
  endMs: number,
  filters?: { provider?: string; model?: string },
): number {
  if (endMs <= sinceMs) return 0;
  let total = 0;
  for (const sub of SUBSCRIPTIONS) {
    if (filters?.provider && filters.provider !== sub.provider) continue;
    if (filters?.model && filters.model !== sub.model) continue;
    const start = Math.max(sinceMs, sub.activeFromMs ?? -Infinity);
    const end = Math.min(endMs, sub.activeToMs ?? Infinity);
    if (end <= start) continue;
    const hours = (end - start) / (60 * 60 * 1000);
    total += monthlyToHourly(sub.monthlyUsd) * hours;
  }
  return total;
}

/**
 * Emit synthetic time-series points for subscriptions bucketed by hour
 * or day, in the same shape as `/api/series` rows. Bucket labels use
 * SQLite's strftime('%Y-%m-%d %H:00' | '%Y-%m-%d 00:00') format so they
 * merge cleanly with the real series.
 *
 * `matchFilter` decides whether a subscription should appear given the
 * caller's provider/model filter; when the filter excludes it, it's
 * omitted entirely.
 */
export function subscriptionSeriesPoints(
  sinceMs: number,
  endMs: number,
  bucket: 'hour' | 'day',
  seriesLabelBy: 'total' | 'provider' | 'model' | 'agent',
  matchFilter?: { provider?: string; model?: string; agent?: string },
): Array<{ bucket: string; series: string; cost_usd: number; tokens: number; calls: number }> {
  const out: Array<{ bucket: string; series: string; cost_usd: number; tokens: number; calls: number }> = [];
  const bucketMs = bucket === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;

  for (const sub of SUBSCRIPTIONS) {
    if (matchFilter?.provider && matchFilter.provider !== sub.provider) continue;
    if (matchFilter?.model && matchFilter.model !== sub.model) continue;
    // agent filter never matches a subscription (they're not agent-scoped),
    // so drop entirely if agent is specified.
    if (matchFilter?.agent) continue;

    const start = Math.max(sinceMs, sub.activeFromMs ?? -Infinity);
    const end = Math.min(endMs, sub.activeToMs ?? Infinity);
    if (end <= start) continue;

    const seriesKey =
      seriesLabelBy === 'provider' ? sub.provider :
      seriesLabelBy === 'model'    ? sub.model :
      seriesLabelBy === 'agent'    ? 'subscription' :
      'total';

    // Walk bucket boundaries in local time. Use JS Date because SQLite is
    // handling the read-side, but we're computing amortized synthetic
    // rows in JS.
    // For hourly buckets, produce one row per hour with the hourly cost.
    // For daily, one row per day with 24 * hourly.
    const hourly = monthlyToHourly(sub.monthlyUsd);

    // Align bucket boundaries to local midnight/hour.
    const bucketStart = new Date(start);
    if (bucket === 'hour') {
      bucketStart.setMinutes(0, 0, 0);
    } else {
      bucketStart.setHours(0, 0, 0, 0);
    }

    for (let t = bucketStart.getTime(); t < end; t += bucketMs) {
      const bucketEnd = t + bucketMs;
      const overlapStart = Math.max(t, start);
      const overlapEnd = Math.min(bucketEnd, end);
      const overlapHours = Math.max(0, (overlapEnd - overlapStart) / (60 * 60 * 1000));
      if (overlapHours === 0) continue;
      const cost = hourly * overlapHours;
      // Format bucket label matching SQLite's strftime output.
      const d = new Date(t);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const label = bucket === 'hour' ? `${yyyy}-${mm}-${dd} ${hh}:00` : `${yyyy}-${mm}-${dd} 00:00`;
      out.push({ bucket: label, series: seriesKey, cost_usd: cost, tokens: 0, calls: 0 });
    }
  }
  return out;
}

/** Aggregate subscription cost per grouping key for /api/spend. */
export function subscriptionSpendByGroup(
  sinceMs: number,
  endMs: number,
  groupBy: 'agent' | 'provider' | 'model' | 'channel' | 'chat' | 'day' | 'hour',
): Array<{ key: string; cost_usd: number }> {
  // day/hour: delegate to the series helper (already iterates all subs).
  if (groupBy === 'day' || groupBy === 'hour') {
    const series = subscriptionSeriesPoints(sinceMs, endMs, groupBy, 'total');
    // Merge duplicate bucket labels across subs.
    const byBucket = new Map<string, number>();
    for (const s of series) byBucket.set(s.bucket, (byBucket.get(s.bucket) ?? 0) + s.cost_usd);
    return [...byBucket.entries()].map(([key, cost_usd]) => ({ key, cost_usd }));
  }

  const out: Array<{ key: string; cost_usd: number }> = [];
  for (const sub of SUBSCRIPTIONS) {
    const start = Math.max(sinceMs, sub.activeFromMs ?? -Infinity);
    const end = Math.min(endMs, sub.activeToMs ?? Infinity);
    if (end <= start) continue;
    const cost = monthlyToHourly(sub.monthlyUsd) * ((end - start) / (60 * 60 * 1000));

    if (groupBy === 'provider') out.push({ key: sub.provider, cost_usd: cost });
    else if (groupBy === 'model') out.push({ key: sub.model, cost_usd: cost });
    else if (groupBy === 'agent' || groupBy === 'channel' || groupBy === 'chat') {
      out.push({ key: `(subscription: ${sub.name})`, cost_usd: cost });
    }
  }
  return out;
}
