#!/usr/bin/env bun
import { Cli, z } from 'incur'
import {
  api,
  leagueUsers,
  LEAGUE_ID,
  playerName,
  players,
  USER_ID,
  USERNAME,
} from './sleeper'
import { valueBoard } from './value'
import { crawl, study } from './meta'
import { oddsBoard } from './odds'

const FANTASY_POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']

const cli = Cli.create('ff', {
  description:
    'Fantasy football ops for The Ballers league (Sleeper, read-only)',
  version: '0.1.0',
})

cli.command('state', {
  description: 'NFL season state (season, week, phase)',
  async run() {
    const s = await api('/state/nfl')
    return {
      season: s.season,
      phase: s.season_type,
      week: s.week,
      display_week: s.display_week,
    }
  },
})

cli.command('league', {
  description: 'League rules decoded: scoring, roster, waivers, playoffs',
  options: z.object({
    league: z.string().optional().describe('League ID (default: Ballers 2026)'),
    scoring: z.boolean().optional().describe('Dump every nonzero scoring rule'),
  }),
  async run({ options }) {
    const l = await api(`/league/${options.league ?? LEAGUE_ID}`)
    const sc = l.scoring_settings ?? {}
    const s = l.settings ?? {}
    const round = (v: number) => Math.round(v * 100) / 100
    if (options.scoring)
      return Object.fromEntries(
        Object.entries(sc)
          .filter(([, v]) => v !== 0)
          .map(([k, v]) => [k, round(v as number)]),
      )
    const waiverType =
      { 0: 'rolling', 1: 'reversed', 2: 'FAAB' }[s.waiver_type as number] ??
      String(s.waiver_type)
    return {
      name: l.name,
      season: l.season,
      status: l.status,
      teams: s.num_teams,
      roster: (l.roster_positions ?? []).join(','),
      scoring: {
        rec: round(sc.rec ?? 0),
        pass_yd: round(sc.pass_yd ?? 0),
        pass_td: round(sc.pass_td ?? 0),
        pass_int: round(sc.pass_int ?? 0),
        rush_yd: round(sc.rush_yd ?? 0),
        rec_yd: round(sc.rec_yd ?? 0),
        rush_rec_td: round(sc.rush_td ?? 0),
        fum_lost: round(sc.fum_lost ?? 0),
      },
      waivers: {
        type: waiverType,
        budget: s.waiver_budget,
        clear_day: s.waiver_day_of_week,
      },
      playoffs: { teams: s.playoff_teams, start_week: s.playoff_week_start },
      trade_deadline_week: s.trade_deadline,
      median_match: s.league_average_match === 1,
      previous_league_id: l.previous_league_id,
      draft_id: l.draft_id,
    }
  },
})

cli.command('members', {
  description: 'Owners, team names, records',
  options: z.object({
    league: z.string().optional().describe('League ID (default: Ballers 2026)'),
  }),
  async run({ options }) {
    const id = options.league ?? LEAGUE_ID
    const [users, rosters] = await Promise.all([
      leagueUsers(id),
      api<any[]>(`/league/${id}/rosters`),
    ])
    return rosters
      .map((r) => {
        const u = users[r.owner_id]
        const s = r.settings ?? {}
        return {
          roster: r.roster_id,
          owner: u?.display_name ?? r.owner_id,
          team: u?.metadata?.team_name ?? '',
          w: s.wins ?? 0,
          l: s.losses ?? 0,
          pf: s.fpts ?? 0,
        }
      })
      .sort((a, b) => b.w - a.w || b.pf - a.pf)
  },
})

cli.command('roster', {
  description: "A team's current roster (default: ours)",
  args: z.object({
    owner: z.string().optional().describe(`Owner display name (default ${USERNAME})`),
  }),
  async run({ args }) {
    const owner = (args.owner ?? USERNAME).toLowerCase()
    const [users, rosters, db] = await Promise.all([
      leagueUsers(LEAGUE_ID),
      api<any[]>(`/league/${LEAGUE_ID}/rosters`),
      players(),
    ])
    const user = Object.values(users).find(
      (u: any) => u.display_name.toLowerCase() === owner,
    ) as any
    const r = rosters.find((x) => x.owner_id === user?.user_id)
    if (!r) {
      const open = rosters.filter((x) => !x.owner_id).map((x) => x.roster_id)
      return {
        owner: args.owner ?? USERNAME,
        roster: 'none assigned',
        open_roster_slots: open,
        note: 'user is in the league but not attached to a roster yet',
      }
    }
    const ids: string[] = r.players ?? []
    if (ids.length === 0) return { owner: user.display_name, roster: 'empty (pre-draft)' }
    const starters = new Set(r.starters ?? [])
    return ids
      .map((id) => {
        const p = db[id]
        return {
          player: playerName(p),
          pos: p?.position,
          team: p?.team ?? 'FA',
          slot: starters.has(id) ? 'start' : 'bench',
          inj: p?.injury_status ?? '',
        }
      })
      .sort((a, b) => (a.slot === b.slot ? 0 : a.slot === 'start' ? -1 : 1))
  },
})

cli.command('draft', {
  description: 'Draft status: schedule, order, our slot',
  async run() {
    const l = await api(`/league/${LEAGUE_ID}`)
    const d = await api(`/draft/${l.draft_id}`)
    return {
      status: d.status,
      type: d.type,
      rounds: d.settings?.rounds,
      pick_timer_s: d.settings?.pick_timer,
      scheduled: d.start_time ? new Date(d.start_time).toISOString() : null,
      order_set: !!d.draft_order,
      our_slot: d.draft_order?.[USER_ID] ?? null,
    }
  },
})

cli.command('picks', {
  description: 'Draft picks so far (poll during live draft)',
  options: z.object({
    draft: z.string().optional().describe('Draft ID (default: current league draft)'),
  }),
  async run({ options }) {
    const draftId =
      options.draft ?? (await api(`/league/${LEAGUE_ID}`)).draft_id
    const [picks, users] = await Promise.all([
      api<any[]>(`/draft/${draftId}/picks`),
      leagueUsers(LEAGUE_ID),
    ])
    if (picks.length === 0) return { picks: 0, note: 'draft has not started' }
    return picks
      .sort((a, b) => a.pick_no - b.pick_no)
      .map((p) => ({
        pick: p.pick_no,
        rd: p.round,
        by: users[p.picked_by]?.display_name ?? p.picked_by,
        player: `${p.metadata?.first_name ?? ''} ${p.metadata?.last_name ?? ''}`.trim(),
        pos: p.metadata?.position,
        team: p.metadata?.team,
      }))
  },
})

cli.command('trending', {
  description: 'Trending adds/drops across all of Sleeper (crowd signal)',
  args: z.object({
    kind: z.enum(['add', 'drop']).optional().describe('add (default) or drop'),
  }),
  options: z.object({
    hours: z.coerce.number().optional().describe('Lookback hours (default 24)'),
    limit: z.coerce.number().optional().describe('Max results (default 25)'),
  }),
  async run({ args, options }) {
    const [list, db] = await Promise.all([
      api<any[]>(
        `/players/nfl/trending/${args.kind ?? 'add'}?lookback_hours=${options.hours ?? 24}&limit=${options.limit ?? 25}`,
      ),
      players(),
    ])
    return list.map((t) => {
      const p = db[t.player_id]
      return {
        player: playerName(p),
        pos: p?.position,
        team: p?.team ?? 'FA',
        count: t.count,
      }
    })
  },
})

cli.command('player', {
  description: 'Search the NFL player database (cached daily)',
  args: z.object({ query: z.string().describe('Name substring') }),
  async run({ args }) {
    const db = await players()
    const q = args.query.toLowerCase()
    return Object.values(db)
      .filter(
        (p) =>
          playerName(p).toLowerCase().includes(q) &&
          p.fantasy_positions?.some((x) => FANTASY_POS.includes(x)),
      )
      .sort((a, b) => (a.search_rank ?? 1e9) - (b.search_rank ?? 1e9))
      .slice(0, 15)
      .map((p) => ({
        id: p.player_id,
        player: playerName(p),
        pos: p.position,
        team: p.team ?? 'FA',
        age: p.age,
        status: p.status,
        inj: p.injury_status ?? '',
      }))
  },
})

cli.command('matchups', {
  description: 'Weekly head-to-head matchups with scores',
  args: z.object({
    week: z.coerce.number().optional().describe('NFL week (default: current)'),
  }),
  async run({ args }) {
    const state = await api('/state/nfl')
    const week = args.week ?? state.week
    if (!week || week < 1)
      return { note: `offseason (${state.season_type}) — pass a week explicitly` }
    const [ms, users, rosters] = await Promise.all([
      api<any[]>(`/league/${LEAGUE_ID}/matchups/${week}`),
      leagueUsers(LEAGUE_ID),
      api<any[]>(`/league/${LEAGUE_ID}/rosters`),
    ])
    const ownerOf = Object.fromEntries(
      rosters.map((r) => [r.roster_id, users[r.owner_id]?.display_name ?? '?']),
    )
    const games: Record<string, any[]> = {}
    for (const m of ms) (games[m.matchup_id] ??= []).push(m)
    return Object.values(games).map((pair) =>
      pair
        .map((m) => `${ownerOf[m.roster_id]} ${m.points ?? 0}`)
        .join(' vs '),
    )
  },
})

cli.command('scout', {
  description:
    'Mine a past season: records, draft tendencies (positions by round), FAAB habits',
  options: z.object({
    league: z
      .string()
      .optional()
      .describe('League ID to mine (default: previous season of current league)'),
  }),
  async run({ options }) {
    const id =
      options.league ??
      (await api(`/league/${LEAGUE_ID}`)).previous_league_id
    if (!id) throw new Error('no previous league to scout')
    const [lg, users, rosters, drafts] = await Promise.all([
      api(`/league/${id}`),
      leagueUsers(id),
      api<any[]>(`/league/${id}/rosters`),
      api<any[]>(`/league/${id}/drafts`),
    ])
    const picks: any[] = drafts[0]
      ? await api(`/draft/${drafts[0].draft_id}/picks`)
      : []
    const weeks = await Promise.all(
      Array.from({ length: 18 }, (_, i) =>
        api<any[]>(`/league/${id}/transactions/${i + 1}`).catch(() => []),
      ),
    )
    const ownerOf = Object.fromEntries(
      rosters.map((r) => [
        r.roster_id,
        users[r.owner_id]?.display_name ?? String(r.owner_id),
      ]),
    )
    const profiles: Record<string, any> = {}
    for (const r of rosters) {
      const s = r.settings ?? {}
      profiles[ownerOf[r.roster_id]] = {
        record: `${s.wins ?? 0}-${s.losses ?? 0}`,
        pf: s.fpts ?? 0,
        draft: [] as string[],
        faab: 0,
        claims: 0,
        fa_adds: 0,
        trades: 0,
      }
    }
    for (const p of picks.sort((a, b) => a.pick_no - b.pick_no)) {
      const name =
        users[p.picked_by]?.display_name ?? ownerOf[p.roster_id] ?? '?'
      profiles[name]?.draft.push(p.metadata?.position ?? '?')
    }
    for (const t of weeks.flat()) {
      if (t.status !== 'complete') continue
      if (t.type === 'trade') {
        for (const rid of t.roster_ids ?? [])
          if (profiles[ownerOf[rid]]) profiles[ownerOf[rid]].trades++
        continue
      }
      const pr = profiles[ownerOf[t.roster_ids?.[0]]]
      if (!pr) continue
      if (t.type === 'waiver') {
        pr.claims++
        pr.faab += t.settings?.waiver_bid ?? 0
      } else if (t.type === 'free_agent' && t.adds) pr.fa_adds++
    }
    return {
      league: lg.name,
      season: lg.season,
      owners: Object.entries(profiles)
        .map(([owner, p]) => ({
          owner,
          record: p.record,
          pf: p.pf,
          draft: p.draft.join(','),
          faab: p.faab,
          claims: p.claims,
          fa_adds: p.fa_adds,
          trades: p.trades,
        }))
        .sort((a, b) => b.pf - a.pf),
    }
  },
})

cli.command('study', {
  description:
    'How a past season was won: position splits, draft ROI by round, waiver gold',
  options: z.object({
    league: z
      .string()
      .optional()
      .describe('League ID to study (default: previous season of current league)'),
  }),
  async run({ options }) {
    const cur = await api(`/league/${LEAGUE_ID}`)
    const id = options.league ?? cur.previous_league_id
    if (!id) throw new Error('no previous league to study')
    const [lg, users, rosters, drafts, db] = await Promise.all([
      api(`/league/${id}`),
      leagueUsers(id),
      api<any[]>(`/league/${id}/rosters`),
      api<any[]>(`/league/${id}/drafts`),
      players(),
    ])
    const picks: any[] = drafts[0]
      ? await api(`/draft/${drafts[0].draft_id}/picks`)
      : []
    const weeks = await Promise.all(
      Array.from({ length: 17 }, (_, i) =>
        api<any[]>(`/league/${id}/matchups/${i + 1}`).catch(() => []),
      ),
    )
    // points every rostered player actually scored for each team, all season
    const teamPts: Record<number, Record<string, number>> = {}
    for (const m of weeks.flat()) {
      const t = (teamPts[m.roster_id] ??= {})
      for (const [pid, pts] of Object.entries(m.players_points ?? {}))
        t[pid] = (t[pid] ?? 0) + (pts as number)
    }
    const draftedBy: Record<string, { round: number; roster_id: number }> = {}
    for (const p of picks)
      draftedBy[p.player_id] = { round: p.round, roster_id: p.roster_id }

    const ownerOf = Object.fromEntries(
      rosters.map((r) => [
        r.roster_id,
        users[r.owner_id]?.display_name ?? String(r.owner_id),
      ]),
    )
    const teams = rosters
      .map((r) => {
        const pts = teamPts[r.roster_id] ?? {}
        let total = 0
        let fromDraft = 0
        const byPos: Record<string, number> = {}
        for (const [pid, v] of Object.entries(pts)) {
          total += v
          if (draftedBy[pid]?.roster_id === r.roster_id) fromDraft += v
          const pos = db[pid]?.position ?? '?'
          byPos[pos] = (byPos[pos] ?? 0) + v
        }
        const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0)
        const s = r.settings ?? {}
        return {
          owner: ownerOf[r.roster_id],
          record: `${s.wins ?? 0}-${s.losses ?? 0}`,
          pts: Math.round(total),
          own_draft_pct: pct(fromDraft),
          qb: pct(byPos.QB ?? 0),
          rb: pct(byPos.RB ?? 0),
          wr: pct(byPos.WR ?? 0),
          te: pct(byPos.TE ?? 0),
          k_def: pct((byPos.K ?? 0) + (byPos.DEF ?? 0)),
        }
      })
      .sort((a, b) => b.pts - a.pts)

    // ROI: points each pick produced for the team that drafted it
    const roundAcc: Record<number, { sum: number; n: number; best: string; bestPts: number }> = {}
    for (const p of picks) {
      const got = Math.round(teamPts[p.roster_id]?.[p.player_id] ?? 0)
      const acc = (roundAcc[p.round] ??= { sum: 0, n: 0, best: '', bestPts: -1 })
      acc.sum += got
      acc.n++
      if (got > acc.bestPts) {
        acc.bestPts = got
        acc.best = `${p.metadata?.first_name} ${p.metadata?.last_name} (${got})`
      }
    }
    const round_roi = Object.entries(roundAcc).map(([round, a]) => ({
      round: Number(round),
      avg_pts: Math.round(a.sum / a.n),
      best: a.best,
    }))

    // waiver gold: points scored by players nobody drafted
    const undrafted: Record<string, number> = {}
    for (const t of Object.values(teamPts))
      for (const [pid, v] of Object.entries(t))
        if (!draftedBy[pid]) undrafted[pid] = (undrafted[pid] ?? 0) + v
    const waiver_gold = Object.entries(undrafted)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([pid, v]) => ({
        player: playerName(db[pid]),
        pos: db[pid]?.position,
        pts: Math.round(v),
      }))

    return {
      league: lg.name,
      season: lg.season,
      scoring_same_as_current:
        JSON.stringify(lg.scoring_settings) ===
        JSON.stringify(cur.scoring_settings),
      teams,
      round_roi,
      waiver_gold,
    }
  },
})

cli.command('value', {
  description:
    'Positional baselines + VORP under OUR scoring, from re-scored real seasons',
  args: z.object({
    season: z.string().optional().describe('Season to score (default 2025)'),
  }),
  options: z.object({
    top: z.coerce.number().optional().describe('How many VORP rows (default 30)'),
  }),
  async run({ args, options }) {
    const { baselines, vorp } = await valueBoard(args.season ?? '2025')
    return {
      season: args.season ?? '2025',
      baselines,
      top_vorp: vorp.slice(0, options.top ?? 30),
    }
  },
})

cli.command('odds', {
  description:
    'Vegas consensus: spreads, totals, implied team totals (the-odds-api, cached 6h)',
  options: z.object({
    fresh: z.boolean().optional().describe('Bypass cache (costs 2 API credits)'),
    team: z.string().optional().describe('Filter to games involving a team abbr'),
    max: z.coerce.number().optional().describe('Max games (default 20)'),
  }),
  async run({ options }) {
    const { quota_remaining, games } = await oddsBoard(options.fresh ?? false)
    let out = games as any[]
    if (options.team) {
      const t = options.team.toUpperCase()
      out = out.filter((g) => g.game.includes(t))
    }
    return { quota_remaining, games: out.slice(0, options.max ?? 20) }
  },
})

cli.command('meta', {
  description:
    'The greater corpus: crawl similar Sleeper leagues, then study how they were won',
  args: z.object({
    action: z.enum(['crawl', 'study']).describe('crawl: harvest league IDs; study: aggregate'),
  }),
  options: z.object({
    season: z.string().optional().describe('Season (default 2025)'),
    hops: z.coerce.number().optional().describe('crawl: snowball hops (default 3)'),
    target: z.coerce.number().optional().describe('crawl: stop at N similar leagues (default 300)'),
    sample: z.coerce.number().optional().describe('study: max leagues to study (default 200)'),
  }),
  async run({ args, options }) {
    const season = options.season ?? '2025'
    if (args.action === 'crawl')
      return crawl(season, options.hops ?? 3, options.target ?? 300)
    return study(season, options.sample ?? 200)
  },
})

cli.serve()
