// Token Radar model: a comps curve fitted from the snapshot itself.
// Ridge log-log regression of market cap on TVL over the traded tokens
// (mcap > 0), fitted at runtime in fitCurve() — no fitted number is
// hardcoded. Features: log10 TVL, clamped 7d growth, seasoning
// log10(1 + age_days). Each row also gets a shrunk category factor (mean
// residual of its category, capped +/-0.25 dex) and, on the board only, a
// sibling discount of 0.85 when the family (first slug token) already has
// a token trading. No protocol name is ever special-cased.
// Backtest (backtest()): leave-one-out over traded tokens + a time split
// (fit pre-2024, test newer), each against the flat mcap/TVL baseline.

export interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
export interface Snapshot {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
}
export class SnapshotError extends Error {
  constructor(m: string) { super(m); this.name = 'SnapshotError'; }
}
const DAY_MS = 86_400_000;
export const RIDGE_LAMBDA = 10; // ridge penalty on non-intercept coefs
export const SIBLING_FACTOR = 0.85;
export const SLICE_SHARE = 0.5; // share of the implied multiple reaching farmers
export const TBILL_RATE = 0.04;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`), b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const SET_ASIDE_CATS = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];
// Set aside: wrapped/staked/bridged products, exchanges, versioned pools.
export function isSetAside(p: SnapshotProtocol): boolean {
  if (p.category !== null && SET_ASIDE_CATS.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  const w = p.name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (w.includes('wrapped') || w.includes('staked') || w.includes('staking')) return true;
  const lower = p.name.toLowerCase();
  return EXCHANGE_PREFIX.some((e) => lower.startsWith(e));
}
export function isRankable(p: SnapshotProtocol): boolean {
  // The board's early radar follows the starter's own filter: strict
  // pre-token, not an exchange, not a versioned pool. The wider watchlist
  // exclusions (bridged, staked, wrapped) are the set-aside reasons, not a
  // bar on ranking — a protocol DefiLlama records no token for is a subject.
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}
export function growthFrac(p: SnapshotProtocol): number {
  if (p.change_7d === null || !Number.isFinite(p.change_7d)) return 0;
  return Math.min(120, Math.max(-60, p.change_7d)) / 100;
}
export function seasoning(asOf: string, p: SnapshotProtocol): number {
  const a = ageDays(asOf, p.listed_at);
  return Math.log10(1 + (a === null ? 365 : a));
}
export function features(asOf: string, p: SnapshotProtocol): number[] {
  return [1, Math.log10(Math.max(1, p.tvl_usd)), growthFrac(p), seasoning(asOf, p)];
}
// Solve A x = b by Gaussian elimination with partial pivoting.
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    const t = M[c]!; M[c] = M[piv]!; M[piv] = t;
    const d = M[c]![c]!;
    if (d === 0) throw new SnapshotError('comps fit is singular');
    for (let j = c; j <= n; j++) M[c]![j]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f !== 0) for (let j = c; j <= n; j++) M[r]![j]! -= f * M[c]![j]!;
    }
  }
  return M.map((row) => row[n]!);
}
// Ridge OLS of log10(mcap) on the features, over the given comps.
export function ridgeFit(asOf: string, comps: SnapshotProtocol[]): number[] {
  const k = 4;
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b: number[] = new Array<number>(k).fill(0);
  for (const p of comps) {
    const x = features(asOf, p), y = Math.log10(p.mcap_usd!);
    for (let i = 0; i < k; i++) {
      b[i]! += x[i]! * y;
      for (let j = 0; j < k; j++) A[i]![j]! += x[i]! * x[j]!;
    }
  }
  for (let i = 1; i < k; i++) A[i]![i]! += RIDGE_LAMBDA;
  return solveLinear(A, b);
}
// Shrunk category factors: mean log residual per category, n/(n+8), +/-0.25 dex.
export function categoryFactors(asOf: string, comps: SnapshotProtocol[], beta: number[]): Map<string, number> {
  const sums = new Map<string, { s: number; n: number }>();
  for (const p of comps) {
    const x = features(asOf, p);
    const r = Math.log10(p.mcap_usd!) - beta.reduce((a, bi, i) => a + bi! * x[i]!, 0);
    const key = p.category ?? 'Other';
    const cur = sums.get(key) ?? { s: 0, n: 0 };
    cur.s += r; cur.n += 1; sums.set(key, cur);
  }
  const out = new Map<string, number>();
  for (const [key, v] of sums) out.set(key, Math.max(-0.25, Math.min(0.25, (v.s / v.n) * (v.n / (v.n + 8)))));
  return out;
}
export interface CurveFit { beta: number[]; catFactors: Map<string, number>; residSd: number; r2: number; n: number; }
export function predictLog(asOf: string, p: SnapshotProtocol, beta: number[], catFactors: Map<string, number>): number {
  const x = features(asOf, p);
  return beta.reduce((a, bi, i) => a + bi! * x[i]!, 0) + (catFactors.get(p.category ?? 'Other') ?? 0);
}
export function fitCurve(asOf: string, protocols: SnapshotProtocol[]): CurveFit {
  const comps = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const beta = ridgeFit(asOf, comps);
  const catFactors = categoryFactors(asOf, comps, beta);
  const ys = comps.map((p) => Math.log10(p.mcap_usd!));
  const yMean = ys.reduce((a, v) => a + v, 0) / ys.length;
  let ssRes = 0, ssTot = 0;
  for (const p of comps) {
    const r = Math.log10(p.mcap_usd!) - predictLog(asOf, p, beta, catFactors);
    ssRes += r * r; ssTot += (Math.log10(p.mcap_usd!) - yMean) ** 2;
  }
  return { beta, catFactors, residSd: Math.sqrt(ssRes / Math.max(1, comps.length)), r2: 1 - ssRes / ssTot, n: comps.length };
}
export function tradedFamilies(protocols: SnapshotProtocol[]): Set<string> {
  const out = new Set<string>();
  for (const p of protocols) if (!isPreToken(p)) out.add(p.slug.split('-')[0]!);
  return out;
}
export function siblingFactor(p: SnapshotProtocol, families: Set<string>): number {
  return families.has(p.slug.split('-')[0]!) ? SIBLING_FACTOR : 1;
}
export interface Priced { implied: number; lo: number; hi: number; catFactor: number; sibling: number; }
// One function prices every row: fitted curve x category factor x sibling.
export function priceProtocol(asOf: string, p: SnapshotProtocol, fit: CurveFit, families: Set<string>): Priced {
  const catFactor = fit.catFactors.get(p.category ?? 'Other') ?? 0;
  const sibling = siblingFactor(p, families);
  const implied = Math.max(1, Math.round(10 ** predictLog(asOf, p, fit.beta, fit.catFactors) * sibling));
  const band = 10 ** (1.2816 * fit.residSd);
  return { implied, lo: Math.max(1, Math.round(implied / band)), hi: Math.round(implied * band), catFactor, sibling };
}

// ---- farm economics ----
export function gasPerTx(chain: string): number {
  const t: Record<string, number> = {
    Ethereum: 6, Bitcoin: 2, Tron: 1, Avalanche: 0.4, Arbitrum: 0.25,
    Optimism: 0.15, Binance: 0.15, Base: 0.08, Solana: 0.05, Sui: 0.05,
    Polygon: 0.03, 'Hyperliquid L1': 0.05, Monad: 0.05, Berachain: 0.1,
  };
  return t[chain] ?? 1.5;
}
export function chainOf(p: SnapshotProtocol): string { return p.chains.length > 0 ? p.chains[0]! : 'Ethereum'; }
export function planCapital(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  return 100;
}
export function holdDays(age: number | null): number {
  if (age === null || age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}
export function handsOnHours(hold: number): number { return Math.round((1 + hold / 30) * 10) / 10; }
export interface Economics {
  slice1000: number; fees: number; oppCost: number; net1000: number;
  hours: number; netPerHour: number; verdict: 'FARM' | 'THIN' | 'SKIP';
}
// $1,000 slice: $1,000 x implied/TVL x SLICE_SHARE, minus gas (6 tx + $3
// swap/bridge allowance) and the 4% T-bill return forgone over the hold.
// Verdict from net $ per hands-on hour: FARM above $30/h (about double a
// $15/h freelance rate, so the time is clearly worth more than the T-bill
// alternative), THIN above $0, else SKIP.
export function economics(p: SnapshotProtocol, implied: number, age: number | null): Economics {
  const slice1000 = Math.round(1000 * (implied / Math.max(1, p.tvl_usd)) * SLICE_SHARE * 100) / 100;
  const hold = holdDays(age);
  const fees = Math.round((6 * gasPerTx(chainOf(p)) + 3) * 100) / 100;
  const oppCost = Math.round(1000 * TBILL_RATE * (hold / 365) * 100) / 100;
  const net1000 = Math.round((slice1000 - fees - oppCost) * 100) / 100;
  const hours = handsOnHours(hold);
  const netPerHour = Math.round((net1000 / hours) * 100) / 100;
  const verdict = netPerHour > 30 ? 'FARM' : net1000 > 0 ? 'THIN' : 'SKIP';
  return { slice1000, fees, oppCost, net1000, hours, netPerHour, verdict };
}

// ---- farm steps (concrete, costed, timed, derived from the record) ----
export interface FarmStep { text: string; cost: string; time: string; }
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase(), name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the supply position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position in range.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds inside its app.`;
  if (c.includes('staking') || c.includes('restak') || c.includes('staking pool')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}, then leave the stake working.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk curator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('stable') || c.includes('rwa') || c.includes('onchain capital')) return `Mint or deposit $${capital} of the yield asset through ${name} on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('liquid')) return `Deposit $${capital} of the liquid asset through ${name} on ${chain} and hold the receipt.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p), capital = planCapital(p), hold = holdDays(age), gas = gasPerTx(chain);
  const steps: FarmStep[] = [
    { text: `Open a fresh wallet that holds only the funds you plan to farm, fund it with $${capital} of USDC plus about $${Math.ceil(6 * gas + 3)} for gas on ${chain}, and keep its seed phrase offline.`, cost: `about $${Math.ceil(6 * gas + 3)} of gas to fund and set up`, time: '10 minutes' },
    { text: actionFor(p, capital, chain), cost: `$${capital} of capital and about $${gas} of gas for the transaction`, time: '15 minutes to set up' },
    { text: `Make one qualifying action each week on ${chain} — a deposit, a borrow, a swap or a vote inside ${p.name} — so the wallet shows repeat use.`, cost: `about $${gas} of gas a week`, time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot window.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Check ${p.name}'s own points or rewards page weekly and claim only from the link that page publishes; never pay a fee to claim.`, cost: 'no fee to check, claim gas about $' + gas, time: '10 minutes a week' },
    { text: `Log the wallet, the dates and every transaction hash, then unwind only after the hold ends and the claim window is confirmed.`, cost: 'nothing but the log', time: '10 minutes' },
  ];
  return steps.map(stepText);
}

// ---- backtest ----
export interface BacktestMetric { medianMiss: number; within3x: number; within10x: number; n: number; }
export interface Backtest {
  loo: BacktestMetric; looFlat: BacktestMetric; time: BacktestMetric;
  timeFlat: BacktestMetric; timeFitN: number; residSd: number;
}
function metric(pairs: [number, number][]): BacktestMetric {
  const misses = pairs.map(([pr, real]) => Math.abs(Math.log10(pr / real))).sort((a, b) => a - b);
  const median = 10 ** misses[Math.floor(misses.length / 2)]!;
  const within = (k: number) => pairs.filter(([pr, real]) => Math.max(pr, real) / Math.min(pr, real) <= k).length / pairs.length;
  return { medianMiss: Math.round(median * 100) / 100, within3x: Math.round(within(3) * 1000) / 10, within10x: Math.round(within(10) * 1000) / 10, n: pairs.length };
}
function medianOf(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  return v.length % 2 === 1 ? v[Math.floor(v.length / 2)]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
}
export function backtest(asOf: string, protocols: SnapshotProtocol[], fit: CurveFit): Backtest {
  const comps = protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const looPairs: [number, number][] = [], looFlatPairs: [number, number][] = [];
  for (let i = 0; i < comps.length; i++) {
    const others = comps.filter((_, j) => j !== i);
    const beta = ridgeFit(asOf, others);
    const cats = categoryFactors(asOf, others, beta);
    const p = comps[i]!;
    looPairs.push([10 ** predictLog(asOf, p, beta, cats), p.mcap_usd!]);
    looFlatPairs.push([p.tvl_usd * medianOf(others.map((q) => q.mcap_usd! / q.tvl_usd)), p.mcap_usd!]);
  }
  const pre = comps.filter((p) => p.listed_at !== null && p.listed_at < '2024-01-01');
  const post = comps.filter((p) => p.listed_at !== null && p.listed_at >= '2024-01-01');
  const betaPre = ridgeFit(asOf, pre);
  const catsPre = categoryFactors(asOf, pre, betaPre);
  const timePairs: [number, number][] = post.map((p) => [10 ** predictLog(asOf, p, betaPre, catsPre), p.mcap_usd!]);
  const flatPre = medianOf(pre.map((q) => q.mcap_usd! / q.tvl_usd));
  const timeFlatPairs: [number, number][] = post.map((p) => [p.tvl_usd * flatPre, p.mcap_usd!]);
  return { loo: metric(looPairs), looFlat: metric(looFlatPairs), time: metric(timePairs), timeFlat: metric(timeFlatPairs), timeFitN: pre.length, residSd: fit.residSd };
}

// ---- board, live and set-aside views ----
export const EARLY_ROWS = 152;
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; listed_at: string | null; age_days: number | null;
  implied_value_usd: number; p10_usd: number; p90_usd: number; cat_factor: number; sibling_factor: number;
  slice_1000_usd: number; fees_usd: number; opp_cost_usd: number; net_1000_usd: number;
  hours: number; net_per_hour_usd: number; verdict: 'FARM' | 'THIN' | 'SKIP';
  plan_capital_usd: number; hold_days: number; farm_steps: string[];
}
export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number; change_7d: number | null; age_days: number | null;
}
export interface AsideRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; reason: string;
}
export function asideReason(p: SnapshotProtocol): string {
  if (p.category !== null && SET_ASIDE_CATS.has(p.category)) return `${p.category} — a product of a token that already trades, or an exchange itself`;
  if (VERSIONED.test(p.name)) return 'Versioned pool — a numbered release of another protocol';
  const w = p.name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (w.includes('wrapped') || w.includes('staked') || w.includes('staking')) return 'Wrapped or staked product of a token that already trades';
  return 'Exchange-branded protocol';
}
export interface FitSummary {
  intercept: number; slope: number; growthWeight: number; seasoningWeight: number;
  lambda: number; nComps: number; r2: number; residSd: number; bandFactor: number;
  catFactors: Record<string, number>;
}
export interface RadarData {
  as_of: string; floor_usd: number; model_version: string;
  total_protocols: number; pre_token_count: number; traded_count: number;
  watchlist_size: number; board_size: number; early_size: number; set_aside_count: number;
  fit: FitSummary; backtest: Backtest; verdictCounts: Record<string, number>;
  rows: BoardRow[]; live: LiveRow[]; aside: AsideRow[]; comps: [number, number][];
}
export function buildBoard(snapshot: Snapshot, fit: CurveFit, families: Set<string>): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);
  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const priced = priceProtocol(snapshot.as_of, p, fit, families);
    return { p, age, priced, econ: economics(p, priced.implied, age) };
  });
  scored.sort((a, b) => b.priced.implied - a.priced.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
    tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, listed_at: s.p.listed_at, age_days: s.age,
    implied_value_usd: s.priced.implied, p10_usd: s.priced.lo, p90_usd: s.priced.hi,
    cat_factor: s.priced.catFactor, sibling_factor: s.priced.sibling,
    slice_1000_usd: s.econ.slice1000, fees_usd: s.econ.fees, opp_cost_usd: s.econ.oppCost,
    net_1000_usd: s.econ.net1000, hours: s.econ.hours, net_per_hour_usd: s.econ.netPerHour,
    verdict: s.econ.verdict, plan_capital_usd: planCapital(s.p), hold_days: holdDays(s.age),
    farm_steps: farmSteps(s.p, s.age),
  }));
}
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = fitCurve(snapshot.as_of, snapshot.protocols);
  const families = tradedFamilies(snapshot.protocols);
  const board = buildBoard(snapshot, fit, families);
  const bt = backtest(snapshot.as_of, snapshot.protocols, fit);
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd ?? 0, change_7d: p.change_7d, age_days: ageDays(snapshot.as_of, p.listed_at) }));
  // Set aside: every protocol that records no token and is not on the board
  // (the watchlist rule's exclusions, the early TVL cut, and the above-floor
  // protocols the watchlist does not name). Board + set-aside = all 342.
  const boardSlugs = new Set(board.map((r) => r.slug));
  const aside: AsideRow[] = snapshot.protocols
    .filter((p) => isPreToken(p) && !boardSlugs.has(p.slug))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd,
      reason: isSetAside(p) ? asideReason(p) : p.tvl_usd >= snapshot.floor_usd
        ? 'Above the floor but not named by the watchlist rule'
        : 'Below the early TVL cut',
    }));
  const comps: [number, number][] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => [p.tvl_usd, p.mcap_usd!] as [number, number]);
  const verdictCounts: Record<string, number> = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) verdictCounts[r.verdict] = (verdictCounts[r.verdict] ?? 0) + 1;
  const catFactors: Record<string, number> = {};
  for (const [k, v] of [...fit.catFactors.entries()].sort()) catFactors[k] = v;
  const radar: RadarData = {
    as_of: snapshot.as_of, floor_usd: snapshot.floor_usd, model_version: 'radar-v1 comps curve',
    total_protocols: snapshot.protocols.length,
    pre_token_count: snapshot.protocols.filter(isPreToken).length,
    traded_count: snapshot.protocols.filter((p) => !isPreToken(p)).length,
    watchlist_size: snapshot.watchlist.length, board_size: board.length,
    early_size: board.filter((r) => !snapshot.watchlist.includes(r.slug)).length,
    set_aside_count: aside.length,
    fit: {
      // Full precision, unrounded: the page recomputes each row from these
      // numbers and must land on the same implied value board.json carries.
      intercept: fit.beta[0]!, slope: fit.beta[1]!,
      growthWeight: fit.beta[2]!, seasoningWeight: fit.beta[3]!,
      lambda: RIDGE_LAMBDA, nComps: fit.n, r2: Math.round(fit.r2 * 1000) / 1000,
      residSd: Math.round(fit.residSd * 1000) / 1000,
      bandFactor: Math.round(10 ** (1.2816 * fit.residSd) * 100) / 100, catFactors,
    },
    backtest: bt, verdictCounts, rows: board, live, aside, comps,
  };
  return { board, radar };
}
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug, name: p.name, category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share the same implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}
export function dataScript(radar: RadarData): string { return `window.RADAR=${JSON.stringify(radar)};\n`; }
