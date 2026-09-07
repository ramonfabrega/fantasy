// Projection layer: Sleeper's season projections (rotowire, unauthenticated)
// re-scored under OUR league rules, joined to half-PPR ADP (the exact number
// our opponents see in the Sleeper draft room), injury status, and last
// season's actuals. Everything downstream (board, live, mock) reads this.
//
// Endpoint: api.sleeper.com/projections/nfl/<season>?season_type=regular&position[]=..
// Refreshed by Sleeper roughly daily; we cache 1h (`--fresh` to bypass).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { api, LEAGUE_ID, playerName, players, leagueShape, DEFAULT_SHAPE, type Shape } from './sleeper'
import { FANTASY_POS, scoreStats, seasonStats } from './value'

// Replacement = roughly the last player drafted at each position, NOT the last
// starter (`ff value` uses starter-level ranks). Bench RB/WR carry real value —
// injuries, flex, trade chips — and a starter-level baseline zeroes them out by
// round 7. Calibrated on a 12-team, 15-round draft and scaled to the actual
// league below, so a 10- or 14-team league gets its own waiver line.
const BASE_REPL: Record<string, number> = { QB: 16, RB: 44, WR: 44, TE: 16, K: 12, DEF: 12 }
const BASE_TEAMS = 12
const BASE_ROUNDS = 15

/** Draft-end replacement rank per position, scaled from the 12x15 calibration. */
function draftRepl(shape: Shape): Record<string, number> {
  const scale = (shape.teams * shape.rounds) / (BASE_TEAMS * BASE_ROUNDS)
  const out: Record<string, number> = {}
  for (const [pos, n] of Object.entries(BASE_REPL)) out[pos] = Math.max(shape.teams, Math.round(n * scale))
  return out
}

const CACHE_DIR = join(import.meta.dir, '../.cache')
const PROJ_TTL_MS = 60 * 60 * 1000
const PROJ_BASE = 'https://api.sleeper.com/projections/nfl'

export type ProjRow = {
  id: string
  player: string
  pos: string
  team: string
  pts: number // under our scoring
  pts_sleeper: number // rotowire half-PPR as published (sanity)
  adp: number | null // half-PPR ADP, null = undrafted in Sleeper mocks
  inj: string // Questionable / IR / PUP / NA / Sus / ''
  exp: number // years of experience (0 = rookie)
  last: number | null // 2025 actual under our scoring
  // filled by buildBoard
  vorp: number // over starter replacement (flex-aware); can be negative
  val: number // max(vorp, bench/2) — the number the recommender ranks on
  tier: number
  pos_rank: number
  ovr_rank: number
  edge: number | null // adp − ovr_rank: +ve = market lets them fall to us
}

export async function fetchProjections(season: string, fresh = false): Promise<any[]> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = Bun.file(join(CACHE_DIR, `proj-${season}.json`))
  if (!fresh && (await file.exists()) && Date.now() - file.lastModified < PROJ_TTL_MS)
    return file.json()
  const q = FANTASY_POS.map((p) => `position[]=${p}`).join('&')
  const res = await fetch(
    `${PROJ_BASE}/${season}?season_type=regular&${q}&order_by=adp_half_ppr`,
  )
  if (!res.ok) throw new Error(`sleeper projections → ${res.status}`)
  const data = (await res.json()) as any[]
  await Bun.write(file, JSON.stringify(data))
  return data
}

let boardCache: { key: string; rows: ProjRow[] } | null = null

/** Scored + ranked projection board for the whole player pool (not draft-aware). */
export async function buildBoard(season: string, fresh = false): Promise<ProjRow[]> {
  const key = `${season}:${fresh}`
  if (boardCache?.key === key && !fresh) return boardCache.rows
  const prev = String(Number(season) - 1)
  const [league, raw, db, last] = await Promise.all([
    api(`/league/${LEAGUE_ID}`),
    fetchProjections(season, fresh),
    players(),
    seasonStats(prev).catch(() => ({}) as Record<string, Record<string, number>>),
  ])
  const scoring: Record<string, number> = league.scoring_settings
  const rows: ProjRow[] = []
  for (const r of raw) {
    const st = r.stats ?? {}
    const pos = r.player?.position
    if (!pos || !FANTASY_POS.includes(pos)) continue
    const sleeperPts = st.pts_half_ppr ?? 0
    if (!sleeperPts) continue
    // DEF projection rows are stubs (gp=1, bucket counts) — trust the published total.
    const pts = pos === 'DEF' ? sleeperPts : scoreStats(st, scoring)
    const p = db[r.player_id]
    const lastSt = last[r.player_id]
    rows.push({
      id: r.player_id,
      player: p ? playerName(p) : `${r.player.first_name} ${r.player.last_name}`,
      pos,
      team: r.team ?? p?.team ?? 'FA',
      pts: Math.round(pts * 10) / 10,
      pts_sleeper: Math.round(sleeperPts),
      adp: st.adp_half_ppr && st.adp_half_ppr < 999 ? st.adp_half_ppr : null,
      inj: r.player?.injury_status ?? p?.injury_status ?? '',
      exp: r.player?.years_exp ?? p?.years_exp ?? 0,
      last: lastSt ? Math.round(scoreStats(lastSt, scoring)) : null,
      vorp: 0,
      val: 0,
      tier: 0,
      pos_rank: 0,
      ovr_rank: 0,
      edge: null,
    })
  }
  rankRows(rows, leagueShape(league))
  boardCache = { key, rows }
  return rows
}

/**
 * Value, two-layered:
 *  - vorp: pts over the STARTER replacement, derived from the league's own roster
 *    (teams × each starting slot), with every flex slot in the league allocated
 *    jointly to the best remaining eligible position, so RB and WR baselines move
 *    together instead of each position pretending the flex doesn't exist. Each
 *    position's baseline sits one past its last starter — the streaming slot.
 *  - bench: pts over the draft-END replacement (what waivers look like).
 *  - val = max(vorp, bench/2): starters are valued as starters; bench fliers keep
 *    a positive, half-weighted value so late rounds still rank by upside.
 * Also assigns gap-based tiers, positional and overall rank, ADP edge.
 */
export function rankRows(rows: ProjRow[], shape: Shape = SHAPE) {
  SHAPE = shape
  STARTERS = shape.starters
  FLEX = shape.flexPos
  const byPos: Record<string, ProjRow[]> = {}
  for (const r of rows) (byPos[r.pos] ??= []).push(r)
  for (const list of Object.values(byPos)) list.sort((a, b) => b.pts - a.pts)
  const pts = (pos: string, i: number) => byPos[pos]?.[i]?.pts ?? 0
  // Index of the first NON-starter at each position across the whole league:
  // 12 teams starting 2 RB means RBs 1-24 start, so index 24 (the 25th RB) is
  // the replacement — one past the last starter, i.e. the streaming slot.
  const idx: Record<string, number> = {}
  for (const pos of Object.keys(byPos)) idx[pos] = (shape.starters[pos] ?? 0) * shape.teams
  // Flex allocation: hand each flex slot in the league to whichever eligible
  // position has the best player left, so their baselines move together.
  const pool = shape.flexPos.filter((p) => byPos[p]?.length)
  for (let f = 0; f < shape.flexSlots * shape.teams && pool.length; f++) {
    const best = pool.reduce((a, b) => (pts(b, idx[b] ?? 0) > pts(a, idx[a] ?? 0) ? b : a))
    idx[best] = (idx[best] ?? 0) + 1
  }
  const starterRepl: Record<string, number> = {}
  for (const pos of Object.keys(byPos)) starterRepl[pos] = pts(pos, idx[pos] ?? 0)
  const DRAFT_REPL = draftRepl(shape)
  benchRepl = {}
  for (const [pos, list] of Object.entries(byPos)) {
    const sRepl = starterRepl[pos] ?? 0
    const bRepl = list[(DRAFT_REPL[pos] ?? shape.teams) - 1]?.pts ?? 0
    benchRepl[pos] = bRepl
    let tier = 1
    list.forEach((r, i) => {
      r.pos_rank = i + 1
      r.vorp = Math.round(r.pts - sRepl)
      r.val = Math.round(Math.max(r.pts - sRepl, (r.pts - bRepl) / 2))
      // new tier when the drop from the previous player is material
      const prev = list[i - 1]
      if (prev && prev.pts - r.pts > Math.max(7, prev.pts * 0.045)) tier++
      r.tier = tier
    })
  }
  rows.sort((a, b) => b.val - a.val || b.pts - a.pts)
  rows.forEach((r, i) => {
    r.ovr_rank = i + 1
    r.edge = r.adp === null ? null : Math.round(r.adp - r.ovr_rank)
  })
  const flex: Record<string, number> = {}
  for (const pos of shape.flexPos) flex[pos] = (idx[pos] ?? 0) - (shape.starters[pos] ?? 0) * shape.teams
  return { rows, starterRepl, flex }
}

// ---------------------------------------------------------------- draft math

export function slotForPick(pickNo: number, teams: number): number {
  const round = Math.ceil(pickNo / teams)
  const idx = ((pickNo - 1) % teams) + 1
  return round % 2 === 1 ? idx : teams + 1 - idx
}

export function picksForSlot(slot: number, teams: number, rounds: number): number[] {
  const out: number[] = []
  for (let n = 1; n <= teams * rounds; n++) if (slotForPick(n, teams) === slot) out.push(n)
  return out
}

/** P(player is gone before pick `at`) from ADP — spread widens deeper in the draft. */
export function goneProb(adp: number | null, at: number): number {
  if (adp === null) return 0.02
  const s = 3 + 0.09 * adp
  return 1 / (1 + Math.exp(-(at - adp) / s))
}

// --------------------------------------------------------- recommendation

/**
 * The league's starting slots and flex-eligible positions. These default to a
 * standard 12-team build and are REPLACED by the real league's construction as
 * soon as `rankRows` runs (i.e. after any `buildBoard`), the same way
 * `benchRepl` is populated. Read them after awaiting a board, never before.
 */
export let SHAPE: Shape = DEFAULT_SHAPE
export let STARTERS: Record<string, number> = SHAPE.starters
export let FLEX: string[] = SHAPE.flexPos

/** Draft-end (waiver) replacement pts per position; set by rankRows. */
export let benchRepl: Record<string, number> = {}

/**
 * Points of the best legal lineup from `rows`, with every empty starter slot
 * filled at waiver-replacement level. So an empty WR2 costs exactly what a
 * waiver WR scores, and a real WR2 is credited with the difference.
 */
export function lineupPts(rows: ProjRow[]): number {
  const by = (pos: string) => rows.filter((r) => r.pos === pos).sort((a, b) => b.pts - a.pts)
  const used = new Set<string>()
  let total = 0
  for (const [pos, n] of Object.entries(STARTERS)) {
    const list = by(pos)
    for (let i = 0; i < n; i++) {
      const r = list[i]
      const repl = benchRepl[pos] ?? 0
      if (r) {
        used.add(r.id)
        // never worse than the empty slot: a starter below waiver level would be
        // streamed, so drafting one is worth zero, not negative.
        total += Math.max(r.pts, repl)
      } else total += repl
    }
  }
  // every flex slot the league starts, best eligible player first
  const flexRepl = FLEX.length ? Math.max(...FLEX.map((p) => benchRepl[p] ?? 0)) : 0
  const bench = rows
    .filter((r) => FLEX.includes(r.pos) && !used.has(r.id))
    .sort((a, b) => b.pts - a.pts)
  for (let i = 0; i < SHAPE.flexSlots; i++) {
    const r = bench[i]
    if (r) used.add(r.id)
    total += r ? Math.max(r.pts, flexRepl) : flexRepl
  }
  return total
}

/**
 * Policy multiplier — doctrine that the lineup math can't see:
 * late QB (1-QB league, corpus-validated), one TE, K/DEF only in the last two rounds.
 */
export function policyMult(pos: string, owned: Record<string, number>, round: number, rounds = 15): number {
  const n = owned[pos] ?? 0
  switch (pos) {
    case 'QB':
      if (n === 0) return round >= 8 ? 1 : round >= 5 ? 0.7 : 0.5
      return 0.25
    case 'TE':
      return n === 0 ? 1 : 0.35
    case 'K':
    case 'DEF':
      if (round < rounds - 1) return 0
      return n === 0 ? 1 : 0
  }
  return 1
}

export type Rec = ProjRow & { rec: number; gain: number; gone: number; gone2: number | null }

/**
 * Rank available players for us at pick `at` (and our following pick `at2`).
 * rec = (lineup gain if we add them now) + 0.4 × bench/upside value, × policy × risk.
 * Lineup gain is what actually wins weeks; the bench term keeps depth and
 * upside fliers in the conversation once starters are set.
 */
export function recommend(
  available: ProjRow[],
  ours: ProjRow[],
  at: number,
  at2: number | null,
  teams = SHAPE.teams,
  rounds = SHAPE.rounds,
): Rec[] {
  const round = Math.ceil(at / teams)
  const owned = countPos(ours)
  const base = lineupPts(ours)
  return available
    .map((r) => {
      const mult = policyMult(r.pos, owned, round, rounds)
      // flagged players: a real risk discount, never a silent exclusion
      const risk = r.inj === 'IR' || r.inj === 'PUP' || r.inj === 'Sus' || r.inj === 'NA' ? 0.35
        : r.inj === 'Out' || r.inj === 'Doubtful' ? 0.7
        : 1
      const gain = mult === 0 ? 0 : Math.round(lineupPts([...ours, r]) - base)
      const rec = mult === 0 ? -9999 : (gain + 0.4 * Math.max(r.val, 0)) * mult * risk
      return {
        ...r,
        rec: Math.round(rec),
        gain,
        gone: Math.round(goneProb(r.adp, at) * 100),
        gone2: at2 ? Math.round(goneProb(r.adp, at2) * 100) : null,
      }
    })
    .sort((a, b) => b.rec - a.rec || b.val - a.val)
}

export function countPos(rows: { pos: string }[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const r of rows) c[r.pos] = (c[r.pos] ?? 0) + 1
  return c
}

export function flag(r: ProjRow): string {
  const f: string[] = []
  if (r.inj) f.push(r.inj === 'Questionable' ? 'Q' : r.inj)
  if (r.pos === 'K' || r.pos === 'DEF') return f.join(' ')
  if (r.exp === 0) f.push('R')
  if (r.last !== null && r.last > 0 && r.pts > r.last * 1.35) f.push('↑')
  if (r.last !== null && r.last > 60 && r.pts < r.last * 0.75) f.push('↓')
  return f.join(' ')
}
