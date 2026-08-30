# fantasy

Fantasy football decision tooling for Sleeper leagues. Read-only, no build step,
one dependency. Ships as a CLI that is equally usable by a human and an agent
(`--json`, `--llms`, `--mcp` come free via [incur](https://github.com/wevm/incur)).

Built for The Ballers Fantasy League (2026), but every league-specific value is
an env var — point it at your own league and everything works.

## Quickstart

```sh
bun install
bun ff league        # your league's rules, decoded
bun ff --help        # every command
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

Every command takes `--json` / `--format yaml\|md\|jsonl` for machines, and
`ff --mcp` serves the whole CLI as an MCP server.

## How it works

Two ideas:

1. **Take the market, don't beat it.** Vegas lines and consensus projections are
   the prediction layer. This repo never models raw player performance.
2. **The edge is in decisions, not predictions.** Translate market data through
   *your exact league rules* (VORP, tiers, FAAB bids) and allocate under real
   constraints — roster slots, a $100 budget, a 30-second pick clock.

## Layout

```
src/sleeper.ts  Sleeper API client + player DB cache (env var contract lives here)
src/ff.ts       CLI: every command definition
src/value.ts    re-score real seasons under your rules → positional baselines, VORP
src/odds.ts     the-odds-api → consensus spreads/totals → implied team totals
src/meta.ts     crawl similar public leagues, study how they were won
src/profile.ts  per-opponent draft profiling vs corpus ADP
```

Caches (`.cache/`, gitignored): the ~5MB player DB refreshes daily — Sleeper asks
for at most one fetch per day — and odds responses hold for 6h.

Requires [Bun](https://bun.sh). No build, no test suite yet.
