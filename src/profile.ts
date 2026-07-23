// Opponent profiler: how each Baller actually drafts and manages, measured
// against corpus ADP (real drafts in our format) rather than vibes.
//
// reach = pick_no − corpus ADP (positive: takes players earlier than the
// market; negative: lets value fall to them). pts_over_exp = season points
// their picks produced minus corpus round-average — draft skill in points.
import { api, leagueUsers, LEAGUE_ID } from './sleeper'
import { loadAdp } from './meta'
import { scoreStats, seasonStats } from './value'

export async function profileLeague(season: string) {
  const cur = await api(`/league/${LEAGUE_ID}`)
  const leagueId = cur.previous_league_id
  if (!leagueId) throw new Error('no previous league to profile')
  const [users, rosters, drafts, adpData, stats] = await Promise.all([
    leagueUsers(leagueId),
    api<any[]>(`/league/${leagueId}/rosters`),
    api<any[]>(`/league/${leagueId}/drafts`),
    loadAdp(season),
    seasonStats(season),
  ])
  const picks: any[] = drafts[0]
    ? await api<any[]>(`/draft/${drafts[0].draft_id}/picks`)
    : []
  const ptsById: Record<string, number> = {}
  for (const [pid, st] of Object.entries(stats))
    ptsById[pid] = scoreStats(st, cur.scoring_settings)

  const ownerOf = Object.fromEntries(
    rosters.map((r) => [
      r.roster_id,
      users[r.owner_id]?.display_name ?? String(r.owner_id),
    ]),
  )
  const profiles: Record<string, any> = {}
  for (const r of rosters) {
    const s = r.settings ?? {}
    const games = (s.wins ?? 0) + (s.losses ?? 0) + (s.ties ?? 0)
    profiles[ownerOf[r.roster_id]] = {
      record: `${s.wins ?? 0}-${s.losses ?? 0}`,
      eff:
        s.ppts && s.fpts
          ? Math.round(
              ((s.fpts + (s.fpts_decimal ?? 0) / 100) /
                (s.ppts + (s.ppts_decimal ?? 0) / 100)) *
                100,
            ) / 100
          : null,
      winpct: games ? Math.round(((s.wins ?? 0) / games) * 100) / 100 : null,
      faab: s.waiver_budget_used ?? 0,
      moves: s.total_moves ?? 0,
      picks: [] as any[],
      reaches: [] as number[],
      pts_over_exp: 0,
      first: {} as Record<string, number>,
      team_counts: {} as Record<string, number>,
    }
  }

  for (const p of [...picks].sort((a, b) => a.pick_no - b.pick_no)) {
    const owner =
      users[p.picked_by]?.display_name ?? ownerOf[p.roster_id] ?? '?'
    const pr = profiles[owner]
    if (!pr) continue
    const pos = p.metadata?.position ?? '?'
    const team = p.metadata?.team ?? '?'
    const adp = adpData.adp[p.player_id]?.adp ?? null
    const reach = adp !== null ? Math.round((adp - p.pick_no) * 10) / 10 : null
    const pts = Math.round(ptsById[p.player_id] ?? 0)
    const exp = adpData.round_avg_pts[p.round] ?? 0
    pr.pts_over_exp += pts - exp
    if (reach !== null) pr.reaches.push(reach)
    pr.first[pos] ??= p.round
    if (team !== '?') pr.team_counts[team] = (pr.team_counts[team] ?? 0) + 1
    pr.picks.push({
      pick: p.pick_no,
      rd: p.round,
      player: `${p.metadata?.first_name ?? ''} ${p.metadata?.last_name ?? ''}`.trim(),
      pos,
      team,
      adp,
      reach,
      pts,
    })
  }

  const avg = (xs: number[]) =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null
  return Object.entries(profiles).map(([owner, pr]) => {
    const favTeams = Object.entries(pr.team_counts as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
      .filter(([, n]) => n >= 2)
      .slice(0, 2)
      .map(([t, n]) => `${t}×${n}`)
    return {
      owner,
      record: pr.record,
      winpct: pr.winpct,
      eff: pr.eff,
      faab: pr.faab,
      moves: pr.moves,
      avg_reach: avg(pr.reaches),
      pts_over_exp: Math.round(pr.pts_over_exp),
      qb_rd: pr.first.QB ?? null,
      te_rd: pr.first.TE ?? null,
      kdef_rd: Math.min(pr.first.K ?? 99, pr.first.DEF ?? 99),
      fav_teams: favTeams.join(','),
      picks: pr.picks,
    }
  })
}
