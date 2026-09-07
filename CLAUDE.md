# fantasy

Fantasy NFL ops for **The Ballers Fantasy League** (Sleeper, 2026 season, $350 buy-in).
Team = Ramon + Claude. We know nothing about the NFL and don't care; we win via
tooling, freshness, and zero mistakes. The league is 11 sweaty IRL friends whose
idea of fun is beating us.

> **New agent in a fresh clone, start here.** Run `bun ff --llms` — the command
> manifest is generated from the command definitions, so it is the one description
> of this CLI that cannot go stale. Then `bun ff league` for the live rules.
> Nothing needs auth except `ff odds`.
>
> Then read **`docs/live-draft.md`** — the draft-night runbook. It is the part of
> this repo that actually won a draft, and it is not derivable from the code.
>
> **The league is whatever `bun ff league` prints.** Identity lives in `.env`
> (`FF_LEAGUE_ID`, `FF_USER_ID`, `FF_USERNAME`), not in this file — never hardcode
> a league id anywhere.
>
> **If this is a fork, not Ramon's checkout:** everything above the fold —
> Doctrine, Stack, CLI — is general and worth keeping. Everything under
> *The Ballers instance* at the bottom is ours: delete it and write your own. The
> `.md` files it references (`sleeper-league.md`, `league-meta-2025.md`,
> `opponent-book.md`) are **not in this repo** — they live in Ramon's Claude
> session memory. Don't go looking for them; regenerate the equivalents for your
> own league with `ff scout`, `ff study`, and `ff profile`.

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

## Stack

Bun + TypeScript + [incur](https://github.com/wevm/incur) (agent-first CLI framework;
TOON output, `--json`, `--mcp`, `--llms` for free). No build step — `bun src/ff.ts`.
Prefer Bun natives (`Bun.file`, `bun:sqlite`, `Bun.serve`) over npm equivalents.

## CLI

`bun ff <cmd>` (or `bun src/ff.ts <cmd>`): `state`, `league`, `members`, `roster
[owner]`, `draft`, `picks`, `trending [add|drop]`, `player <query>`, `matchups
[week]`, `scout [--league id]`, `study`, `value`, `odds`, `meta crawl|study|adp`,
`profile`, `board`, `mock`, `live [--serve port] [--draft id]`. All read-only.
Post-draft league report: `scripts/report/` (`postdraft.ts` then `build_report.py`). Sleeper (`api.sleeper.app/v1`) needs no auth; only
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
5. ✅ Projections/ADP feed (`src/proj.ts`) — Sleeper `api.sleeper.com/projections/nfl/<season>`
   (rotowire, unauth, ~daily refresh, cached 1h): per-stat season projections re-scored
   under our rules + `adp_half_ppr` (what opponents see in their draft room) + injury
   status. DEF rows are stubs → use the published total. FantasyPros not needed.
6. ✅ Board (`ff board`) — value = max(starter VORP with the 12 flex slots allocated
   jointly across RB/WR/TE, half-weighted bench value over the draft-end baseline);
   gap-based tiers; recommender applies doctrine as need multipliers (late QB, one
   TE, K/DEF only in the last two rounds, flagged players discounted not hidden).
7. ✅ Live draft assistant (`ff live [--serve port]`) + planner (`ff mock`): polls picks,
   recomputes best-available for OUR next pick with gone-by-then odds. **Used for real
   on 2026-09-02: 15/15 picks landed as called, no autopicks, through two pauses and a
   rewind.** What carried it was the `/ws` agent feed + `/data`, not the served page —
   the conversation was the interface. Runbook: `docs/live-draft.md`.
7b. ✅ Post-draft league report (`scripts/report/`): every roster scored under our rules,
   rendered as a standalone power-rankings page. Ramon wants this weekly in-season.
8. In-season loop: waiver evaluator + FAAB sizing, start/sit, Sunday inactives seatbelt
9. Write automation (FA sniping, lineup fixes) after trust ramp. Realtime findings
   (2026-09-02): Sleeper is Phoenix; data socket `wss://gateway.sleeper.com/socket/websocket`
   needs the app session token (`token=` query param), topics `draft:<id>`, `league:<id>`,
   `user:<id>`, `score:nfl`. No anonymous stream — the 1s REST poll in `ff live` is the feed.

## The Ballers instance (delete on fork)

Everything above is general — doctrine, stack, CLI, roadmap. Everything below is
our specific league, and is what a fork replaces.

### League facts (2026)

Half-PPR, 12 teams, snake draft (15 rds, **pick timer is mutable: configured 30s,
raised to 90s on 2026 draft morning, dropped back to 30s mid-draft in the bench
rounds** — a finished draft object reports what it ended at, not what it ran
under, so read it live at draft start), autopick on, roster
1QB/2RB/2WR/1TE/1FLEX/1K/1DEF + 6 BN, FAAB $100 clearing Wed, playoffs top-6 wk 15,
median match ON (two W/L per week — floor/consistency matters), IR is COVID-only
(useless), redraft. IDs and deeper notes live in session memory (`sleeper-league.md`).
League history: previous_league_id chain → 2025 season is minable (`ff scout`).

### Session memory (not in this repo)

Deeper notes live in Ramon's Claude session memory, not here: `sleeper-league.md`
(IDs), `league-meta-2025.md` (how last season was won across 1,886 similar
leagues), `opponent-book.md` (per-Baller scouting), `draft-2026-result.md` (our
15 picks and how the room drafted). A fork regenerates the equivalents with
`ff scout`, `ff study`, `ff meta crawl|study|adp`, and `ff profile`.
