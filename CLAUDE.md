# fantasy

Fantasy NFL ops for **The Ballers Fantasy League** (Sleeper, 2026 season, $350 buy-in).
Team = Ramon + Claude. We know nothing about the NFL and don't care; we win via
tooling, freshness, and zero mistakes. The league is 11 sweaty IRL friends whose
idea of fun is beating us.

## Doctrine

- **Market-takers, not market-makers.** Vegas lines + consensus projections are the
  prediction layer; we never model raw player performance. Our layer is *decisions*:
  translate market data through our exact league rules (VORP, tiers, FAAB bids) and
  allocate under constraints (roster slots, $100 budget, 30-second draft clock).
- **Our edge is being unbiased and awake**: no sunk cost, no fandom, no narrative;
  full free-agent-pool coverage; hot windows are Wed–Sat (practice reports, waivers)
  and Sunday ~90 min pre-kickoff (inactives → lineup seatbelt).
- **Claude decides** (draft picks, waiver bids, start/sit); tooling exists to make
  those decisions instant and fully informed. Read-only first; write automation
  (unofficial Sleeper GraphQL, needs Ramon's auth token) comes later with a trust ramp.

## League facts (2026)

Half-PPR, 12 teams, snake draft (15 rds, **30s pick timer**, autopick on), roster
1QB/2RB/2WR/1TE/1FLEX/1K/1DEF + 6 BN, FAAB $100 clearing Wed, playoffs top-6 wk 15,
median match ON (two W/L per week — floor/consistency matters), IR is COVID-only
(useless), redraft. IDs and deeper notes live in session memory (`sleeper-league.md`).
League history: previous_league_id chain → 2025 season is minable (`ff scout`).

## Stack

Bun + TypeScript + [incur](https://github.com/wevm/incur) (agent-first CLI framework;
TOON output, `--json`, `--mcp`, `--llms` for free). No build step — `bun src/ff.ts`.
Prefer Bun natives (`Bun.file`, `bun:sqlite`, `Bun.serve`) over npm equivalents.

## CLI

`bun ff <cmd>` (or `bun src/ff.ts <cmd>`): `state`, `league`, `members`, `roster
[owner]`, `draft`, `picks`, `trending [add|drop]`, `player <query>`, `matchups
[week]`, `scout [--league id]`. All read-only against `api.sleeper.app/v1` (no auth).
Player DB (~5MB) caches to `.cache/players.json` for 24h — Sleeper asks max 1 fetch/day.

## Roadmap

1. ✅ Sleeper read layer (`ff`)
2. Draft-date poller (start_time is null until commish schedules) + opponent profiles
3. Data feeds: odds API (needs key from Ramon), consensus projections, ADP
4. VORP/tier engine tuned to our scoring → draft board (must be glanceable in <30s)
5. Live draft assistant (poll `ff picks`, recompute best-available by tier)
6. In-season loop: waiver evaluator + FAAB sizing, start/sit, Sunday inactives seatbelt
7. Write automation (FA sniping, lineup fixes) after trust ramp
