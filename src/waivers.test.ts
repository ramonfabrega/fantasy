// The waiver evaluator's job is mostly to say NO, so the thing worth pinning is
// the two ways it said yes when it shouldn't have.
//
// The first version ranked candidates on the board's `val` and promptly
// recommended adding a backup DEF: DEF8 carries val 6, our worst bench RB
// carried val 0, so on paper that was +6. In a one-DEF league with no DEF flex
// slot, a second DEF is worth nothing — it can never enter the lineup. Scoring
// the roster instead of the players is what fixed it, and these tests are what
// keep it fixed.
//
// Week 4 of 2026 added two more: it could not see the IR slot (so it quoted a
// drop for every add while a spot sat empty), and it offered to cut our only
// healthy QB while the starter was Questionable.
import { expect, test, describe } from 'bun:test'
import {
  activeCapacity,
  bestMove,
  canFieldLineup,
  keepsHealthyStarters,
  reserveEligible,
  rosterValue,
  splitRoster,
  type Holding,
} from './waivers'
import type { Shape } from './sleeper'

/** This league: 1QB/2RB/2WR/1TE/1FLEX(RB,WR,TE)/1K/1DEF. */
const SHAPE: Shape = {
  teams: 12,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 },
  flexSlots: 1,
  flexPos: ['RB', 'WR', 'TE'],
  rounds: 15,
}

let n = 0
function h(pos: string, vorp: number, val = vorp, inj = ''): Holding {
  return { id: `p${++n}`, name: `${pos}${n}`, pos, vorp, val, pos_rank: null, inj }
}

/** This league's roster_positions: 9 starters + 6 BN = 15 active spots. */
const RP = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']

/** A legal, unremarkable roster: every slot filled, one spare RB on the bench. */
function baseRoster(): Holding[] {
  return [
    h('QB', 30),
    h('RB', 40),
    h('RB', 20),
    h('WR', 35),
    h('WR', 15),
    h('TE', 10),
    h('WR', 8), // flex
    h('K', 5),
    h('DEF', 12),
    h('RB', 4), // bench depth
  ]
}

describe('canFieldLineup', () => {
  test('accepts a roster that fills every slot', () => {
    expect(canFieldLineup(baseRoster().map((p) => p.pos), SHAPE)).toBe(true)
  })

  test('rejects a roster with no kicker', () => {
    const pos = baseRoster()
      .filter((p) => p.pos !== 'K')
      .map((p) => p.pos)
    expect(canFieldLineup(pos, SHAPE)).toBe(false)
  })

  test('rejects a roster that cannot fill the flex', () => {
    // Exactly the fixed starters and nothing else: FLEX goes empty.
    expect(canFieldLineup(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'K', 'DEF'], SHAPE)).toBe(false)
  })

  test('lets a TE fill the flex, since this league allows it', () => {
    expect(canFieldLineup(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'TE', 'K', 'DEF'], SHAPE)).toBe(true)
  })
})

describe('rosterValue', () => {
  test('a second DEF is worth nothing — it can never reach the lineup', () => {
    const before = rosterValue(baseRoster(), SHAPE)
    const after = rosterValue([...baseRoster(), h('DEF', 6)], SHAPE)
    expect(after - before).toBe(0)
  })

  test('a second K is worth nothing either', () => {
    const before = rosterValue(baseRoster(), SHAPE)
    const after = rosterValue([...baseRoster(), h('K', 1)], SHAPE)
    expect(after - before).toBe(0)
  })

  test('a BETTER DEF is worth exactly the upgrade it makes', () => {
    // Our DEF is vorp 12; a vorp 20 DEF takes the slot and the old one becomes
    // worthless, so the roster moves by the difference and nothing more.
    const before = rosterValue(baseRoster(), SHAPE)
    const after = rosterValue([...baseRoster(), h('DEF', 20)], SHAPE)
    expect(after - before).toBe(8)
  })

  test('a bench RB still counts, at half — one injury from the lineup', () => {
    const before = rosterValue(baseRoster(), SHAPE)
    const after = rosterValue([...baseRoster(), h('RB', -5, 10)], SHAPE)
    expect(after - before).toBe(5)
  })

  test('a starter upgrade beats bench depth of the same board value', () => {
    const base = baseRoster()
    const upgrade = rosterValue([...base, h('WR', 30)], SHAPE) - rosterValue(base, SHAPE)
    const depth = rosterValue([...base, h('RB', -5, 30)], SHAPE) - rosterValue(base, SHAPE)
    expect(upgrade).toBeGreaterThan(depth)
  })

  test('dropping a zero-value bench player costs nothing', () => {
    const base = baseRoster()
    const worthless = [...base, h('RB', -50, 0)]
    expect(rosterValue(worthless, SHAPE)).toBe(rosterValue(base, SHAPE))
  })

  test('is indifferent to the order players are listed in', () => {
    const r = baseRoster()
    expect(rosterValue([...r].reverse(), SHAPE)).toBe(rosterValue(r, SHAPE))
  })
})

describe('the IR slot', () => {
  test('reserve players are listed in `players` but hold no active spot', () => {
    const ids = Array.from({ length: 15 }, (_, i) => `x${i}`)
    const { active, parked } = splitRoster({ players: ids, reserve: ['x3'] })
    expect(active).toHaveLength(14)
    expect(parked).toEqual(['x3'])
    expect(activeCapacity(RP) - active.length).toBe(1)
  })

  test('IR/TAXI entries in roster_positions are not active spots', () => {
    expect(activeCapacity([...RP, 'IR', 'TAXI'])).toBe(15)
  })

  test('an open active spot quotes an add-only: drop is null', () => {
    // 14 active men, one spot open (the 15th is on IR and excluded upstream).
    const active = [...baseRoster(), h('WR', 2), h('RB', 1), h('TE', 0), h('QB', -2)]
    const cand = h('RB', -5, 18) // bench-grade RB: pure depth, worth val/2
    const m = bestMove(active, cand, SHAPE, 1)!
    expect(m.drop).toBeNull()
    expect(m.gain).toBe(9)
    expect(m.gain).toBe(rosterValue([...active, cand], SHAPE) - rosterValue(active, SHAPE))
  })

  test('with no open spot the same candidate is quoted as a pair', () => {
    const active = [...baseRoster(), h('WR', 2), h('RB', 1), h('TE', 0), h('QB', -2)]
    const m = bestMove(active, h('RB', -5, 18), SHAPE, 0)!
    expect(m.drop).not.toBeNull()
  })

  test('reserve eligibility is IR/PUP plus whatever the league opts into', () => {
    const ok = reserveEligible({ reserve_allow_cov: 1, reserve_allow_out: 0 })
    expect([...ok].sort()).toEqual(['COV', 'IR', 'PUP'])
    expect(reserveEligible({ reserve_allow_out: 1 }).has('Out')).toBe(true)
  })
})

describe('injury-aware drops', () => {
  /** Starter QB Questionable, backup healthy but low value — the week-4 roster. */
  function qbHurt() {
    const r = baseRoster()
    r[0] = h('QB', 30, 30, 'Questionable')
    return [...r, h('QB', -2, -2), h('WR', 3), h('RB', 2)]
  }

  test('the last healthy QB is never proposed as a drop', () => {
    const active = qbHurt()
    const backup = active.find((p) => p.pos === 'QB' && p.inj === '')!
    // A WR good enough that the cheapest drop by value would be the backup QB.
    const m = bestMove(active, h('WR', 20), SHAPE, 0)!
    expect(m).not.toBeNull()
    expect(m.drop?.id).not.toBe(backup.id)
    expect(m.drop?.pos).not.toBe('QB')
  })

  test('keepsHealthyStarters rejects stranding QB, allows a like-for-like swap', () => {
    const active = qbHurt()
    const backup = active.find((p) => p.pos === 'QB' && p.inj === '')!
    const without = active.filter((p) => p.id !== backup.id)
    expect(keepsHealthyStarters(active, [...without, h('WR', 20)], backup, SHAPE)).toBe(false)
    expect(keepsHealthyStarters(active, [...without, h('QB', 5)], backup, SHAPE)).toBe(true)
  })

  test('with a healthy starter the backup QB is fair game again', () => {
    const r = baseRoster()
    const active = [...r, h('QB', -2, -2), h('WR', 3), h('RB', 2)]
    const backup = active[active.length - 3]!
    const without = active.filter((p) => p.id !== backup.id)
    expect(keepsHealthyStarters(active, [...without, h('WR', 20)], backup, SHAPE)).toBe(true)
  })

  test('a single-slot K/DEF still cannot be dropped for another position', () => {
    // Legal-lineup rule, unchanged: the only DEF never goes.
    const active = [...baseRoster(), h('WR', 3)]
    const m = bestMove(active, h('WR', 25), SHAPE, 0)!
    expect(m.drop?.pos).not.toBe('DEF')
    expect(m.drop?.pos).not.toBe('K')
  })
})
