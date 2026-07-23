// The greater corpus: snowball-crawl Sleeper leagues similar to ours
// (12-team, ~half-PPR, 1QB, not best-ball) and study how they were won.
//
// Crawl: our league's users → their leagues → those leagues' users → ...
// Throttled well under Sleeper's ~1000 req/min guidance.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { api, LEAGUE_ID } from './sleeper'
import { seasonStats, scoreStats } from './value'

const META_DIR = join(import.meta.dir, '../.cache/meta')

async function pmap<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++
        try {
          out[idx] = await fn(items[idx])
        } catch {
          out[idx] = null
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    }),
  )
  return out
}

const isSimilar = (l: any) =>
  l?.settings?.num_teams === 12 &&
  Math.abs((l?.scoring_settings?.rec ?? 0) - 0.5) <= 0.1 &&
  !(l?.roster_positions ?? []).includes('SUPER_FLEX') &&
  l?.settings?.best_ball !== 1

const crawlFile = (season: string) =>
  Bun.file(join(META_DIR, `crawl-${season}.json`))

export async function crawl(season: string, hops: number, target: number) {
  mkdirSync(META_DIR, { recursive: true })
  const file = crawlFile(season)
  const state = (await file.exists())
    ? await file.json()
    : { seen_users: [], seen_leagues: [], similar: {} }
  const seenUsers = new Set<string>(state.seen_users)
  const seenLeagues = new Set<string>(state.seen_leagues)
  const similar: Record<string, { name: string }> = state.similar

  let frontier: string[] = (
    await api<any[]>(`/league/${LEAGUE_ID}/users`)
  ).map((u) => u.user_id)

  for (let hop = 0; hop < hops; hop++) {
    const users = frontier.filter((u) => !seenUsers.has(u)).slice(0, 800)
    if (users.length === 0) break
    for (const u of users) seenUsers.add(u)
    console.error(`hop ${hop + 1}: fetching leagues of ${users.length} users…`)
    const leagueLists = await pmap(users, 4, (u) =>
      api<any[]>(`/user/${u}/leagues/nfl/${season}`),
    )
    const fresh: string[] = []
    for (const l of leagueLists.flat()) {
      if (!l || seenLeagues.has(l.league_id)) continue
      seenLeagues.add(l.league_id)
      fresh.push(l.league_id)
      if (isSimilar(l) && l.status === 'complete')
        similar[l.league_id] = { name: l.name }
    }
    console.error(
      `hop ${hop + 1}: +${fresh.length} new leagues, similar total ${Object.keys(similar).length}`,
    )
    await Bun.write(
      file,
      JSON.stringify({
        seen_users: [...seenUsers],
        seen_leagues: [...seenLeagues],
        similar,
      }),
    )
    if (Object.keys(similar).length >= target) break
    console.error(`hop ${hop + 1}: expanding user frontier…`)
    const userLists = await pmap(fresh.slice(0, 400), 4, (id) =>
      api<any[]>(`/league/${id}/users`),
    )
    frontier = [...new Set(userLists.flat().map((u: any) => u?.user_id))].filter(
      (u) => u && !seenUsers.has(u),
    ) as string[]
  }
  return {
    users_seen: seenUsers.size,
    leagues_seen: seenLeagues.size,
    similar_complete: Object.keys(similar).length,
  }
}

export async function study(season: string, sample: number) {
  const file = crawlFile(season)
  if (!(await file.exists())) throw new Error(`run "ff meta crawl" first`)
  const { similar } = await file.json()
  const ids = Object.keys(similar).slice(0, sample)

  const [league, stats] = await Promise.all([
    api(`/league/${LEAGUE_ID}`),
    seasonStats(season),
  ])
  const scoring = league.scoring_settings
  const ptsById: Record<string, number> = {}
  for (const [pid, st] of Object.entries(stats)) ptsById[pid] = scoreStats(st, scoring)

  console.error(`studying ${ids.length} leagues…`)
  const per = await pmap(ids, 4, async (id) => {
    const drafts = await api<any[]>(`/league/${id}/drafts`)
    const draft = drafts?.[0]
    if (!draft || draft.type !== 'snake' || draft.status !== 'complete')
      return { skipped: draft?.type ?? 'no-draft' }
    const [rosters, picks] = await Promise.all([
      api<any[]>(`/league/${id}/rosters`),
      api<any[]>(`/draft/${draft.draft_id}/picks`),
    ])
    const firstQB: Record<number, number> = {}
    const roundPts: { round: number; pts: number }[] = []
    for (const p of picks) {
      roundPts.push({ round: p.round, pts: ptsById[p.player_id] ?? 0 })
      if (p.metadata?.position === 'QB' && firstQB[p.roster_id] === undefined)
        firstQB[p.roster_id] = p.round
    }
    const teams = rosters.map((r) => {
      const s = r.settings ?? {}
      const games = (s.wins ?? 0) + (s.losses ?? 0) + (s.ties ?? 0)
      return {
        winpct: games ? (s.wins ?? 0) / games : 0,
        faab: s.waiver_budget_used ?? null,
        moves: s.total_moves ?? null,
        eff:
          s.ppts && s.fpts
            ? (s.fpts + (s.fpts_decimal ?? 0) / 100) /
              (s.ppts + (s.ppts_decimal ?? 0) / 100)
            : null,
        firstQB: firstQB[r.roster_id] ?? null,
      }
    })
    return { teams, roundPts }
  })

  const used = per.filter((x: any) => x?.teams) as any[]
  const skipped = per.length - used.length

  const roi: Record<number, { sum: number; n: number }> = {}
  const qbBuckets: Record<string, { sum: number; n: number }> = {}
  const faabW = { sum: 0, n: 0 }
  const faabL = { sum: 0, n: 0 }
  const effW = { sum: 0, n: 0 }
  const effL = { sum: 0, n: 0 }
  const qbBucket = (r: number | null) =>
    r === null ? 'none' : r <= 3 ? 'rd1-3' : r <= 6 ? 'rd4-6' : r <= 9 ? 'rd7-9' : 'rd10+'

  for (const lg of used) {
    for (const { round, pts } of lg.roundPts) {
      const a = (roi[round] ??= { sum: 0, n: 0 })
      a.sum += pts
      a.n++
    }
    for (const t of lg.teams) {
      const b = (qbBuckets[qbBucket(t.firstQB)] ??= { sum: 0, n: 0 })
      b.sum += t.winpct
      b.n++
      if (t.winpct >= 0.6) {
        if (t.faab !== null) (faabW.sum += t.faab), faabW.n++
        if (t.eff !== null) (effW.sum += t.eff), effW.n++
      } else if (t.winpct <= 0.4) {
        if (t.faab !== null) (faabL.sum += t.faab), faabL.n++
        if (t.eff !== null) (effL.sum += t.eff), effL.n++
      }
    }
  }
  const avg = (a: { sum: number; n: number }) =>
    a.n ? Math.round((a.sum / a.n) * 100) / 100 : null
  return {
    season,
    leagues_studied: used.length,
    skipped_non_snake: skipped,
    teams: used.reduce((n, l) => n + l.teams.length, 0),
    round_roi: Object.entries(roi)
      .map(([round, a]) => ({ round: Number(round), avg_pts: Math.round(a.sum / a.n) }))
      .sort((a, b) => a.round - b.round),
    first_qb_round_vs_winpct: Object.fromEntries(
      Object.entries(qbBuckets).map(([k, a]) => [k, avg(a)]),
    ),
    faab_used: { winners: avg(faabW), losers: avg(faabL) },
    lineup_efficiency: { winners: avg(effW), losers: avg(effL) },
  }
}
