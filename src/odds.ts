// Vegas layer via the-odds-api.com (key in .env, free tier: 500 credits/mo,
// spreads+totals costs 2/call) — cached aggressively; --fresh to force.
//
// The market IS our prediction layer: consensus total + spread → implied
// team totals, the cheapest strong predictor of fantasy scoring environment.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const CACHE_DIR = join(import.meta.dir, '../.cache')
const TTL_MS = 6 * 60 * 60 * 1000

export const TEAM_ABBR: Record<string, string> = {
  'Arizona Cardinals': 'ARI', 'Atlanta Falcons': 'ATL', 'Baltimore Ravens': 'BAL',
  'Buffalo Bills': 'BUF', 'Carolina Panthers': 'CAR', 'Chicago Bears': 'CHI',
  'Cincinnati Bengals': 'CIN', 'Cleveland Browns': 'CLE', 'Dallas Cowboys': 'DAL',
  'Denver Broncos': 'DEN', 'Detroit Lions': 'DET', 'Green Bay Packers': 'GB',
  'Houston Texans': 'HOU', 'Indianapolis Colts': 'IND', 'Jacksonville Jaguars': 'JAX',
  'Kansas City Chiefs': 'KC', 'Las Vegas Raiders': 'LV', 'Los Angeles Chargers': 'LAC',
  'Los Angeles Rams': 'LAR', 'Miami Dolphins': 'MIA', 'Minnesota Vikings': 'MIN',
  'New England Patriots': 'NE', 'New Orleans Saints': 'NO', 'New York Giants': 'NYG',
  'New York Jets': 'NYJ', 'Philadelphia Eagles': 'PHI', 'Pittsburgh Steelers': 'PIT',
  'San Francisco 49ers': 'SF', 'Seattle Seahawks': 'SEA', 'Tampa Bay Buccaneers': 'TB',
  'Tennessee Titans': 'TEN', 'Washington Commanders': 'WAS',
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function fetchOdds(): Promise<{ games: any[]; quota_remaining: number }> {
  const key = process.env.ODDS_API_KEY
  if (!key) throw new Error('ODDS_API_KEY missing from .env')
  const res = await fetch(
    `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${key}&regions=us&markets=spreads,totals&oddsFormat=american`,
  )
  if (!res.ok) throw new Error(`odds-api ${res.status}: ${await res.text()}`)
  return {
    games: await res.json(),
    quota_remaining: Number(res.headers.get('x-requests-remaining') ?? -1),
  }
}

export async function oddsBoard(fresh = false) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = Bun.file(join(CACHE_DIR, 'odds.json'))
  let data: { games: any[]; quota_remaining: number }
  if (!fresh && (await file.exists()) && Date.now() - file.lastModified < TTL_MS)
    data = await file.json()
  else {
    data = await fetchOdds()
    await Bun.write(file, JSON.stringify(data))
  }
  const board = data.games
    .map((g) => {
      const home = TEAM_ABBR[g.home_team] ?? g.home_team
      const away = TEAM_ABBR[g.away_team] ?? g.away_team
      const spreads: number[] = []
      const totals: number[] = []
      for (const b of g.bookmakers ?? [])
        for (const m of b.markets ?? []) {
          if (m.key === 'spreads') {
            const o = m.outcomes?.find((o: any) => o.name === g.home_team)
            if (o?.point !== undefined) spreads.push(o.point)
          } else if (m.key === 'totals') {
            const o = m.outcomes?.find((o: any) => o.name === 'Over')
            if (o?.point !== undefined) totals.push(o.point)
          }
        }
      if (!spreads.length || !totals.length) return null
      const spread = median(spreads)
      const total = median(totals)
      return {
        kickoff: g.commence_time,
        game: `${away}@${home}`,
        spread_home: spread,
        total,
        implied: {
          [home]: Math.round((total / 2 - spread / 2) * 10) / 10,
          [away]: Math.round((total / 2 + spread / 2) * 10) / 10,
        },
        books: (g.bookmakers ?? []).length,
      }
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.kickoff.localeCompare(b.kickoff))
  return { quota_remaining: data.quota_remaining, games: board }
}
