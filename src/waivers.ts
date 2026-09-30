// The add side of the in-season loop: score the whole available pool against
// our actual roster holes, and size a FAAB bid against this league's own
// observed prices.
//
// Three things this deliberately does NOT do, each because the naive version
// loses money:
//
//   1. **It does not rank on this week's projection.** The first hand-run of
//      this scan liked a TE who was the week's 8.0 against our bench 6.2 — and
//      who is TE15 for the season against our TE13. A weekly number is a
//      matchup, and you cannot add a matchup: you add the player and keep him.
//      So candidates rank on season `val` (the board's flex-aware VORP, floored
//      by half-weight bench value) and the week is reported only as colour.
//   2. **It does not rank the pool in isolation.** An add is worth exactly what
//      it beats, and what it beats is the man it displaces from a 15-man roster.
//      Every candidate is therefore quoted as a *pair* — add X, drop Y — and the
//      gain is the difference. A pool full of RB40s is worth nothing to a roster
//      whose worst player is an RB36.
//   3. **It does not spend to be seen spending.** A move that clears no margin
//      is churn with a transaction fee, and FAAB is a season-long budget, not a
//      weekly allowance. The verdict is allowed to be HOLD, and most weeks
//      should be.
//
// And two things it learned the hard way, in week 4 of 2026:
//
//   4. **The IR slot is not a roster spot.** Sleeper keeps a player parked on
//      `reserve` inside `players`, so a naive count sees a full roster and
//      quotes a drop for every add. Reserved players are excluded from the
//      holdings, and when an active slot is genuinely open the quote is an
//      add-only (`drop: null`) — there is nothing to beat.
//   5. **The drop side is not injury-blind.** It once proposed cutting our
//      backup QB while the starter was Questionable. A drop may never leave a
//      starting position without a man whose status is clean.
//
// Shape, budget and scoring all come from the league object. Nothing here is
// calibrated to 12 teams or to $100 — a fork's league gets its own numbers.
import {
  api,
  FLEX_KINDS,
  leagueShape,
  leagueUsers,
  LEAGUE_ID,
  playerName,
  players,
  USER_ID,
  USERNAME,
  type Shape,
} from './sleeper'
import { FANTASY_POS, scoreStats } from './value'
import { buildBoard, type ProjRow } from './proj'

/** Season `val` a candidate must beat our drop by before it is worth a move. */
const MARGIN = 6
/** Statuses that make a player un-addable for this week's purposes. */
const DEAD = new Set(['IR', 'PUP', 'Sus', 'NA', 'DNR', 'Out'])
/**
 * Statuses that do not count as "a man who will play this week" when deciding
 * whether a drop strands a position. Questionable is in here on purpose: a Q
 * starter is exactly when the backup is not expendable.
 */
export const NOT_RELIABLE = new Set([
  'Questionable',
  'Doubtful',
  'Out',
  'IR',
  'PUP',
  'Sus',
  'NA',
  'DNR',
  'COV',
])
/** Roster-position entries that are not active roster spots. */
const INACTIVE_SLOTS = new Set(['IR', 'TAXI'])
/**
 * Official designations Sleeper's IR slot always takes. Everything else is
 * opt-in per league via `settings.reserve_allow_<x>`.
 */
const RESERVE_ALWAYS = ['IR', 'PUP']
const RESERVE_OPTIN: Record<string, string> = {
  reserve_allow_out: 'Out',
  reserve_allow_doubtful: 'Doubtful',
  reserve_allow_sus: 'Sus',
  reserve_allow_na: 'NA',
  reserve_allow_dnr: 'DNR',
  reserve_allow_cov: 'COV',
}

const num = (n: number) => Math.round(n * 10) / 10

export type Candidate = {
  player: string
  pos: string
  team: string
  /** Season value under this league's rules — the number we rank on. */
  val: number
  pos_rank: number
  /** This week's projection, as colour only. Never the ranking signal. */
  wk: number | null
  inj: string
  /**
   * Last week another team dropped him this season. A fact, not a waiver
   * status: whether he is still on waivers depends on the clock (see `note`).
   */
  dropped_wk: number | null
  /** Who comes off our roster to make room — null when an active slot is open. */
  drop: string | null
  drop_val: number | null
  /**
   * Season value the add/drop pair adds to the roster we can actually field —
   * not the gap between the two players' board values. This is the whole point.
   */
  gain: number
  bid: number
  why: string
}

export type Holding = {
  id: string
  name: string
  pos: string
  /** Starter value over the flex-aware replacement line. Can be negative. */
  vorp: number
  /** Board value: vorp floored by half-weight bench value. */
  val: number
  pos_rank: number | null
  inj: string
}

/**
 * Can this set of players still fill every starting slot?
 *
 * Checked rather than approximated with a "keep 2 RB" rule, because the legal
 * question is the only one that matters and the league already answers it:
 * fixed slots first, then flex from whatever is left over.
 */
export function canFieldLineup(pos: string[], shape: Shape): boolean {
  const have: Record<string, number> = {}
  for (const p of pos) have[p] = (have[p] ?? 0) + 1
  for (const [slot, n] of Object.entries(shape.starters)) {
    if ((have[slot] ?? 0) < n) return false
    have[slot] = (have[slot] ?? 0) - n
  }
  let flex = shape.flexSlots
  for (const p of shape.flexPos) {
    const take = Math.min(flex, have[p] ?? 0)
    flex -= take
    have[p] = (have[p] ?? 0) - take
  }
  return flex === 0
}

const clean = (h: Holding) => !NOT_RELIABLE.has(h.inj)

/**
 * Does dropping `drop` (with `after` being the roster once the move is made,
 * candidate included) still leave its position a man who will play?
 *
 * `canFieldLineup` answers the legal question; this answers the practical one.
 * A drop is rejected when it leaves a starting position with zero clean-status
 * holdings, or with fewer clean holdings than that position has slots when the
 * roster had at least that many before. Non-starting positions (none in most
 * leagues) are never constrained.
 */
export function keepsHealthyStarters(
  before: Holding[],
  after: Holding[],
  drop: Holding,
  shape: Shape,
): boolean {
  const need = shape.starters[drop.pos] ?? 0
  if (!need) return true
  const n = (ps: Holding[]) => ps.filter((p) => p.pos === drop.pos && clean(p)).length
  const post = n(after)
  if (post === 0) return false
  return post >= Math.min(need, n(before))
}

/** Active roster spots: every `roster_positions` entry except IR and TAXI. */
export function activeCapacity(rosterPositions: string[]): number {
  return rosterPositions.filter((s) => !INACTIVE_SLOTS.has(s)).length
}

/** Injury designations this league's IR slot accepts, read from its settings. */
export function reserveEligible(settings: Record<string, any> = {}): Set<string> {
  const ok = new Set(RESERVE_ALWAYS)
  for (const [k, st] of Object.entries(RESERVE_OPTIN)) if (settings[k]) ok.add(st)
  return ok
}

/**
 * Split a Sleeper roster into the ids that occupy active spots and the ids
 * parked in IR/taxi. Sleeper lists reserve and taxi players inside `players`
 * too, which is how the first version of this counted a 14-man active roster
 * as full.
 */
export function splitRoster(r: { players?: string[]; reserve?: string[] | null; taxi?: string[] | null }) {
  const parked = new Set([...(r.reserve ?? []), ...(r.taxi ?? [])])
  const all = r.players ?? []
  return { active: all.filter((p) => !parked.has(p)), parked: all.filter((p) => parked.has(p)) }
}

export type Move = { drop: Holding | null; gain: number }

/**
 * Best move for one candidate against the ACTIVE roster.
 *
 * With an open active slot the add-only is always on the table and needs no
 * drop; with none, every drop that leaves a legal, playable lineup is tried
 * and the one that moves the roster furthest wins. Every drop is tried rather
 * than assuming the lowest-value player, because the cheapest drop is not
 * always the best one — swapping like for like at a position we are deep in
 * can beat cutting the worst man on the roster.
 *
 * Add-only and pair gains are compared on the same footing (change in
 * startable value); the caller applies MARGIN to pairs only, since an add-only
 * never has to beat a drop it isn't making.
 */
export function bestMove(active: Holding[], cand: Holding, shape: Shape, openSlots: number): Move | null {
  const baseline = rosterValue(active, shape)
  let best: Move | null = null
  if (openSlots > 0) best = { drop: null, gain: rosterValue([...active, cand], shape) - baseline }
  for (const d of active) {
    const after = [...active.filter((r) => r.id !== d.id), cand]
    if (!canFieldLineup(after.map((r) => r.pos), shape)) continue
    if (!keepsHealthyStarters(active, after, d, shape)) continue
    const gain = rosterValue(after, shape) - baseline
    if (!best || gain > best.gain) best = { drop: d, gain }
  }
  return best
}

/**
 * What this roster is worth: starting value, plus only the bench depth that
 * could ever actually reach the lineup.
 *
 * The board's `val` deliberately floors a player at half his over-waiver value
 * so that bench RBs and WRs are not zeroed out — they are one injury or one
 * flex week from starting. But that floor is a lie for a position with a single
 * slot and no flex eligibility: a second kicker or a second DEF cannot be
 * played, traded in this league's history, or flexed, so he is worth ~nothing.
 *
 * Ranking candidates on raw `val` therefore recommends adding a backup DEF over
 * nothing at all, which is how the first run of this command behaved. Scoring
 * the *roster* before and after the swap fixes it at the root: a player is
 * worth what he changes about the lineup we can field.
 */
export function rosterValue(ps: Holding[], shape: Shape): number {
  const pool = [...ps].sort((a, b) => b.vorp - a.vorp)
  const used = new Set<number>()
  let total = 0
  for (const [slot, n] of Object.entries(shape.starters)) {
    let filled = 0
    for (const [i, p] of pool.entries()) {
      if (filled >= n) break
      if (used.has(i) || p.pos !== slot) continue
      used.add(i)
      total += p.vorp
      filled++
    }
  }
  let flex = shape.flexSlots
  for (const [i, p] of pool.entries()) {
    if (flex <= 0) break
    if (used.has(i) || !shape.flexPos.includes(p.pos)) continue
    used.add(i)
    total += p.vorp
    flex--
  }
  for (const [i, p] of pool.entries()) {
    if (used.has(i)) continue
    if (shape.flexPos.includes(p.pos)) total += Math.max(0, p.val) / 2
  }
  return total
}

/** Winning-bid prices actually paid in this league, for calibration. */
async function bidMarket(leagueId: string, throughWeek: number) {
  const bids: number[] = []
  const weeks = Array.from({ length: Math.max(throughWeek, 1) }, (_, i) => i + 1)
  const all = await Promise.all(
    weeks.map((w) => api<any[]>(`/league/${leagueId}/transactions/${w}`).catch(() => [])),
  )
  for (const tx of all)
    for (const t of tx) {
      if (t.status !== 'complete' || t.type !== 'waiver') continue
      const b = t.settings?.waiver_bid
      if (typeof b === 'number' && b > 0) bids.push(b)
    }
  bids.sort((a, b) => a - b)
  const pct = (p: number) =>
    bids.length ? (bids[Math.min(bids.length - 1, Math.floor(bids.length * p))] ?? null) : null
  return { n: bids.length, p50: pct(0.5), p90: pct(0.9), max: pct(1) }
}

export async function waivers(
  opts: { owner?: string; week?: number; limit?: number; pos?: string } = {},
) {
  const state = await api<any>('/state/nfl')
  const season: string = state.season
  const week = opts.week ?? state.week ?? 1

  const q = FANTASY_POS.map((p) => `position[]=${p}`).join('&')
  const [league, rosters, users, db, board, wkProjRaw] = await Promise.all([
    api<any>(`/league/${LEAGUE_ID}`),
    api<any[]>(`/league/${LEAGUE_ID}/rosters`),
    leagueUsers(LEAGUE_ID),
    players(),
    buildBoard(season),
    fetch(
      `https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular&${q}&order_by=ppr`,
    )
      .then((r) => r.json() as Promise<any[]>)
      .catch(() => [] as any[]),
  ])

  const shape = leagueShape(league)
  const scoring: Record<string, number> = league.scoring_settings ?? {}

  // Whose roster are we improving?
  const want = (opts.owner ?? USERNAME ?? '').toLowerCase()
  const mine = (rosters as any[]).find((r) => {
    const u: any = (users as any)[r.owner_id]
    if (opts.owner) return (u?.display_name ?? '').toLowerCase() === want
    return r.owner_id === USER_ID || (u?.display_name ?? '').toLowerCase() === want
  })
  if (!mine)
    throw new Error(
      `no roster for ${opts.owner ?? USERNAME ?? '(unset)'} — check FF_USER_ID / FF_USERNAME`,
    )

  const byId = new Map<string, ProjRow>(board.map((r) => [r.id, r]))
  const wk = new Map<string, any>()
  for (const r of wkProjRaw) wk.set(r.player_id, r)
  const wkPts = (id: string, pos: string) => {
    const r = wk.get(id)
    if (!r) return null
    const st = r.stats ?? {}
    return num(pos === 'DEF' ? (st.pts_half_ppr ?? 0) : scoreStats(st, scoring))
  }
  // Freshest injury line available: the weekly feed moves in minutes, the
  // 24h-cached player DB is only a fallback. Same rule as the seatbelt.
  const injOf = (id: string) =>
    wk.get(id)?.player?.injury_status ?? (db as any)[id]?.injury_status ?? ''

  // Everyone on a roster anywhere in the league is unavailable, and everyone
  // dropped this season is worth flagging as probably-still-on-waivers.
  const owned = new Set<string>()
  for (const r of rosters as any[]) for (const p of r.players ?? []) owned.add(p)
  const droppedWk = new Map<string, number>()
  const txAll = await Promise.all(
    Array.from({ length: Math.max(week, 1) }, (_, i) => i + 1).map((w) =>
      api<any[]>(`/league/${LEAGUE_ID}/transactions/${w}`)
        .then((tx) => ({ w, tx }))
        .catch(() => ({ w, tx: [] as any[] })),
    ),
  )
  // The last time claims actually processed here, as observed — the only
  // waiver-clock fact we report, because it is read rather than inferred.
  let lastRun = 0
  for (const { w, tx } of txAll)
    for (const t of tx) {
      if (t.status !== 'complete') continue
      for (const pid of Object.keys(t.drops ?? {})) droppedWk.set(pid, w)
      if (t.type === 'waiver') lastRun = Math.max(lastRun, t.status_updated ?? 0)
    }

  // ---------------------------------------------------------------- our side
  const toHolding = (pid: string): Holding => {
    const p: any = (db as any)[pid] ?? {}
    const row = byId.get(pid)
    return {
      id: pid,
      name: row?.player ?? playerName(p),
      // A player with no projection row at all has no value we can defend.
      pos: row?.pos ?? p.position ?? '?',
      vorp: row?.vorp ?? -99,
      val: row?.val ?? -99,
      pos_rank: row?.pos_rank ?? null,
      inj: injOf(pid),
    }
  }
  // Only the men in active spots compete for the lineup or can be dropped for
  // room; IR/taxi occupants are listed in `players` too but hold no active spot.
  const split = splitRoster(mine)
  const roster: Holding[] = split.active.map(toHolding)
  const parked: Holding[] = split.parked.map(toHolding)
  const baseline = rosterValue(roster, shape)

  const rp: string[] = league.roster_positions ?? []
  if (!rp.length) throw new Error('league has no roster_positions — cannot count active roster spots')
  const capacity = activeCapacity(rp)
  const openSlots = Math.max(capacity - roster.length, 0)

  // The IR slot: how many exist, who is in them, and who on the active roster
  // qualifies to move there. Reported, never assumed — moving a man to IR is
  // the human's click, and until it happens his spot is not open.
  const reserveSlots: number = league.settings?.reserve_slots ?? 0
  const reserveUsed = (mine.reserve ?? []).length
  const eligible = reserveEligible(league.settings)
  const irEligible = roster.filter((h) => eligible.has(h.inj))

  // ------------------------------------------------------------- the pool
  const posFilter = opts.pos?.toUpperCase()
  const pool = board
    .filter((r) => !owned.has(r.id))
    .filter((r) => (posFilter ? r.pos === posFilter : true))
    .filter((r) => !DEAD.has(injOf(r.id)))

  const cands: Candidate[] = []
  for (const r of pool) {
    const cand: Holding = {
      id: r.id,
      name: r.player,
      pos: r.pos,
      vorp: r.vorp,
      val: r.val,
      pos_rank: r.pos_rank,
      inj: injOf(r.id),
    }
    const move = bestMove(roster, cand, shape, openSlots)
    if (!move) continue
    const gain = num(move.gain)
    const d = move.drop
    // A pair has to clear MARGIN to be worth the churn; an add into an empty
    // spot only has to be worth something, since it costs no one.
    if (d ? gain < MARGIN : gain <= 0) continue
    cands.push({
      player: r.player,
      pos: r.pos,
      team: r.team,
      val: num(r.val),
      pos_rank: r.pos_rank,
      wk: wkPts(r.id, r.pos),
      inj: injOf(r.id),
      dropped_wk: droppedWk.get(r.id) ?? null,
      drop: d ? `${d.name} (${d.pos}${d.pos_rank ?? ''}, val ${num(d.val)})` : null,
      drop_val: d ? num(d.val) : null,
      gain,
      bid: 0, // filled once we know the best gain on the board
      why: '',
    })
  }
  cands.sort((a, b) => b.gain - a.gain)

  // ------------------------------------------------------------ the budget
  const budget: number = league.settings?.waiver_budget ?? 0
  const used: number = mine.settings?.waiver_budget_used ?? 0
  const left = Math.max(budget - used, 0)
  const playoffStart: number = league.settings?.playoff_week_start ?? 15
  const weeksLeft = Math.max(playoffStart - week, 1)
  const market = await bidMarket(LEAGUE_ID, week)

  // Bid sizing: the budget has to last `weeksLeft` more waiver runs, so one
  // week's fair share is left/weeksLeft — and a genuinely roster-changing add
  // is worth several weeks' share, a marginal one a fraction. Scaled by gain
  // against the best gain on the board so the ceiling is spent on the best
  // player available, not the first one we happened to look at.
  const share = left / weeksLeft
  const best = cands[0]?.gain ?? 0
  for (const c of cands) {
    const rel = best > 0 ? c.gain / best : 0
    const raw = share * (1 + 3 * rel)
    c.bid = Math.max(1, Math.min(left, Math.round(raw)))
    c.why =
      `${c.pos}${c.pos_rank} ${c.drop ? `in for ${c.drop}` : 'into an open active spot (no drop)'} moves the startable roster +${c.gain}` +
      (c.dropped_wk ? `; dropped by a rival in wk ${c.dropped_wk}` : '') +
      (c.inj ? `; ${c.inj}` : '')
  }

  const limit = opts.limit ?? 10
  const top = cands.slice(0, limit)
  const u: any = (users as any)[mine.owner_id]

  return {
    season,
    week,
    owner: u?.display_name ?? mine.owner_id,
    team: u?.metadata?.team_name ?? '',
    generated: new Date().toISOString(),
    // HOLD is the common, correct answer. A pool with nothing in it is a
    // finding, not a failure to find something.
    verdict: top.length ? 'ACT' : 'HOLD',
    pool: pool.length,
    budget: { total: budget, used, left, weeks_left: weeksLeft, week_share: num(share) },
    market_bids: market,
    margin: MARGIN,
    roster_value: num(baseline),
    slots: {
      active_capacity: capacity,
      active: roster.length,
      open: openSlots,
      reserve_slots: reserveSlots,
      reserve_used: reserveUsed,
      reserved: parked.map((h) => `${h.name} (${h.pos}${h.inj ? `, ${h.inj}` : ''})`),
      ir_eligible: irEligible.map((h) => `${h.name} (${h.pos}, ${h.inj})`),
    },
    candidates: top,
    note: [
      top.length
        ? 'Gain = change in startable SEASON value after the move (add-only when `drop` is null). `wk` is colour only, never the ranking signal.'
        : `No move in a pool of ${pool.length} moves the startable roster ${openSlots ? 'at all' : `by ${MARGIN}+ season value`}. Hold the budget.`,
      'Drops never leave a starting position without a clean-status (not Q/D/O/IR) man, so a backup behind a hurt starter is not offered up.',
      irEligible.length && reserveUsed < reserveSlots
        ? `IR slot open and ${irEligible.map((h) => h.name).join(', ')} qualifies — moving him there opens an active spot; re-run after the click.`
        : '',
      `\`bid\` is a FAAB claim and applies only while the player is on waivers (claims last processed ${lastRun ? new Date(lastRun).toISOString() : 'never, this season'}). A player who has already cleared is a $0 first-come free-agent add — check his card in Sleeper before spending.`,
    ]
      .filter(Boolean)
      .join(' '),
  }
}
