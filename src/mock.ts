// Mock-draft simulator: play the rest of the draft many times with opponents
// picking off Sleeper ADP (noisy, with the league's K/DEF-late habit and
// position caps), us picking off the recommender. Yields, for each of our
// remaining picks, who tends to be there and who we tend to take — the pick
// plan with contingencies, grounded in the same board `ff live` uses.
import { api, LEAGUE_ID, USER_ID } from './sleeper'
import {
  buildBoard,
  countPos,
  flag,
  picksForSlot,
  recommend,
  slotForPick,
  type ProjRow,
} from './proj'

const OPP_CAP: Record<string, number> = { QB: 2, TE: 2, K: 1, DEF: 1, RB: 7, WR: 7 }

function pickForOpponent(
  avail: ProjRow[],
  owned: Record<string, number>,
  round: number,
  rounds: number,
  rng: () => number,
): ProjRow {
  const lateKD = round >= rounds - 1
  const pool = avail.filter((r) => {
    if ((owned[r.pos] ?? 0) >= (OPP_CAP[r.pos] ?? 9)) return false
    if (r.pos === 'K' || r.pos === 'DEF') return round >= 11 && (round >= 13 || rng() < 0.3)
    return true
  })
  // must fill K/DEF in the last two rounds
  if (lateKD) {
    for (const pos of ['K', 'DEF'])
      if (!(owned[pos] ?? 0)) {
        const c = pool.find((r) => r.pos === pos)
        if (c && rng() < 0.85) return c
      }
  }
  // draw from the top of ADP with geometric weight (ρ≈2.2 picks); undrafted ADP last
  const sorted = pool
    .slice()
    .sort((a, b) => (a.adp ?? 400 + a.ovr_rank) - (b.adp ?? 400 + b.ovr_rank))
  let i = 0
  while (rng() > 0.36 && i < Math.min(8, sorted.length - 1)) i++
  return sorted[i] ?? avail[0]!
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export async function mockDraft(season: string, sims: number, fresh = false) {
  const league = await api(`/league/${LEAGUE_ID}`)
  const [draft, picks, board] = await Promise.all([
    api(`/draft/${league.draft_id}`),
    api<any[]>(`/draft/${league.draft_id}/picks`),
    buildBoard(season, fresh),
  ])
  const teams: number = draft.settings?.teams ?? 12
  const rounds: number = draft.settings?.rounds ?? 15
  const slot: number = draft.draft_order?.[USER_ID] ?? 2
  const takenIds = new Set(picks.map((p: any) => p.player_id))
  const start = picks.length + 1
  const ourPicks = picksForSlot(slot, teams, rounds).filter((n) => n >= start)

  // per our pick: choice frequency + availability counts of the top board
  const chosen: Record<number, Record<string, number>> = {}
  const avail: Record<number, Record<string, number>> = {}
  const rosterPts: number[] = []

  for (let s = 0; s < sims; s++) {
    const rng = mulberry32(1000 + s)
    const available = board.filter((r) => !takenIds.has(r.id))
    const gone = new Set<string>()
    const owned: Record<number, Record<string, number>> = {}
    for (const p of picks) {
      const o = (owned[p.draft_slot] ??= {})
      o[p.metadata?.position] = (o[p.metadata?.position] ?? 0) + 1
    }
    const oursRows: ProjRow[] = []
    for (const p of picks)
      if (p.draft_slot === slot) {
        const r = board.find((x) => x.id === p.player_id)
        if (r) oursRows.push(r)
      }
    for (let n = start; n <= teams * rounds; n++) {
      const sl = slotForPick(n, teams)
      const round = Math.ceil(n / teams)
      const live = available.filter((r) => !gone.has(r.id))
      const o = (owned[sl] ??= {})
      let choice: ProjRow
      if (sl === slot) {
        const next = ourPicks.find((x) => x > n) ?? null
        const recs = recommend(live, countPos(oursRows), n, next, teams, rounds)
        choice = recs[0]!
        oursRows.push(choice)
        const ch = (chosen[n] ??= {})
        ch[choice.id] = (ch[choice.id] ?? 0) + 1
        const av = (avail[n] ??= {})
        for (const r of recs.slice(0, 40)) av[r.id] = (av[r.id] ?? 0) + 1
      } else {
        choice = pickForOpponent(live, o, round, rounds, rng)
      }
      gone.add(choice.id)
      o[choice.pos] = (o[choice.pos] ?? 0) + 1
    }
    rosterPts.push(startersPts(oursRows))
  }

  const byId = new Map(board.map((r) => [r.id, r]))
  const pct = (n: number) => Math.round((n / sims) * 100)
  const plan = ourPicks.map((n) => {
    const ch = Object.entries(chosen[n] ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, c]) => `${byId.get(id)!.player} ${pct(c)}%`)
    const av = Object.entries(avail[n] ?? {})
      .map(([id, c]) => ({ r: byId.get(id)!, p: pct(c) }))
      .filter((x) => x.p >= 20)
      .sort((a, b) => b.r.val - a.r.val)
      .slice(0, 12)
      .map((x) => ({
        player: x.r.player,
        pos: `${x.r.pos}${x.r.pos_rank}`,
        t: x.r.tier,
        vorp: x.r.vorp,
        val: x.r.val,
        adp: x.r.adp,
        avail: x.p,
        flag: flag(x.r),
      }))
    return { pick: n, rd: Math.ceil(n / teams), we_take: ch, likely_available: av }
  })
  rosterPts.sort((a, b) => a - b)
  return {
    sims,
    from_pick: start,
    our_slot: slot,
    starters_pts_p10_p50_p90: [
      Math.round(rosterPts[Math.floor(sims * 0.1)]!),
      Math.round(rosterPts[Math.floor(sims * 0.5)]!),
      Math.round(rosterPts[Math.floor(sims * 0.9)]!),
    ],
    plan,
  }
}

/** Projected points of the best legal starting lineup from a set of players. */
export function startersPts(rows: ProjRow[]): number {
  const by = (pos: string) => rows.filter((r) => r.pos === pos).sort((a, b) => b.pts - a.pts)
  const take = (list: ProjRow[], n: number) => list.slice(0, n)
  const qb = take(by('QB'), 1)
  const rb = take(by('RB'), 2)
  const wr = take(by('WR'), 2)
  const te = take(by('TE'), 1)
  const k = take(by('K'), 1)
  const def = take(by('DEF'), 1)
  const used = new Set([...qb, ...rb, ...wr, ...te].map((r) => r.id))
  const flex = rows
    .filter((r) => ['RB', 'WR', 'TE'].includes(r.pos) && !used.has(r.id))
    .sort((a, b) => b.pts - a.pts)[0]
  return [...qb, ...rb, ...wr, ...te, ...k, ...def, ...(flex ? [flex] : [])].reduce(
    (s, r) => s + r.pts,
    0,
  )
}
