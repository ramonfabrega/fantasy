// Post-draft analysis: score every roster under our league rules.
import { buildBoard, lineupPts, benchRepl, STARTERS, FLEX, type ProjRow } from '../../src/proj'
import { api, LEAGUE_ID, leagueUsers } from '../../src/sleeper'

const SEASON = '2026'
const league = await api(`/league/${LEAGUE_ID}`)
const [draft, users, board, picks] = await Promise.all([
  api(`/draft/${league.draft_id}`),
  leagueUsers(LEAGUE_ID),
  buildBoard(SEASON),
  api<any[]>(`/draft/${league.draft_id}/picks`),
])
const byId = new Map(board.map((r) => [r.id, r]))
const byRank = new Map(board.map((r) => [r.ovr_rank, r]))
const teams: number = draft.settings.teams
const rounds: number = draft.settings.rounds
const slotOwner: Record<number, any> = {}
for (const [uid, s] of Object.entries(draft.draft_order)) slotOwner[s as number] = users[uid] ?? { display_name: uid }

// expected value at a pick = val of the board's Nth ranked player (what a "par" pick returns)
const parVal = (n: number) => byRank.get(n)?.val ?? 0

type Pick = { pick: number; round: number; player: string; pos: string; team: string; pts: number; val: number; vorp: number; adp: number | null; tier: number; inj: string; exp: number; par: number; steal: number; adpEdge: number | null; id: string }
const teamsOut: any[] = []
for (let slot = 1; slot <= teams; slot++) {
  const u = slotOwner[slot]
  const ps = picks.filter((p) => p.draft_slot === slot).sort((a, b) => a.pick_no - b.pick_no)
  const rows: ProjRow[] = []
  const pk: Pick[] = []
  for (const p of ps) {
    const r = byId.get(p.player_id)
    const m = p.metadata
    const name = r?.player ?? `${m.first_name} ${m.last_name}`.trim()
    const row: ProjRow = r ?? ({ id: p.player_id, player: name, pos: m.position, team: m.team, pts: 0, val: 0, vorp: 0, adp: null, tier: 9, inj: '', exp: 0, ovr_rank: 999 } as any)
    rows.push(row)
    pk.push({
      id: p.player_id, pick: p.pick_no, round: p.round, player: name, pos: row.pos, team: row.team, pts: Math.round(row.pts), val: row.val, vorp: row.vorp,
      adp: row.adp, tier: row.tier, inj: row.inj, exp: row.exp, par: parVal(p.pick_no), steal: row.val - parVal(p.pick_no),
      adpEdge: row.adp == null ? null : Math.round(row.adp - p.pick_no),
    })
  }
  // starting lineup
  const used = new Set<string>()
  const lineup: { slot: string; row: ProjRow | null }[] = []
  const by = (pos: string) => rows.filter((r) => r.pos === pos && !used.has(r.id)).sort((a, b) => b.pts - a.pts)
  for (const [pos, n] of Object.entries(STARTERS)) for (let i = 0; i < n; i++) { const r = by(pos)[0] ?? null; if (r) used.add(r.id); lineup.push({ slot: pos, row: r }) }
  const flex = rows.filter((r) => FLEX.includes(r.pos) && !used.has(r.id)).sort((a, b) => b.pts - a.pts)[0] ?? null
  if (flex) used.add(flex.id)
  lineup.push({ slot: 'FLEX', row: flex })
  const bench = rows.filter((r) => !used.has(r.id))
  const lp = lineupPts(rows)
  const skill = lineup.filter((l) => !['K', 'DEF'].includes(l.slot)).reduce((a, l) => a + (l.row?.pts ?? benchRepl[l.slot] ?? 0), 0)
  const benchVal = bench.reduce((a, r) => a + Math.max(0, r.val), 0)
  const posPts: Record<string, number> = {}
  for (const l of lineup) posPts[l.slot === 'FLEX' ? 'FLEX' : l.slot] = (posPts[l.slot] ?? 0) + (l.row?.pts ?? 0)
  const starters = lineup.map((l) => l.row).filter(Boolean) as ProjRow[]
  const flagged = starters.filter((r) => r.inj && !['K', 'DEF'].includes(r.pos)).map((r) => `${r.player} (${r.inj})`)
  const rookies = starters.filter((r) => r.exp === 0).map((r) => r.player)
  const best = [...pk].sort((a, b) => b.steal - a.steal)[0]
  const worst = [...pk].sort((a, b) => a.steal - b.steal)[0]
  const marketSteal = [...pk].filter((p) => p.adpEdge != null).sort((a, b) => b.adpEdge! - a.adpEdge!)[0]
  const marketReach = [...pk].filter((p) => p.adpEdge != null).sort((a, b) => a.adpEdge! - b.adpEdge!)[0]
  teamsOut.push({
    slot, owner: u.display_name, teamName: u.metadata?.team_name ?? u.display_name, avatar: u.avatar ?? null,
    lineupPts: Math.round(lp), skillPts: Math.round(skill), benchVal: Math.round(benchVal), totalVal: pk.reduce((a, p) => a + p.val, 0),
    valOverPar: pk.reduce((a, p) => a + p.steal, 0),
    lineup: lineup.map((l) => ({ slot: l.slot, player: l.row?.player ?? '—', pos: l.row?.pos ?? l.slot, team: l.row?.team ?? '', pts: Math.round(l.row?.pts ?? 0), inj: l.row?.inj ?? '', tier: l.row?.tier ?? 0, pos_rank: l.row?.pos_rank ?? 0 })),
    bench: bench.map((r) => ({ player: r.player, pos: r.pos, team: r.team, pts: Math.round(r.pts), val: r.val })),
    posPts, flagged, rookies, best, worst, marketSteal, marketReach, picks: pk,
  })
}
teamsOut.sort((a, b) => b.lineupPts - a.lineupPts)
teamsOut.forEach((t, i) => (t.rank = i + 1))
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return (s[5]! + s[6]!) / 2 }
const posMedian: Record<string, number> = {}
for (const k of ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF']) posMedian[k] = med(teamsOut.map((t) => t.posPts[k] ?? 0))
const all = teamsOut.flatMap((t) => t.picks.map((p: Pick) => ({ ...p, owner: t.owner })))
const out = {
  generated: new Date().toISOString(), teams, rounds, benchRepl, posMedian,
  leagueSteals: [...all].sort((a, b) => b.steal - a.steal).slice(0, 8),
  leagueReaches: [...all].sort((a, b) => a.steal - b.steal).slice(0, 8),
  marketSteals: [...all].filter((p) => p.adpEdge != null).sort((a, b) => b.adpEdge - a.adpEdge).slice(0, 8),
  marketReaches: [...all].filter((p) => p.adpEdge != null).sort((a, b) => a.adpEdge - b.adpEdge).slice(0, 8),
  runs: { QB: all.filter((p) => p.pos === 'QB').map((p) => p.pick).sort((a, b) => a - b), TE: all.filter((p) => p.pos === 'TE').map((p) => p.pick).sort((a, b) => a - b), DEF: all.filter((p) => p.pos === 'DEF').map((p) => p.pick).sort((a, b) => a - b), K: all.filter((p) => p.pos === 'K').map((p) => p.pick).sort((a, b) => a - b) },
  teams: teamsOut,
}
await Bun.write('scripts/report/out/postdraft.json', JSON.stringify(out, null, 1))
for (const t of teamsOut) console.log(`${String(t.rank).padStart(2)} ${t.owner.padEnd(16)} ${t.teamName.padEnd(20)} lineup ${t.lineupPts} skill ${t.skillPts} bench ${t.benchVal} valOverPar ${t.valOverPar}  best: ${t.best.player} (${t.best.steal > 0 ? '+' : ''}${t.best.steal})  worst: ${t.worst.player} (${t.worst.steal})  flags: ${t.flagged.join(', ')}`)
console.log('posMedian', posMedian)
