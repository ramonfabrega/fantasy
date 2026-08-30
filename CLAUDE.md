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
[week]`, `scout [--league id]`, `study`, `value`, `odds`, `meta crawl|study`,
`profile`. All read-only. Sleeper (`api.sleeper.app/v1`) needs no auth; only
`odds` needs a key. Player DB (~5MB) caches to `.cache/players.json` for 24h —
Sleeper asks max 1 fetch/day; odds cache 6h.

League identity is env-configurable (`FF_LEAGUE_ID`, `FF_USER_ID`, `FF_USERNAME`
in `src/sleeper.ts`, defaulting to ours) so the repo works as a base for someone
else's league — see `.env.example` and README. Keep it that way: no new hardcoded
league IDs.

## Roadmap

1. ✅ Sleeper read layer (`ff`)
2. ✅ History mining (`ff scout`, `ff study`) + greater corpus (`ff meta crawl/study`,
   1,886 similar leagues harvested; findings in memory `league-meta-2025.md`)
3. ✅ Value engine (`ff value`) — real seasons re-scored under our rules; weekly
   stats endpoints only (season-total endpoint is broken; two-Josh-Allens ID hazard)
4. ✅ Vegas layer (`ff odds`) — the-odds-api key lives in `.env` (gitignored,
   free tier 500 credits/mo, calls cost 2, cached 6h; ask Ramon if lost)
5. Projections/ADP feeds (Sleeper `/projections/nfl/...` + FantasyPros) as draft nears
6. VORP/tier engine → draft board (must be glanceable in <30s picks)
7. Live draft assistant (poll `ff picks`, recompute best-available by tier)
8. In-season loop: waiver evaluator + FAAB sizing, start/sit, Sunday inactives seatbelt
9. Write automation (FA sniping, lineup fixes) after trust ramp

A session cron (twice daily) watches for draft scheduling + Ramon's roster
assignment; re-arm it if the session restarts (7-day expiry).
