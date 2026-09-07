# fantasy

Fantasy football decision tooling for Sleeper leagues. Read-only, no build step,
one dependency. Ships as a CLI that is equally usable by a human and an agent
(`--json`, `--llms`, `--mcp` come free via [incur](https://github.com/wevm/incur)).

Built for The Ballers Fantasy League (2026), but every league-specific value is
an env var — point it at your own league and everything works.

**The short version of how it's used:** you run it inside a Claude Code session.
The CLI is the sensor; the agent is the decision-maker. On draft day one person
clicks in sleeper.com while the agent calls every pick off `ff board` / `ff live`.
See [The flow](#the-flow).

## Quickstart

```sh
bun install
bun ff --llms        # command manifest, generated — the best orientation for an agent
bun ff league        # your league's rules, decoded
bun ff --help        # same, for humans
```

That's it. The Sleeper API is public and unauthenticated, so the Sleeper commands
work with zero configuration. Only `ff odds` needs a key.

## Configuration

```sh
cp .env.example .env
```

| Variable | Needed for | Default |
| --- | --- | --- |
| `FF_LEAGUE_ID` | pointing at your league | The Ballers 2026 |
| `FF_USER_ID` | "our team" in `roster`/`draft` | ramonfabrega |
| `FF_USERNAME` | same | ramonfabrega |
| `ODDS_API_KEY` | `ff odds` only | — |

To find your IDs: `https://api.sleeper.app/v1/user/<username>` gives `user_id`,
then `https://api.sleeper.app/v1/user/<user_id>/leagues/nfl/2026` lists leagues.
Grab a free odds key at [the-odds-api.com](https://the-odds-api.com) (500
credits/mo; a spreads+totals call costs 2 and is cached 6h).

Sanity check that you're pointed at the right place:

```sh
bun ff league     # should print YOUR league's name, scoring, roster
bun ff draft      # should print your draft's date, type, and your slot
bun ff roster     # should print your team
```

## The flow

This repo assumes an agent is driving. Every command prints TOON by default and
takes `--json`, so a Claude Code session can read any of it without parsing prose.
What follows is the sequence we actually ran for the 2026 draft.

### 1. Setup (once, any time before draft day)

```sh
bun install
cp .env.example .env      # fill in FF_LEAGUE_ID / FF_USER_ID / FF_USERNAME
bun ff league             # confirm the rules the engine will optimize against
```

`ff league` matters more than it looks. Every downstream number — VORP baselines,
flex allocation, FAAB sizing — is derived from your roster slots and scoring. If
this output is wrong, everything after it is wrong.

### 2. Homework (the week before)

Run these once and let the agent read them. They're the research layer, and none
of it needs to be repeated on draft day.

```sh
bun ff scout              # your league's own past season: records, draft habits, FAAB
bun ff study              # how that season was actually won: round ROI, waiver gold
bun ff meta crawl         # harvest similar public leagues (slow, run it once)
bun ff meta study         # what wins across the whole corpus, not just your 12
bun ff meta adp           # build corpus ADP — `ff profile` needs this
bun ff profile            # per-opponent: who reaches, who waits, who hoards a position
```

Order matters: `meta study` and `meta adp` both read what `meta crawl` harvested,
and `ff profile` measures each opponent against the corpus ADP that `meta adp`
builds. Run out of order and they'll tell you which step you skipped.

The point isn't the numbers, it's the priors: which rounds actually decide the
season in *your* format, and which specific opponents will take a QB early enough
to matter. Have the agent write the conclusions down somewhere it will still have
them on draft day.

### 3. Build the board

```sh
bun ff board                     # the rankings, under your rules
bun ff board --pos RB            # one position
bun ff mock --sims 300           # play the rest of the draft 300x → pick plan
```

```
$ bun ff board --top 10
[10]{rk,player,pos,team,t,pts,vorp,val,adp,edge,last,flag}:
  1,Jahmyr Gibbs,RB1,DET,1,300,153,153,1.9,1,328,""
  2,Bijan Robinson,RB2,ATL,1,293,146,146,2.4,0,331,""
  3,Christian McCaffrey,RB3,SF,2,256,109,109,4,1,366,Q ↓
  4,Puka Nacua,WR1,LAR,1,259,108,108,6.9,3,311,Q
  5,Jonathan Taylor,RB4,IND,2,254,107,107,5.8,1,339,""
  6,Ja'Marr Chase,WR2,CIN,1,257,106,106,3.8,-2,251,Q
  7,James Cook,RB5,BUF,2,245,98,98,8.4,1,286,""
  8,Derrick Henry,RB6,BAL,2,238,91,91,14.7,7,272,""
  9,Jaxon Smith-Njigba,WR3,SEA,2,235,84,84,8.4,-1,300,""
  10,De'Von Achane,RB7,MIA,2,230,83,83,13.6,4,289,""
```

`t` is tier, `pts` projected points, `vorp` points over the starter replacement,
`adp` what the room thinks, `edge` how far the board disagrees with ADP, `last`
last season's actual, `flag` injury/rookie/regression marks (`Q` questionable,
`↓` regression candidate).

`ff board` re-scores Sleeper's season projections under your league's scoring, then
values every player two ways — VORP over the starter replacement (with the flex
slots allocated jointly across RB/WR/TE, so RB and WR baselines move together) and
half-weighted value over the draft-end waiver baseline. It reports tiers from the
real gaps in the curve, plus ADP edge so you can see what the room thinks.

`ff mock` is the one to actually plan from: it simulates opponents off ADP and you
off the board, and returns, for each of your picks, who's likely to be there.

### 4. Rehearse (the day before — do not skip this)

Start a mock draft on Sleeper, grab its draft id out of the URL, and point the
live board at it:

```sh
bun ff live --draft 1400974557115883520 --serve 4242
```

Everything runs exactly as it will on the night. This is where you find out that
your pick-call format is ambiguous, or that your poll is too slow, at zero cost.
We caught a real mistake this way: a name-only call ("Brian Thomas") got the wrong
player clicked in the search box. Hence the format below.

### 5. Draft day

Full runbook: **[docs/live-draft.md](docs/live-draft.md)** — pauses, rewinds,
watcher patterns, and the checklist. The short version:

Two things running:

- **Sleeper's own draft room**, in a browser. You click here. This is the only
  thing that actually makes a pick.
- **`bun ff live --serve 4242`**, which polls Sleeper once a second and pushes
  updates over SSE.

and one agent session watching:

```
ws://localhost:4242/ws
```

The `/ws` endpoint is a deliberately quiet feed — it only emits what changes a
decision: a heads-up three picks out, your pick (with the top 12 off the board),
status changes, errors. In Claude Code, attach it with the `Monitor` tool (`ws`
source, `persistent: true`) so the agent is woken by picks instead of polling for
them. `--serve` binds `0.0.0.0`, so the page and the socket are reachable from
another machine on your tailnet (`http://studio:4242/`).

**Call every pick as `Player, POS TEAM`, with two fallbacks.** Names alone are a
mistake vector under the clock — Sleeper's search will happily surface a
different person with a similar name. Position and team disambiguate.

**In a snake draft your picks come in pairs** (from slot 2: 23/26, 47/50, …). Queue
both names at the first pick of each pair; the second is nearly always the fallback
you already discussed.

Note that `ff board` and `ff mock` are **preparation**, not draft-night commands.
Under the clock there is no time to run anything — the plan is already made, and
the only live reads are the `/ws` feed and `/data`. Sleeper's default timer is 30
seconds; a commissioner can raise it (ours ran at 90), but read it live off the
draft object on the night rather than trusting notes — see
[docs/live-draft.md](docs/live-draft.md).

> **On the served page:** we built it, and in the real draft essentially nobody
> looked at it. The agent never loaded the page — it read `/data` and `/ws`. The
> conversation was the interface: the heads-up arrived three picks early, the agent
> called `Player, POS TEAM` plus a fallback, and we clicked it in Sleeper. The page
> is genuinely useful as a rehearsal aid and for letting someone else follow along,
> but if you only set up one thing, set up the `/ws` feed. Run `--serve` regardless
> — the server is the engine's HTTP face, and it did all the real work.

**Draft-day checklist**

- [ ] `bun ff league` — rules are right
- [ ] `bun ff board` — projections are fresh (`--fresh` bypasses the 1h cache)
- [ ] `bun ff mock --sims 300` — the pick plan for your slot
- [ ] `bun ff live --serve 4242` — running, and the page loads
- [ ] agent attached to `ws://localhost:4242/ws`
- [ ] you know your slot and your first three pick numbers
- [ ] pick-call format agreed: `Player, POS TEAM` + two fallbacks

### 6. After the draft

```sh
bun scripts/report/postdraft.ts     # score every roster under your rules
python3 scripts/report/build_report.py
```

Produces a standalone HTML power-rankings page for the whole league — projected
starting lineup, who drafted best against par, steals and reaches, positional
runs. See [`scripts/report/`](scripts/report/).

## Commands

**Live league**
| | |
| --- | --- |
| `ff state` | NFL season state (season, week, phase) |
| `ff league` | league rules decoded: scoring, roster, waivers, playoffs |
| `ff members` | owners, team names, records |
| `ff roster [owner]` | a team's current roster (default: yours) |
| `ff matchups [week]` | weekly head-to-head with scores |
| `ff draft` | draft status: schedule, order, your slot |
| `ff picks` | picks so far — poll this during a live draft |

**Research**
| | |
| --- | --- |
| `ff player <query>` | search the NFL player database |
| `ff trending [add\|drop]` | crowd signal across all of Sleeper |
| `ff scout [--league id]` | mine a past season: records, draft tendencies, FAAB habits |
| `ff study` | how a season was won: position splits, round ROI, waiver gold |
| `ff profile` | opponent profiles vs corpus ADP: reach habits, timing, biases |
| `ff value` | positional baselines + VORP under *your* scoring |
| `ff odds` | Vegas consensus: spreads, totals, implied team totals |
| `ff meta crawl\|study` | harvest similar leagues, then study how they were won |

**Draft day**
| | |
| --- | --- |
| `ff board [--pos RB] [--available]` | Sleeper season projections re-scored under *your* rules → flex-aware VORP, tiers, ADP edge, injury/rookie/regression flags |
| `ff mock [--sims 300]` | play the rest of the draft N times (opponents off ADP, you off the board) → pick plan with availability odds per pick |
| `ff live [--serve 4242] [--draft <id>]` | on-the-clock state, your roster, best available for *your* next pick. `--serve` adds a page plus the `/ws` agent feed; `--draft` points it at any draft id, e.g. a mock, to rehearse |

Every command takes `--json` / `--format yaml\|md\|jsonl` for machines, and
`ff --mcp` serves the whole CLI as an MCP server.

## How it works

Two ideas:

1. **Take the market, don't beat it.** Vegas lines and consensus projections are
   the prediction layer. This repo never models raw player performance.
2. **The edge is in decisions, not predictions.** Translate market data through
   *your exact league rules* (VORP, tiers, FAAB bids) and allocate under real
   constraints — roster slots, a $100 budget, a 30-second pick clock.

The bet is that in a league of friends, nobody loses to bad projections. They lose
to being asleep, to sunk cost on a player they drafted, and to not noticing that
the last startable tight end just went. Those are all tooling problems.

Be clear about where the edge is and isn't. Re-scoring under your league's rules
only buys something if your league differs from the platform default — if you're on
stock Sleeper half-PPR, the re-scoring is a correctness guarantee rather than an
advantage. The parts that actually pay are the flex-aware baselines, the tier gaps,
the availability odds from `ff mock`, and being awake.

## What it reads and writes

Worth knowing before you run someone else's tooling on your machine:

- **Reads:** Sleeper's public REST API (`api.sleeper.app`, `api.sleeper.com`) —
  unauthenticated, no account linkage, the same data the website serves. Optionally
  [the-odds-api.com](https://the-odds-api.com) if you set `ODDS_API_KEY`.
- **Writes:** `.cache/` in the repo (player DB, odds, meta crawl) and
  `scripts/report/out/` if you generate a report. Both gitignored.
- **Sends nothing anywhere.** There is no telemetry, no account, no server. It
  cannot make a pick, a claim, or a lineup change — there is no write path to
  Sleeper at all (see [Notes and known limits](#notes-and-known-limits)).
- **`--serve` opens a port on `0.0.0.0`**, so anyone on your local network or
  tailnet can load the draft board while it runs. That's deliberate (draft from a
  laptop, serve from a desktop) but it is the one outward-facing thing here.

## Layout

```
src/sleeper.ts  Sleeper API client + player DB cache (env var contract lives here)
src/ff.ts       CLI: every command definition
src/proj.ts     season projections re-scored under your rules → VORP, tiers, the board
src/draft.ts    live draft state, the served page, the /ws agent feed
src/mock.ts     Monte Carlo of the remaining draft → pick plan
src/value.ts    re-score real seasons under your rules → positional baselines, VORP
src/odds.ts     the-odds-api → consensus spreads/totals → implied team totals
src/meta.ts     crawl similar public leagues, study how they were won
src/profile.ts  per-opponent draft profiling vs corpus ADP
scripts/report/ post-draft power-rankings page (roster scoring + HTML generator)
docs/live-draft.md  the draft-night runbook
```

Caches (`.cache/`, gitignored): the ~5MB player DB refreshes daily — Sleeper asks
for at most one fetch per day — and odds responses hold for 6h.

Requires [Bun](https://bun.sh) (and `python3` for the report generator only). No
build, no test suite yet.

## Notes and known limits

- **Kicker projections are understated.** Sleeper's projection feed carries no
  FG 0–39 buckets, so kicker totals come in roughly 10–20 points light across the
  board. It's uniform, so the ranking within kickers is fine.
- **DEF rows in the projection feed are stubs** — the per-stat breakdown is empty,
  so the published total is used directly rather than re-scored.
- **Sleeper's "steal"/"reach" labels are pure ADP distance**, not value. The board
  will disagree with them, and that disagreement is the whole point.
- **`ff value` uses the weekly stats endpoints.** The season-total endpoint is
  broken upstream. Watch out for duplicate player names across eras (there are two
  Josh Allens) — always join on player id.
- **No write path.** Everything here reads. Making a pick, a waiver claim, or a
  lineup change means clicking in Sleeper. There is no official write API; the app's
  own realtime gateway (`wss://gateway.sleeper.com/socket/websocket`) requires the
  session token from a logged-in browser and is not part of this repo.
- **No realtime stream.** Following from the above: Sleeper offers no anonymous
  websocket, so `ff live` polls once a second. That's well inside their limits and
  fast enough for a 30-second clock.
- **`/data`'s `recent` is a short window**, not the full pick list. For complete
  history use `https://api.sleeper.app/v1/draft/<id>/picks`.
- **Server `status` lags a few seconds** behind Sleeper after a commissioner resume.
- **Draft rewinds need pick+player keying.** A commissioner rewind re-emits pick
  numbers you've already seen; a watcher keyed on pick number alone will go silent
  on the replacements. See [docs/live-draft.md](docs/live-draft.md).
- **The board has no ADP-vs-current-pick column.** It shows ADP and the board's
  disagreement with it, but not "how far past their ADP are we right now" — so
  reconciling against Sleeper's own steal/reach labels takes a manual step.
- **No tests.** The engine is verified by reading its output, which is exactly as
  reassuring as it sounds.

## License

MIT — see [LICENSE](LICENSE).
