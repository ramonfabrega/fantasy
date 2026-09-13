// Gameday seatbelt: the Sunday check that costs a season if you skip it once.
//
// Answers three questions about a roster, in order of how much they hurt:
//   1. Is a starter Out / inactive in a game that has not locked yet?
//   2. Is a starter about to play with no game at all (bye, released, no team)?
//   3. Is a bench player simply projected higher than a changeable starter?
//
// Freshness is the whole point, so two sources are deliberately NOT used:
//
//   - `.cache/players.json` is 24h-cached because Sleeper asks for max one
//     fetch a day of the 5MB DB. On a gameday that cache is exactly as old as
//     the thing you are trying to catch. The weekly projections feed carries
//     the same `injury_status` with a `news_updated` stamp that moves in
//     minutes, so it is the source of truth for status here.
//   - The odds feed is read cache-only. The market is a useful tiebreak, but a
//     seatbelt that stalls on a third-party API or burns a monthly credit
//     every time it runs is a seatbelt you turn off.
//
// A game is changeable iff Sleeper's own schedule says `pre_game`. That is the
// same lock Sleeper applies in the app, so it can never disagree with what the
// human sees when they go to make the swap.
import {
  api,
  FLEX_KINDS,
  leagueUsers,
  LEAGUE_ID,
  playerName,
  players,
  USER_ID,
  USERNAME,
} from './sleeper'
import { FANTASY_POS, scoreStats } from './value'
import { oddsBoard } from './odds'

/** Statuses that mean "this player will not play", in descending certainty. */
const DEAD = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'DNR', 'Inactive'])
/** Statuses that mean "might not play" — worth a look, not an automatic swap. */
const IFFY = new Set(['Doubtful', 'Questionable'])

/** Bench player must beat a starter by this much before we call it an upgrade. */
const UPGRADE_MARGIN = 1.5

export type Spot = {
  id: string
  name: string
  pos: string
  team: string
  /** e.g. `@PHI`, or `—` when the player has no game this week. */
  game: string
  kickoff: string | null
  /** Sleeper's own game status: pre_game / in_game / complete. */
  gameStatus: string
  /** True once the game has kicked — the slot can no longer be changed. */
  locked: boolean
  inj: string
  /** How long ago the injury line last moved, in hours. Stale = less trustworthy. */
  newsAgeH: number | null
  proj: number
  actual: number | null
  /** Vegas implied team total, when a cached odds board covers the game. */
  implied: number | null
}

export type Alert = {
  level: 'ACT' | 'WATCH'
  kind: 'OUT' | 'IFFY' | 'NO_GAME' | 'UPGRADE'
  slot: string
  out: string
  in: string | null
  gain: number | null
  /** When this decision expires: kickoff of the outgoing player's game. */
  deadline: string | null
  why: string
}

const num = (n: number) => Math.round(n * 10) / 10

/** Positions that can legally fill a roster slot. */
function eligibleFor(slot: string): string[] {
  return FLEX_KINDS[slot] ?? [slot]
}

/**
 * What a player is worth to the lineup right now, for ranking only.
 *
 * This is NOT his projection. A projection forecasts a player who plays; the
 * whole job here is the player who does not. Sleeper's feed keeps publishing a
 * healthy-looking number for a while after a ruling, so a seatbelt that ranked
 * on the raw projection would cheerfully re-select the man just declared out.
 */
function worth(s: Spot): number {
  if (s.game === '—') return -1 // no game is a guaranteed zero, whoever he is
  if (DEAD.has(s.inj)) return -1
  if (s.inj === 'Doubtful') return s.proj * 0.35
  return s.proj // Questionable is already priced into the projection
}

/**
 * Refill the changeable slots optimally, then put everyone back where he was.
 *
 * Locked players are pinned where they are - a kicked-off game is not a
 * decision any more, and pretending otherwise produces advice the human cannot
 * act on. Everything else is a free agent within the lineup: dedicated slots
 * take the best eligible body, then flex slots (most restrictive first) take
 * the best of what is left. With non-overlapping dedicated positions this is
 * exactly optimal, not a heuristic.
 *
 * The second pass matters as much as the first. Two interchangeable WRs can be
 * assigned to each other's slots at identical total value, and a naive
 * optimizer does exactly that - emitting "start WR2 over WR1" noise next to
 * the one swap that is real. So incumbents are handed back their own slot
 * whenever it costs nothing, and the caller's diff is then only genuine moves.
 */
export function optimize(slots: string[], filled: (Spot | null)[], bench: Spot[]) {
  const pinned = new Map<number, Spot>()
  const pool: Spot[] = [...bench.filter((b) => !b.locked)]
  slots.forEach((_, i) => {
    const s = filled[i]
    if (!s) return
    if (s.locked) pinned.set(i, s)
    else pool.push(s)
  })
  pool.sort((a, b) => worth(b) - worth(a))

  const open = slots
    .map((slot, i) => ({ slot, i, elig: eligibleFor(slot) }))
    .filter((x) => !pinned.has(x.i))
    .sort((a, b) => a.elig.length - b.elig.length)

  const out: (Spot | null)[] = slots.map((_, i) => pinned.get(i) ?? null)
  const taken = new Set<string>()
  for (const { i, elig } of open) {
    const pick = pool.find(
      (p) => !taken.has(p.id) && elig.includes(p.pos) && worth(p) > 0,
    )
    if (!pick) continue
    taken.add(pick.id)
    out[i] = pick
  }

  // Stabilize: an incumbent who survived the cut goes back to his own slot,
  // trading places with whoever displaced him whenever that is legal.
  const eligAt = (i: number) => eligibleFor(slots[i])
  for (let pass = 0; pass < slots.length; pass++) {
    let moved = false
    for (const { i } of open) {
      const inc = filled[i]
      if (!inc || inc.locked || out[i]?.id === inc.id) continue
      const j = out.findIndex((x) => x?.id === inc.id)
      if (j < 0 || pinned.has(j)) continue
      if (!eligAt(i).includes(inc.pos)) continue
      const displaced = out[i]
      if (displaced && !eligAt(j).includes(displaced.pos)) continue
      out[j] = displaced
      out[i] = inc
      moved = true
    }
    if (!moved) break
  }
  return out
}

/**
 * Turn the current-vs-optimal comparison into alerts, worst first.
 *
 * An OUT starter in a game that has not locked is the only thing here that is
 * unambiguously a mistake. Everything else is a judgement call and is labelled
 * as one, because a seatbelt that cries ACT at a coin-flip gets ignored.
 */
export function buildAlerts(
  slots: string[],
  current: (Spot | null)[],
  best: (Spot | null)[],
): Alert[] {
  const alerts: Alert[] = []
  slots.forEach((slot, i) => {
    const s = current[i]
    const b = best[i]
    if (!s) {
      if (b)
        alerts.push({
          level: 'ACT',
          kind: 'OUT',
          slot,
          out: '(empty)',
          in: b.name,
          gain: b.proj,
          deadline: b.kickoff,
          why: `${slot} is empty`,
        })
      return
    }
    if (s.locked) return
    const swap = b && b.id !== s.id ? b : null
    if (s.game === '—')
      alerts.push({
        level: 'ACT',
        kind: 'NO_GAME',
        slot,
        out: s.name,
        in: swap?.name ?? null,
        deadline: s.kickoff,
        gain: null, // see apply[] / gain_total: a cascade makes a slot-level delta lie
        why: `${s.name} has no game this week — a guaranteed zero`,
      })
    else if (DEAD.has(s.inj))
      alerts.push({
        level: 'ACT',
        kind: 'OUT',
        slot,
        out: s.name,
        in: swap?.name ?? null,
        deadline: s.kickoff,
        gain: null, // see apply[] / gain_total: a cascade makes a slot-level delta lie
        why: `${s.name} is ${s.inj}${s.newsAgeH != null ? ` (news ${s.newsAgeH}h old)` : ''}`,
      })
    else if (IFFY.has(s.inj))
      alerts.push({
        level: 'WATCH',
        kind: 'IFFY',
        slot,
        out: s.name,
        in: swap?.name ?? null,
        deadline: s.kickoff,
        gain: swap ? num(swap.proj - s.proj) : null,
        why:
          `${s.name} is ${s.inj}${s.newsAgeH != null ? ` (news ${s.newsAgeH}h old)` : ''}` +
          (swap ? '' : ' — but nothing on the bench beats him, so this is a watch, not a swap'),
      })
    else if (swap && swap.proj - s.proj >= UPGRADE_MARGIN)
      alerts.push({
        level: 'WATCH',
        kind: 'UPGRADE',
        slot,
        out: s.name,
        in: swap.name,
        deadline: s.kickoff,
        gain: num(swap.proj - s.proj),
        why: `${swap.name} projects ${num(swap.proj - s.proj)} higher and is on the bench`,
      })
  })
  alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === 'ACT' ? -1 : 1))
  return alerts
}

export async function seatbelt(opts: { week?: number; owner?: string } = {}) {
  const state = await api<any>('/state/nfl')
  const season: string = state.season
  const week = opts.week ?? state.week
  if (!week || week < 1)
    throw new Error(`no NFL week in progress (${state.season_type}) — pass --week`)

  const q = FANTASY_POS.map((p) => `position[]=${p}`).join('&')
  const [league, rosters, users, db, projRaw, statsRaw, sched, odds] = await Promise.all([
    api<any>(`/league/${LEAGUE_ID}`),
    api<any[]>(`/league/${LEAGUE_ID}/rosters`),
    leagueUsers(LEAGUE_ID),
    players(),
    fetch(
      `https://api.sleeper.com/projections/nfl/${season}/${week}?season_type=regular&${q}&order_by=ppr`,
    ).then((r) => r.json()) as Promise<any[]>,
    api<any>(`/stats/nfl/regular/${season}/${week}`).catch(() => ({})),
    fetch(`https://api.sleeper.app/schedule/nfl/regular/${season}`).then((r) =>
      r.json(),
    ) as Promise<any[]>,
    oddsBoard(false, true).catch(() => ({ games: [] as any[] })),
  ])

  const scoring = league.scoring_settings ?? {}

  // One row per team for this week: who they play, whether it has locked, and
  // the market's view of how many points that offense will put up.
  const byTeam: Record<string, any> = {}
  for (const g of sched.filter((g: any) => g.week === week)) {
    byTeam[g.home] = { ...g, opp: g.away, side: 'vs' }
    byTeam[g.away] = { ...g, opp: g.home, side: '@' }
  }
  // The odds board runs weeks ahead, so a game only counts if its pairing is
  // THIS week's pairing for that team. Matching on team alone silently picks up
  // a January game and reports it as the next lock.
  const kickoffOf: Record<string, string> = {}
  const impliedOf: Record<string, number> = {}
  for (const g of (odds as any).games ?? []) {
    const [away, home] = String(g.game).split('@')
    for (const [t, opp] of [
      [away, home],
      [home, away],
    ]) {
      if (byTeam[t]?.opp !== opp) continue
      kickoffOf[t] = g.kickoff
      const v = (g.implied ?? {})[t]
      if (typeof v === 'number') impliedOf[t] = v
    }
  }

  const proj: Record<string, any> = {}
  for (const r of projRaw) proj[r.player_id] = r

  const now = Date.now()
  const spot = (pid: string): Spot => {
    const p: any = (db as any)[pid] ?? {}
    const pr = proj[pid]
    const pos = p.position ?? pr?.player?.position ?? '?'
    const team = p.team ?? pr?.team ?? ''
    const g = byTeam[team]
    const st = (statsRaw as any)[pid]
    // Injury status: the projections feed first (it moves in minutes), the
    // player DB only as a fallback for anyone the feed does not carry.
    const inj = pr?.player?.injury_status ?? p.injury_status ?? ''
    const news = pr?.player?.news_updated ?? p.news_updated ?? null
    return {
      id: pid,
      name: playerName(p) === '?' ? (pr ? `${pr.player?.first_name ?? ''} ${pr.player?.last_name ?? ''}`.trim() : pid) : playerName(p),
      pos,
      team,
      game: g ? `${g.side}${g.opp}` : '—',
      kickoff: kickoffOf[team] ?? null,
      gameStatus: g?.status ?? 'none',
      locked: !!g && g.status !== 'pre_game',
      inj,
      newsAgeH: news ? num((now - news) / 3_600_000) : null,
      proj: pr?.stats ? num(scoreStats(pr.stats, scoring)) : 0,
      actual: st ? num(scoreStats(st, scoring)) : null,
      implied: impliedOf[team] ?? null,
    }
  }

  const want = opts.owner ?? USERNAME ?? ''
  const roster = rosters.find((r) => {
    const u = users[r.owner_id]
    if (opts.owner)
      return u?.display_name === opts.owner || u?.metadata?.team_name === opts.owner
    return r.owner_id === USER_ID || u?.display_name === USERNAME
  })
  if (!roster)
    throw new Error(
      `no roster for "${want}" — check FF_USER_ID / FF_USERNAME, or pass an owner`,
    )

  const slots: string[] = (league.roster_positions ?? []).filter(
    (s: string) => !['BN', 'IR', 'TAXI'].includes(s),
  )
  const starterIds: string[] = roster.starters ?? []
  const current = slots.map((_, i) => {
    const pid = starterIds[i]
    return pid && pid !== '0' ? spot(pid) : null
  })
  const bench = (roster.players ?? [])
    .filter((p: string) => !starterIds.includes(p))
    .map(spot)
    .sort((a: Spot, b: Spot) => b.proj - a.proj)

  const best = optimize(slots, current, bench)

  const alerts = buildAlerts(slots, current, best)

  // Alerts say WHY; apply says WHAT TO CLICK. They are not the same list: a
  // forced swap can cascade into a slot that raised no alert of its own, and a
  // human following only the alerts would leave that slot empty.
  const apply = slots
    .map((slot, i) => ({ slot, from: current[i], to: best[i] }))
    .filter((m) => m.from?.id !== m.to?.id)
    .map((m) => ({
      slot: m.slot,
      out: m.from?.name ?? '(empty)',
      in: m.to?.name ?? '(empty)',
    }))

  const sum = (xs: (Spot | null)[]) =>
    num(xs.reduce((a, s) => a + (s ? (s.locked ? (s.actual ?? 0) : s.proj) : 0), 0))
  const projected = sum(current)
  const projectedBest = sum(best)

  const changeable = current.filter((s) => s && !s.locked).length
  const nextLock = current
    .filter((s): s is Spot => !!s && !s.locked && !!s.kickoff)
    .map((s) => s.kickoff!)
    .sort()[0] ?? null

  return {
    season,
    week,
    owner: users[roster.owner_id]?.display_name ?? '?',
    team: users[roster.owner_id]?.metadata?.team_name ?? '',
    generated: new Date().toISOString(),
    verdict: alerts.some((a) => a.level === 'ACT')
      ? ('ACT' as const)
      : alerts.length
        ? ('WATCH' as const)
        : ('CLEAR' as const),
    changeable,
    locked: current.filter((s) => s?.locked).length,
    next_lock: nextLock,
    alerts,
    banked: num(
      current.filter((s) => s?.locked).reduce((a, s) => a + (s!.actual ?? 0), 0),
    ),
    projected,
    projected_if_applied: projectedBest,
    gain_total: num(projectedBest - projected),
    apply,
    starters: slots.map((slot, i) => ({ slot, ...(current[i] ?? { name: '(empty)' }) })),
    bench,
    market: Object.keys(kickoffOf).length ? ('cached' as const) : ('unavailable' as const),
  }
}
