# fantasy

Fantasy football decision tooling for Sleeper leagues. Read-only, no build step,
one dependency. A CLI that is equally usable by a human and an agent — `--json`,
`--llms` and `--mcp` come free via [incur](https://github.com/wevm/incur).

It re-scores the whole player pool under *your* league's actual scoring and roster
construction, then tells you who to take.

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

`t` tier · `pts` projected · `vorp` points over replacement · `adp` what the room
thinks · `edge` how far this disagrees with ADP · `last` last season's actual ·
`flag` injury/rookie/regression (`Q` questionable, `↓` regression candidate).

Built for The Ballers Fantasy League (2026) and used to run a real draft: 15 of 15
picks called off this board, no autopicks, no misclicks. Every league-specific
value is read from the league itself — point it at yours and it recalibrates.

## Quickstart

```sh
bun install
bun ff league        # your league's rules, decoded
bun ff roster        # your team
bun ff board         # the rankings
```

The Sleeper API is public and unauthenticated, so this works with zero
configuration. Only `ff odds` needs a key.

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

**Set the three `FF_` values together.** `FF_LEAGUE_ID` alone points the tools at
your league while "our team" still resolves to this repo's author.

To find your IDs: `https://api.sleeper.app/v1/user/<username>` gives `user_id`,
then `https://api.sleeper.app/v1/user/<user_id>/leagues/nfl/2026` lists leagues.
Grab a free odds key at [the-odds-api.com](https://the-odds-api.com) (500
credits/mo; a spreads+totals call costs 2 and is cached 6h).

Then check you're pointed at the right place. These two are the gate on everything
else, and the only setup that can fail *silently*:

```sh
bun ff league     # the right league? scoring and roster slots define the engine
bun ff roster     # does "our team" resolve to your team?
```

If `ff league` shows the wrong league, nothing downstream is trustworthy — the
output won't look broken, it'll look confident. If `ff roster` says *no such
owner*, your identity vars aren't set.

## How it works

Two ideas:

1. **Take the market, don't beat it.** Vegas lines and consensus projections are
   the prediction layer. This repo never models raw player performance.
2. **The edge is in decisions, not predictions.** Translate market data through
   your exact league rules — VORP, tiers, FAAB bids — and allocate under real
   constraints: roster slots, a $100 budget, a pick clock measured in seconds.

The bet is that in a league of friends nobody loses to bad projections. They lose
to being asleep, to sunk cost on a player they drafted, and to not noticing that
the last startable tight end just went. Those are tooling problems.

Where the edge *isn't*: re-scoring only buys something if your league differs from
the platform default. On stock Sleeper half-PPR it's a correctness guarantee, not
an advantage. What actually pays is the flex-aware baselines, the tier gaps, the
availability odds from `ff mock`, and being awake.

## What adapts to your league

Everything that matters, read live from the Sleeper API — so pointing
`FF_LEAGUE_ID` somewhere else recalibrates the engine rather than reskinning
someone else's numbers:

| | read from your league |
| --- | --- |
| **Scoring** | `scoring_settings` — PPR vs half-PPR vs standard, pass-TD value, every stat weight. Projections are re-scored stat by stat, not adjusted. |
| **Roster construction** | `roster_positions` — how many of each position you start, how many flex slots, which positions fill them. SUPERFLEX/2QB, 3WR, no-kicker and multi-flex builds all work. |
| **League size** | `total_rosters` — every replacement baseline is "how many of this position start across the whole league", so 10-team and 14-team get different lines. |
| **Draft shape** | teams, rounds, snake vs linear, and your slot, off the draft object. |

Concretely: in a superflex league the QB replacement level collapses to the flex
line and quarterbacks reprice; in a league with no kicker slot, kickers value at
zero. Neither needs a code change.

Not derived: `ff mock`'s opponent model assumes opponents draft roughly to ADP,
and the doctrine in the recommender (late QB, one TE, K/DEF only at the end) is a
heuristic tuned on 12-team half-PPR. Those are opinions, not league rules.

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
| `ff meta crawl\|study\|adp` | harvest similar leagues, study how they were won, build corpus ADP |

**Draft day**
| | |
| --- | --- |
| `ff board [--pos RB] [--available]` | projections re-scored under *your* rules → flex-aware VORP, tiers, ADP edge, flags |
| `ff mock [--sims 300]` | play the rest of the draft N times → pick plan with availability odds per pick |
| `ff live [--serve 4242] [--draft <id>]` | on-the-clock state, your roster, best available for *your* next pick. `--serve` adds a page plus the `/ws` agent feed; `--draft` points it at any draft id, e.g. a mock, to rehearse |

Every command takes `--json` / `--format yaml\|md\|jsonl`, and `ff --mcp` serves
the whole CLI as an MCP server.

## Using it with an agent

This is built to be driven from a Claude Code session: the CLI is the sensor, the
agent is the decision-maker. On draft night one person clicks in sleeper.com while
the agent calls every pick off the board.

- **[`CLAUDE.md`](CLAUDE.md)** — the operating manual. What to run and in what
  order, from a fresh clone through to draft day. An agent opening this repo reads
  it automatically; it's worth a human read too.
- **[`docs/live-draft.md`](docs/live-draft.md)** — the draft-night runbook. The
  clock, the endpoints, calling picks unambiguously, and what to do when the
  commissioner pauses or rewinds.

Starting cold, this is enough:

> Read CLAUDE.md, then run `bun ff --llms`, `bun ff league` and `bun ff roster`.
> My draft is Thursday — walk me through the prep.

## What it reads and writes

Worth knowing before running someone else's tooling on your machine:

- **Reads:** Sleeper's public REST API (`api.sleeper.app`, `api.sleeper.com`) —
  unauthenticated, no account linkage, the same data the website serves.
  Optionally [the-odds-api.com](https://the-odds-api.com) if you set `ODDS_API_KEY`.
- **Writes:** `.cache/` in the repo (player DB, odds, meta crawl) and
  `scripts/report/out/` if you generate a report. Both gitignored.
- **Sends nothing anywhere.** No telemetry, no account, no server. It cannot make
  a pick, a claim, or a lineup change — there is no write path to Sleeper at all.
- **`--serve` opens a port on `0.0.0.0`**, so anyone on your network or tailnet can
  load the draft board while it runs. Deliberate (draft from a laptop, serve from a
  desktop), but it's the one outward-facing thing here.

## Layout

```
src/sleeper.ts  Sleeper API client, player DB cache, league-shape parsing
src/ff.ts       CLI: every command definition
src/proj.ts     season projections re-scored under your rules → VORP, tiers, the board
src/draft.ts    live draft state, the served page, the /ws agent feed
src/mock.ts     Monte Carlo of the remaining draft → pick plan
src/value.ts    re-score real seasons under your rules → positional baselines, VORP
src/odds.ts     the-odds-api → consensus spreads/totals → implied team totals
src/meta.ts     crawl similar public leagues, study how they were won
src/profile.ts  per-opponent draft profiling vs corpus ADP
scripts/report/ post-draft power-rankings page (roster scoring + HTML generator)
docs/           the draft-night runbook
```

The ~5MB player DB refreshes daily — Sleeper asks for at most one fetch per day —
and odds responses hold for 6h.

Requires [Bun](https://bun.sh), plus `python3` for the report generator only. No
build step, no test suite.

## Known limits

- **Kicker projections are understated.** Sleeper's feed carries no FG 0–39
  buckets, so kicker totals come in ~10–20 points light. It's uniform, so the
  ranking within kickers is fine.
- **DEF rows in the projection feed are stubs** — the per-stat breakdown is empty,
  so the published total is used directly rather than re-scored.
- **Sleeper's "steal"/"reach" labels are pure ADP distance**, not value. The board
  will disagree, and that disagreement is the point.
- **The board has no ADP-vs-current-pick column** — it shows ADP and the board's
  disagreement with it, but not "how far past their ADP are we right now".
- **`ff value` uses the weekly stats endpoints** (the season-total endpoint is
  broken upstream). Join on player id, never name — there are two Josh Allens.
- **No write path.** Everything reads. Making a pick means clicking in Sleeper.
  There's no official write API; the app's own realtime gateway needs the session
  token from a logged-in browser and isn't part of this repo.
- **No realtime stream**, so `ff live` polls once a second — well inside Sleeper's
  limits and fast enough for a 30-second clock.
- **Draft rewinds need pick+player keying**, or a watcher goes silent on the
  replacements. See [docs/live-draft.md](docs/live-draft.md).
- **No tests.** The engine is verified by reading its output, which is exactly as
  reassuring as it sounds.

## License

MIT — see [LICENSE](LICENSE).
