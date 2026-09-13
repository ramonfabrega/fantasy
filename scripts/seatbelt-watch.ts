#!/usr/bin/env bun
// The seatbelt, on a timer.
//
// Run it as often as you like (every 15 minutes is the intended cadence). It
// decides for itself whether this is a moment worth interrupting a human for,
// which is the only way a weekly-in-season job survives contact with a season:
// one that pings every quarter hour gets muted in week 2 and is therefore worth
// less than nothing in week 11.
//
// It speaks only when ALL of these hold:
//   - a starting slot is still changeable (its game has not kicked), and
//   - that slot's kickoff is inside the alert window (default 20-150 min out,
//     which straddles the ~90-minute inactives drop), and
//   - `ff seatbelt` says ACT (or WATCH, with --watch), and
//   - it has not already said this exact thing for this exact kickoff wave.
//
// Windows are derived from the real kickoff times of our own players, never
// from a hardcoded "Sunday 11:30" — a repo that hardcodes 1pm ET misses the
// 9:30am London game, the Saturday week-16 slate, and every flexed start.
//
// Notification goes to macOS, and to whatever `FF_SEATBELT_HOOK` names (the
// message arrives on stdin). Deliberately no built-in Slack/Discord/push: the
// channel is the operator's choice, and guessing it wrong means silence at the
// exact moment silence is expensive.
//
// Exit codes: 0 nothing to say, 10 alerted, 1 broke.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { seatbelt, type Alert } from '../src/lineup'

const args = new Set(Bun.argv.slice(2))
const FORCE = args.has('--force') // ignore the window and the dedupe
const WATCH_TOO = args.has('--watch') // also speak for WATCH, not just ACT
const QUIET = args.has('--quiet') // dry run: decide and log, notify nothing, record nothing
const OWNER = // whose lineup; ours unless told otherwise
  Bun.argv.slice(2).find((a) => a.startsWith('--owner='))?.slice(8) ??
  process.env.FF_SEATBELT_OWNER

const WINDOW_MIN = Number(process.env.FF_SEATBELT_MIN ?? 20)
const WINDOW_MAX = Number(process.env.FF_SEATBELT_MAX ?? 150)

const STATE_DIR = join(import.meta.dir, '../.cache')
const STATE = join(STATE_DIR, 'seatbelt-sent.json')

const mins = (iso: string) => (Date.parse(iso) - Date.now()) / 60_000

function line(a: Alert): string {
  const to = a.in ? ` -> start ${a.in}` : ' (no replacement on the bench)'
  return `${a.level} ${a.slot}: ${a.why}${to}`
}

async function notify(title: string, body: string) {
  if (QUIET) return
  if (process.platform === 'darwin') {
    const esc = (s: string) => s.replace(/["\\]/g, '\\$&').replace(/\n/g, ' \u00b7 ')
    Bun.spawnSync([
      'osascript',
      '-e',
      `display notification "${esc(body)}" with title "${esc(title)}" sound name "Submarine"`,
    ])
  }
  const hook = process.env.FF_SEATBELT_HOOK?.trim()
  if (hook) {
    const proc = Bun.spawn(['sh', '-c', hook], { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' })
    proc.stdin.write(`${title}\n${body}\n`)
    await proc.stdin.end()
    await proc.exited
  }
}

// A free gate before any network call. The timer can then run every 15 minutes
// year-round without making a single pointless request in March, which keeps
// the launchd side dumb (one StartInterval) instead of a 50-entry calendar.
// Football happens Thu/Sat/Sun/Mon, Sep-Jan, and lineups lock in daylight.
const NFL_DAYS = new Set([0, 1, 4, 6]) // Sun, Mon, Thu, Sat
const now = new Date()
const inSeason = now.getMonth() >= 8 || now.getMonth() === 0 // Sep-Dec, or Jan
if (
  !FORCE &&
  (!inSeason || !NFL_DAYS.has(now.getDay()) || now.getHours() < 8 || now.getHours() > 21)
) {
  process.exit(0)
}

const s = await seatbelt({ owner: OWNER })

// Only alerts whose decision actually expires soon are worth a ping now; a
// Monday-night starter is not urgent at Sunday noon.
const live = s.alerts.filter((a) => {
  if (a.level === 'WATCH' && !WATCH_TOO) return false
  if (!a.deadline) return FORCE
  const m = mins(a.deadline)
  return FORCE || (m >= WINDOW_MIN && m <= WINDOW_MAX)
})

const wave = live
  .map((a) => a.deadline)
  .filter(Boolean)
  .sort()[0] ?? 'none'

const log = (msg: string) =>
  console.log(`[${new Date().toISOString()}] wk${s.week} ${s.owner} ${msg}`)

if (!live.length) {
  log(
    `nothing to say (verdict ${s.verdict}, ${s.changeable} changeable, next lock ${
      s.next_lock ?? 'n/a'
    })`,
  )
  process.exit(0)
}

// Dedupe on the content, not the clock: the same warning about the same wave is
// sent once, but a NEW ruling in the same wave gets through.
const fingerprint = `${s.season}:${s.week}:${wave}:${live.map(line).join('|')}`
mkdirSync(STATE_DIR, { recursive: true })
const sentFile = Bun.file(STATE)
const sent: Record<string, string> = (await sentFile.exists()) ? await sentFile.json() : {}
if (!FORCE && sent[fingerprint]) {
  log(`already sent at ${sent[fingerprint]}`)
  process.exit(0)
}

const body = live.map(line).join('\n')
const mLeft = wave === 'none' ? null : Math.round(mins(wave))
const title = `${s.verdict === 'ACT' ? 'FIX YOUR LINEUP' : 'Lineup watch'} - wk${s.week}${
  mLeft != null ? `, ${mLeft}m to lock` : ''
}`

await notify(title, body)
log(`sent: ${title} :: ${body.replace(/\n/g, ' | ')}`)
if (s.apply.length) log(`apply: ${s.apply.map((m) => `${m.slot} ${m.out}->${m.in}`).join(', ')}`)

// A dry run must not consume the alert: recording a fingerprint nobody saw
// would silence the real run that follows it.
if (!QUIET) {
  sent[fingerprint] = new Date().toISOString()
  // Keep the file from growing across a season; a wave older than a week is dead.
  const week = 7 * 24 * 3600_000
  for (const [k, v] of Object.entries(sent))
    if (Date.now() - Date.parse(v) > week) delete sent[k]
  await Bun.write(STATE, JSON.stringify(sent, null, 2))
}

process.exit(10)
