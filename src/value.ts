// Value engine: score real NFL seasons under OUR league's exact scoring.
//
// Uses Sleeper's undocumented WEEKLY stats endpoints summed ourselves — the
// season-total endpoint returns partial data (verified vs nflverse 2026-07,
// e.g. Josh Allen 2025). Player IDs must come from the player DB, never by
// name-matching (two Josh Allens).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { api, LEAGUE_ID, playerName, players } from './sleeper'

const CACHE_DIR = join(import.meta.dir, '../.cache')
export const FANTASY_POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']

// Starters implied by our roster (1QB/2RB/2WR/1TE/1FLEX/1K/1DEF × 12 teams),
// flex mostly RB/WR, plus streaming churn at QB/TE/K/DEF.
export const REPLACEMENT_RANK: Record<string, number> = {
  QB: 14,
  RB: 30,
  WR: 30,
  TE: 14,
  K: 13,
  DEF: 13,
}

export async function seasonStats(
  season: string,
): Promise<Record<string, Record<string, number>>> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = Bun.file(join(CACHE_DIR, `stats-${season}.json`))
  if (await file.exists()) return file.json()
  const weeks = await Promise.all(
    Array.from({ length: 18 }, (_, i) =>
      api<Record<string, Record<string, number>>>(
        `/stats/nfl/regular/${season}/${i + 1}`,
      ).catch(() => ({})),
    ),
  )
  const agg: Record<string, Record<string, number>> = {}
  for (const wk of weeks)
    for (const [pid, st] of Object.entries(wk)) {
      if (!st?.gp) continue
      const a = (agg[pid] ??= {})
      for (const [k, v] of Object.entries(st))
        if (typeof v === 'number') a[k] = (a[k] ?? 0) + v
    }
  await Bun.write(file, JSON.stringify(agg))
  return agg
}

export function scoreStats(
  st: Record<string, number>,
  scoring: Record<string, number>,
): number {
  let s = 0
  for (const k in scoring) if (st[k]) s += scoring[k] * st[k]
  return s
}

export async function valueBoard(season: string) {
  const [league, stats, db] = await Promise.all([
    api(`/league/${LEAGUE_ID}`),
    seasonStats(season),
    players(),
  ])
  const scoring: Record<string, number> = league.scoring_settings
  const rows: { player: string; pos: string; team: string; gp: number; pts: number }[] = []
  for (const [pid, st] of Object.entries(stats)) {
    const p = db[pid]
    const pos = p?.position
    if (!pos || !FANTASY_POS.includes(pos)) continue
    const pts = scoreStats(st, scoring)
    if (pts < 10) continue
    rows.push({
      player: playerName(p),
      pos,
      team: p?.team ?? 'FA',
      gp: st.gp ?? 0,
      pts: Math.round(pts),
    })
  }
  rows.sort((a, b) => b.pts - a.pts)
  const byPos: Record<string, typeof rows> = {}
  for (const r of rows) (byPos[r.pos] ??= []).push(r)
  const repl: Record<string, number> = {}
  for (const [pos, list] of Object.entries(byPos))
    repl[pos] = list[(REPLACEMENT_RANK[pos] ?? 13) - 1]?.pts ?? 0
  const at = (list: typeof rows, n: number) => list[n - 1]?.pts ?? 0
  const baselines = Object.entries(byPos).map(([pos, list]) => ({
    pos,
    n1: at(list, 1),
    n3: at(list, 3),
    n6: at(list, 6),
    n12: at(list, 12),
    n18: at(list, 18),
    n24: at(list, 24),
    n36: at(list, 36),
    repl: repl[pos],
    repl_rank: REPLACEMENT_RANK[pos],
  }))
  const vorp = rows
    .map((r) => ({ ...r, vorp: Math.round(r.pts - (repl[r.pos] ?? 0)) }))
    .sort((a, b) => b.vorp - a.vorp)
  return { baselines, vorp, scoring }
}
