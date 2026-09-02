// Projection layer: Sleeper's season projections (rotowire, unauthenticated)
// re-scored under OUR league rules, joined to half-PPR ADP (the exact number
// our opponents see in the Sleeper draft room), injury status, and last
// season's actuals. Everything downstream (board, live, mock) reads this.
//
// Endpoint: api.sleeper.com/projections/nfl/<season>?season_type=regular&position[]=..
// Refreshed by Sleeper roughly daily; we cache 1h (`--fresh` to bypass).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { api, LEAGUE_ID, playerName, players } from './sleeper'
import { FANTASY_POS, scoreStats, seasonStats } from './value'

// Replacement = roughly the last player drafted at each position in a 12-team,
// 15-round draft (what's left on waivers), NOT the last starter (`ff value`
// uses starter-level ranks). Bench RB/WR carry real value — injuries, flex,
// trade chips — and a starter-level baseline zeroes them out by round 7.
export const DRAFT_REPL: Record<string, number> = { QB: 16, RB: 44, WR: 44, TE: 16, K: 12, DEF: 12 }

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
  rankRows(rows)
  boardCache = { key, rows }
  return rows
}

/**
 * Value, two-layered:
 *  - vorp: pts over the STARTER replacement. 12 teams × (1QB/2RB/2WR/1TE/1FLEX)
 *    with the 12 flex slots allocated jointly to the best remaining RB/WR/TE, so
 *    RB and WR baselines move together instead of each position pretending the
 *    flex doesn't exist. QB/TE/K/DEF get one streaming slot of slack.
 *  - bench: pts over the draft-END replacement (what waivers look like).
 *  - val = max(vorp, bench/2): starters are valued as starters; bench fliers keep
 *    a positive, half-weighted value so late rounds still rank by upside.
 * Also assigns gap-based tiers, positional and overall rank, ADP edge.
 */
export function rankRows(rows: ProjRow[]) {
  const byPos: Record<string, ProjRow[]> = {}
  for (const r of rows) (byPos[r.pos] ??= []).push(r)
  for (const list of Object.values(byPos)) list.sort((a, b) => b.pts - a.pts)
  const pts = (pos: string, i: number) => byPos[pos]?.[i]?.pts ?? 0
  // flex allocation: next-in-line index per position after the fixed starters
  const idx: Record<string, number> = { RB: 24, WR: 24, TE: 12 }
  for (let f = 0; f < 12; f++) {
    const best = (['RB', 'WR', 'TE'] as const).reduce((a, b) => (pts(b, idx[b]!) > pts(a, idx[a]!) ? b : a))
    idx[best]!++
  }
  const starterRepl: Record<string, number> = {
    QB: pts('QB', 13),
    RB: pts('RB', idx.RB!),
    WR: pts('WR', idx.WR!),
    TE: pts('TE', Math.max(idx.TE!, 12)),
    K: pts('K', 11),
    DEF: pts('DEF', 11),
  }
  for (const [pos, list] of Object.entries(byPos)) {
    const sRepl = starterRepl[pos] ?? 0
    const bRepl = list[(DRAFT_REPL[pos] ?? 13) - 1]?.pts ?? 0
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
  return { rows, starterRepl, flex: { RB: idx.RB! - 24, WR: idx.WR! - 24, TE: idx.TE! - 12 } }
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

export const STARTERS: Record<string, number> = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 }

/**
 * Need multiplier on VORP given what we already hold and the round.
 * Encodes doctrine: RB/WR depth is real value (flex + injuries), QB waits
 * (1-QB league, late-QB edge is corpus-validated), one TE, K/DEF last two rounds.
 */
export function needMult(pos: string, owned: Record<string, number>, round: number, rounds = 15): number {
  const n = owned[pos] ?? 0
  switch (pos) {
    case 'RB':
    case 'WR':
      return [1, 1, 0.85, 0.6, 0.45, 0.3][n] ?? 0.2
    case 'TE':
      return n === 0 ? 1 : n === 1 ? 0.25 : 0.05
    case 'QB':
      if (n === 0) return round >= 8 ? 1 : round >= 5 ? 0.7 : 0.5
      return n === 1 ? 0.15 : 0.02
    case 'K':
    case 'DEF':
      if (round < rounds - 1) return 0
      return n === 0 ? 1 : 0
  }
  return 1
}

export type Rec = ProjRow & { rec: number; gone: number; gone2: number | null }

/** Rank available players for us at pick `at` (and our following pick `at2`). */
export function recommend(
  available: ProjRow[],
  owned: Record<string, number>,
  at: number,
  at2: number | null,
  teams = 12,
  rounds = 15,
): Rec[] {
  const round = Math.ceil(at / teams)
  return available
    .map((r) => {
      const mult = needMult(r.pos, owned, round, rounds)
      // flagged players: a real risk discount, never a silent exclusion
      const risk = r.inj === 'IR' || r.inj === 'PUP' || r.inj === 'Sus' || r.inj === 'NA' ? 0.35
        : r.inj === 'Out' || r.inj === 'Doubtful' ? 0.7
        : 1
      // mult 0 = position closed for this round (K/DEF early): hard exclude.
      // Negative VORP stays negative and unscaled so ordering among bench
      // fliers is by value, not by how little we need the position.
      const rec = mult === 0 ? -9999 : r.val > 0 ? r.val * mult * risk : r.val * (2 - mult) / risk
      return {
        ...r,
        rec: Math.round(rec),
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
