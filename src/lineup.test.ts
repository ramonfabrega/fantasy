// The seatbelt only matters on the one Sunday a starter is ruled out 80
// minutes before kickoff, which is exactly the moment nobody is going to be
// reading the code. So the decision half is pure and tested here: given a
// lineup and a bench, does it (a) notice, (b) pick a legal replacement, and
// (c) stay quiet when there is nothing to be done.
import { expect, test, describe } from 'bun:test'
import { buildAlerts, matchOdds, optimize, type Spot } from './lineup'

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF']

let n = 0
function p(over: Partial<Spot> & { pos: string; proj: number }): Spot {
  return {
    id: `p${++n}`,
    name: over.name ?? `${over.pos}${n}`,
    team: 'AAA',
    game: '@BBB',
    kickoff: null,
    gameStatus: 'pre_game',
    locked: false,
    inj: '',
    newsAgeH: 1,
    actual: null,
    implied: null,
    ...over,
  } as Spot
}

/** A legal, healthy, fully changeable lineup plus a weak bench. */
function lineup() {
  const starters = [
    p({ pos: 'QB', proj: 20, name: 'QB-start' }),
    p({ pos: 'RB', proj: 17, name: 'RB-start1' }),
    p({ pos: 'RB', proj: 14, name: 'RB-start2' }),
    p({ pos: 'WR', proj: 13, name: 'WR-start1' }),
    p({ pos: 'WR', proj: 12, name: 'WR-start2' }),
    p({ pos: 'TE', proj: 9, name: 'TE-start' }),
    p({ pos: 'WR', proj: 11, name: 'FLEX-start' }),
    p({ pos: 'K', proj: 7, name: 'K-start' }),
    p({ pos: 'DEF', proj: 8, name: 'DEF-start' }),
  ]
  const bench = [
    p({ pos: 'RB', proj: 10, name: 'RB-bench' }),
    p({ pos: 'WR', proj: 6, name: 'WR-bench' }),
    p({ pos: 'QB', proj: 15, name: 'QB-bench' }),
    p({ pos: 'TE', proj: 4, name: 'TE-bench' }),
  ]
  return { starters, bench }
}

const run = (starters: (Spot | null)[], bench: Spot[]) =>
  buildAlerts(SLOTS, starters, optimize(SLOTS, starters, bench))

describe('seatbelt', () => {
  test('a healthy optimal lineup produces no alerts', () => {
    const { starters, bench } = lineup()
    expect(run(starters, bench)).toEqual([])
  })

  test('an Out starter is ACT, and is replaced from the bench at his own slot', () => {
    const { starters, bench } = lineup()
    starters[1] = { ...starters[1]!, inj: 'Out' }
    const alerts = run(starters, bench)
    const act = alerts.filter((a) => a.level === 'ACT')
    expect(act).toHaveLength(1)
    expect(act[0]).toMatchObject({ kind: 'OUT', slot: 'RB', out: 'RB-start1' })
    expect(act[0].in).toBe('RB-bench')
  })

  test('an Out starter whose game already kicked raises nothing — it is not a decision', () => {
    const { starters, bench } = lineup()
    starters[1] = { ...starters[1]!, inj: 'Out', locked: true, gameStatus: 'in_game' }
    expect(run(starters, bench)).toEqual([])
  })

  test('a starter with no game at all is ACT even when perfectly healthy', () => {
    const { starters, bench } = lineup()
    starters[3] = { ...starters[3]!, game: '—', gameStatus: 'none' }
    const act = run(starters, bench).filter((a) => a.level === 'ACT')
    expect(act).toHaveLength(1)
    expect(act[0]).toMatchObject({ kind: 'NO_GAME', slot: 'WR', out: 'WR-start1' })
    // The replacement cascades: the best eligible WR is the incumbent FLEX, who
    // is himself backfilled by the bench RB. Total goes UP even though this one
    // slot's projection goes down, which is why slot-level gain is not reported.
    expect(act[0].gain).toBeNull()
    const best = optimize(SLOTS, starters, bench)
    expect(best[3]?.name).toBe('FLEX-start')
    expect(best[6]?.name).toBe('RB-bench')
    // Scored honestly — a player with no game is a zero, not his projection.
    const total = (xs: (Spot | null)[]) =>
      xs.reduce((a, s) => a + (!s || s.game === '—' ? 0 : s.proj), 0)
    expect(total(starters)).toBe(98)
    expect(total(best)).toBe(108)
  })

  test('slot eligibility is respected — a QB never fills FLEX or WR', () => {
    const { starters, bench } = lineup()
    // Blow a hole in WR2 and FLEX; the only big bench arm is a QB.
    starters[4] = { ...starters[4]!, inj: 'Out' }
    starters[6] = { ...starters[6]!, inj: 'Out' }
    const best = optimize(SLOTS, starters, bench)
    SLOTS.forEach((slot, i) => {
      if (slot === 'QB') return
      expect(best[i] === null || best[i]!.pos !== 'QB').toBe(true)
    })
    // WR-bench is the only eligible body, so one hole gets filled and one stays.
    expect(best[4]?.name).toBe('WR-bench')
  })

  test('Questionable is WATCH, never ACT', () => {
    const { starters, bench } = lineup()
    starters[2] = { ...starters[2]!, inj: 'Questionable' }
    const alerts = run(starters, bench)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ level: 'WATCH', kind: 'IFFY' })
  })

  test('a Questionable starter nobody can replace still reports, with no swap', () => {
    const { starters } = lineup()
    const alerts = run(starters.map((s, i) => (i === 0 ? { ...s!, inj: 'Questionable' } : s)), [])
    expect(alerts[0]).toMatchObject({ level: 'WATCH', kind: 'IFFY', in: null })
    expect(alerts[0].why).toContain('nothing on the bench beats him')
  })

  test('a bench upgrade under the margin stays quiet; over it, it speaks', () => {
    const { starters, bench } = lineup()
    // TE-start 9.0 vs a 10.0 bench TE = +1.0, under the 1.5 margin.
    expect(run(starters, [...bench, p({ pos: 'TE', proj: 10, name: 'TE-near' })])).toEqual([])
    const loud = run(starters, [...bench, p({ pos: 'TE', proj: 11, name: 'TE-clear' })])
    expect(loud).toHaveLength(1)
    expect(loud[0]).toMatchObject({ level: 'WATCH', kind: 'UPGRADE', in: 'TE-clear', gain: 2 })
  })

  test('an empty slot is ACT', () => {
    const { starters, bench } = lineup()
    starters[5] = null
    const act = run(starters, bench).filter((a) => a.level === 'ACT')
    expect(act[0]).toMatchObject({ kind: 'OUT', slot: 'TE', out: '(empty)', in: 'TE-bench' })
  })

  test('locked starters are never moved out of their slot', () => {
    const { starters, bench } = lineup()
    const pinned = { ...starters[6]!, locked: true, name: 'FLEX-locked', proj: 1 }
    starters[6] = pinned
    const best = optimize(SLOTS, starters, [...bench, p({ pos: 'RB', proj: 99, name: 'RB-huge' })])
    expect(best[6]!.name).toBe('FLEX-locked')
    // ...and the huge bench RB lands in a changeable RB slot instead.
    expect([best[1]?.name, best[2]?.name]).toContain('RB-huge')
  })

  test('the odds join survives a divisional rematch', () => {
    // WAS and PHI meet twice. Week 1 is WAS@PHI on Sep 13; the same two teams
    // meet again as PHI@WAS on Nov 2. Joining on the pairing alone matches both
    // and the later row wins, pushing every deadline three months out.
    const byTeam = {
      WAS: { opp: 'PHI', date: '2026-09-13' },
      PHI: { opp: 'WAS', date: '2026-09-13' },
    }
    const { kickoffOf, impliedOf } = matchOdds(
      [
        {
          game: 'WAS@PHI',
          kickoff: '2026-09-13T20:25:00Z',
          implied: { PHI: 24.8, WAS: 19.3 },
        },
        {
          game: 'PHI@WAS',
          kickoff: '2026-11-02T18:00:00Z',
          implied: { WAS: 22.3, PHI: 24.3 },
        },
      ],
      byTeam,
    )
    expect(kickoffOf.WAS).toBe('2026-09-13T20:25:00Z')
    expect(kickoffOf.PHI).toBe('2026-09-13T20:25:00Z')
    expect(impliedOf.WAS).toBe(19.3)
    expect(impliedOf.PHI).toBe(24.8)
  })

  test('a Sunday night kickoff is dated by its Eastern day, not UTC', () => {
    // 00:20Z Monday is still Sunday night football to the NFL and to Sleeper.
    const { kickoffOf } = matchOdds(
      [{ game: 'DAL@NYG', kickoff: '2026-09-14T00:20:00Z', implied: { NYG: 22.5 } }],
      { NYG: { opp: 'DAL', date: '2026-09-13' }, DAL: { opp: 'NYG', date: '2026-09-13' } },
    )
    expect(kickoffOf.NYG).toBe('2026-09-14T00:20:00Z')
  })
})
