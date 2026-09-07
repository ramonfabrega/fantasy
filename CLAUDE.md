# fantasy

Fantasy NFL ops for a Sleeper league, played as a team: one human + Claude. The
premise is that you can know nothing about the NFL and still win, via tooling,
freshness, and zero mistakes — against opponents who know plenty but are running
on vibes and a phone notification.

> **New agent in a fresh clone, start here.** Run `bun ff --llms` — the command
> manifest is generated from the command definitions, so it is the one description
> of this CLI that cannot go stale. Nothing needs auth except `ff odds`.
>
> **Then verify what you're pointed at, before computing anything:**
>
> ```sh
> bun ff league    # is this the RIGHT league? name, scoring, roster slots
> bun ff roster    # does "our team" resolve to a real roster?
> ```
>
> Every number this repo produces is derived from that league's scoring and
> roster construction, so if `ff league` is the wrong league, everything after it
> is confidently wrong rather than obviously broken. If `ff roster` says *no such
> owner*, `FF_USER_ID`/`FF_USERNAME` in `.env` aren't set to this user — fix that
> before drafting anything. Don't work around either; say so and stop.
>
> Then read **`docs/live-draft.md`** — the draft-night runbook. It is the part of
> this repo that actually won a draft, and it is not derivable from the code.
>
> **The league is whatever `bun ff league` prints.** Identity lives in `.env`
> (`FF_LEAGUE_ID`, `FF_USER_ID`, `FF_USERNAME`), not in this file — never hardcode
> a league id anywhere.
>
> **Everything down to *This instance* is general** and applies to any league.
> The section at the bottom describes the specific league this checkout is
> configured for; on a fork, delete it and write your own.

## Doctrine

- **Market-takers, not market-makers.** Vegas lines + consensus projections are the
  prediction layer; never model raw player performance. The layer we add is
  *decisions*: translate market data through this league's exact rules (VORP,
  tiers, FAAB bids) and allocate under its real constraints — roster slots, the
  FAAB budget, the pick clock.
- **The edge is being unbiased and awake**: no sunk cost, no fandom, no narrative;
  full free-agent-pool coverage; hot windows are Wed–Sat (practice reports,
  waivers) and Sunday ~90 min pre-kickoff (inactives → lineup seatbelt).
- **Claude decides** (draft picks, waiver bids, start/sit); tooling exists to make
  those decisions instant and fully informed. Read-only first; write automation
  needs the account owner's session token and comes later, on a trust ramp.
- **Confidently wrong beats obviously broken — badly.** Prefer an error to a
  plausible number. This applies to league config, to baselines, and to anything
  read from a stale cache.

## Operating manual

The sequence, from a fresh clone to draft night. Steps 1–2 are one-time, 3–4 are
the week before, 5 is the night itself.

### 1. Point it at the league, and verify

```sh
bun install
cp .env.example .env      # FF_LEAGUE_ID + FF_USER_ID + FF_USERNAME, all three
bun ff league             # the engine's definition: scoring + roster slots
bun ff roster             # proves "our team" resolves
```

Everything downstream — VORP baselines, flex allocation, FAAB sizing — derives
from what `ff league` prints. Wrong league, and the output is confidently wrong
rather than obviously broken. `ff roster` is what catches a half-filled `.env`.

### 2. Homework (once, any time before the draft)

```sh
bun ff scout              # this league's past season: records, draft habits, FAAB
bun ff study              # how that season was won: round ROI, waiver gold
bun ff meta crawl         # harvest similar public leagues (slow; once)
bun ff meta study         # what wins across the corpus, not just this league
bun ff meta adp           # corpus ADP — `ff profile` requires this
bun ff profile            # per-opponent: who reaches, who waits, who hoards
```

Order matters — `meta study` and `meta adp` read what `meta crawl` harvested, and
`ff profile` measures opponents against `meta adp`'s output. Run out of order and
each will name the step that's missing.

The point isn't the numbers, it's the priors: which rounds decide the season in
*this* format, and which specific opponents take a QB early enough to matter.
Write the conclusions into memory — they're needed on a night when there's no time
to re-derive them.

### 3. Build the board

```sh
bun ff board                     # rankings under this league's rules
bun ff board --pos RB --available
bun ff mock --sims 300           # simulate the rest of the draft → pick plan
```

`ff board` values every player two ways: VORP over the starter replacement (flex
slots allocated jointly across the eligible positions, so RB and WR baselines move
together) and half-weighted value over the draft-end waiver baseline. Tiers come
from real gaps in the curve.

`ff mock` is what to plan from — it returns, per pick, who is *likely to still be
there*, which is the only question that matters at a given slot.

### 4. Rehearse against a mock draft — do not skip

```sh
bun ff live --draft <mock_draft_id> --serve 4242
```

Start a mock on Sleeper, take the draft id from the URL, run the entire setup
against it. This is where an ambiguous pick-call format or a too-slow watcher
surfaces at zero cost. The pick-call format below exists because a rehearsal
caught a name-only call selecting the wrong player in Sleeper's search.

### 5. Draft night

Full runbook: **`docs/live-draft.md`**. Read it before the draft, not during.

The short version — `bun ff live --serve 4242` running, agent attached to
`ws://localhost:4242/ws` via the `Monitor` tool (`ws` source, `persistent: true`),
Sleeper's draft room open in a browser for the human to click.

- **Call picks as `Player, POS TEAM` with two fallbacks.** Never a bare name.
- **Snake picks come in pairs** — queue both at the first of each pair.
- **Read the pick timer live at draft start.** It is mutable, including mid-draft,
  and a finished draft object reports what it ended at, not what it ran under.
- `ff board` and `ff mock` are *preparation*. Under the clock there is no time to
  run anything; the only live reads are `/ws` and `/data`.
- The served HTML page went essentially unused in the draft it was built for. The
  server does the work; the conversation is the interface.

### 6. After

```sh
bun scripts/report/postdraft.ts && python3 scripts/report/build_report.py
```

Scores every roster in the league and renders a standalone power-rankings page.

## Stack

Bun + TypeScript + [incur](https://github.com/wevm/incur) (agent-first CLI framework;
TOON output, `--json`, `--mcp`, `--llms` for free). No build step — `bun src/ff.ts`.
Prefer Bun natives (`Bun.file`, `bun:sqlite`, `Bun.serve`) over npm equivalents.

## CLI

`bun ff <cmd>` (or `bun src/ff.ts <cmd>`): `state`, `league`, `members`, `roster
[owner]`, `draft`, `picks`, `trending [add|drop]`, `player <query>`, `matchups
[week]`, `scout [--league id]`, `study`, `value`, `odds`, `meta crawl|study|adp`,
`profile`, `board`, `mock`, `live [--serve port] [--draft id]`. All read-only.
Post-draft league report: `scripts/report/` (`postdraft.ts` then `build_report.py`).
Sleeper (`api.sleeper.app/v1`) needs no auth; only `odds` needs a key. Player DB
(~5MB) caches to `.cache/players.json` for 24h — Sleeper asks max 1 fetch/day;
odds cache 6h.

League identity is env-configurable (`FF_LEAGUE_ID`, `FF_USER_ID`, `FF_USERNAME`
in `src/sleeper.ts`, defaulting to the maintainer's league) so the repo works as a
base for anyone else's — see `.env.example` and README. Keep it that way: **no new
hardcoded league IDs, and no new hardcoded league SHAPE.** Scoring comes from
`scoring_settings`; teams/starters/flex come from `leagueShape()` in
`src/sleeper.ts` (`roster_positions` + `total_rosters`). If you need "12 teams"
or "2 RB" in a calculation, take it from the `Shape`, never a literal — a
hardcoded shape produces confidently wrong numbers in someone else's league,
which is worse than failing.

## What's built

1. ✅ **Sleeper read layer** (`ff`) — league, rosters, members, matchups, draft, picks.
2. ✅ **History mining** (`ff scout`, `ff study`) and a wider corpus
   (`ff meta crawl|study`) — how seasons are actually won, not how they're discussed.
3. ✅ **Value engine** (`ff value`) — real seasons re-scored under the league's rules.
   Weekly stats endpoints only; the season-total endpoint is broken upstream, and
   names collide across eras (two Josh Allens), so always join on player id.
4. ✅ **Vegas layer** (`ff odds`) — the-odds-api, key in `.env` (free tier 500
   credits/mo, a spreads+totals call costs 2, cached 6h).
5. ✅ **Projections/ADP feed** (`src/proj.ts`) — Sleeper
   `api.sleeper.com/projections/nfl/<season>` (rotowire, unauth, ~daily, cached 1h):
   per-stat season projections re-scored under the league's rules, plus
   `adp_half_ppr` (what opponents see in their draft room) and injury status. DEF
   rows are stubs → use the published total. FantasyPros not needed.
6. ✅ **Board** (`ff board`) — value = max(starter VORP with the league's flex slots
   allocated jointly across the eligible positions, half-weighted bench value over
   the draft-end baseline); gap-based tiers; the recommender applies doctrine as
   need multipliers (late QB, one TE, K/DEF only in the last two rounds, flagged
   players discounted rather than hidden).
7. ✅ **Live draft assistant** (`ff live [--serve port]`) + planner (`ff mock`) —
   polls picks, recomputes best-available for our next pick with gone-by-then odds.
   Proven in a real draft; what carried it was the `/ws` agent feed and `/data`,
   not the served page. Runbook: `docs/live-draft.md`.
8. ✅ **Post-draft league report** (`scripts/report/`) — every roster scored under
   the league's rules, rendered as a standalone power-rankings page.

## Roadmap

9. **In-season loop**: waiver evaluator + FAAB sizing, start/sit, Sunday inactives
   seatbelt.
10. **Write automation** (FA sniping, lineup fixes) after a trust ramp. Realtime
    findings: Sleeper is Phoenix; the data socket is
    `wss://gateway.sleeper.com/socket/websocket` with topics `draft:<id>`,
    `league:<id>`, `user:<id>`, `score:nfl`, and it needs the app session token as
    a `token=` query param. There is no anonymous stream — the 1s REST poll in
    `ff live` is the feed.

## This instance (delete on fork)

Everything above is general. Below is the specific league this checkout points at.

### League facts (The Ballers, 2026)

Half-PPR, 12 teams, $350 buy-in, snake draft (15 rds, autopick on), roster
1QB/2RB/2WR/1TE/1FLEX/1K/1DEF + 6 BN, FAAB $100 clearing Wed, playoffs top-6 wk 15,
median match ON (two W/L per week — floor/consistency matters), IR is COVID-only
(useless), redraft. Eleven opponents, all IRL friends, whose idea of fun is beating
us. League history: previous_league_id chain → the 2025 season is minable (`ff scout`).

**Pick timer, 2026:** configured 30s → raised to 90s on draft morning → dropped
back to 30s mid-draft in the bench rounds. A finished draft object reports what it
ended at, so read it live at draft start.

### How it's gone

- 2026 draft (slot 2): 15/15 picks landed as called, no autopicks, through two
  commissioner pauses and one rewind.
- `ff meta crawl` harvested 1,886 similar leagues; findings in `league-meta-2025.md`.
- The post-draft report was shared with the league; the intent is to republish it
  weekly in-season.

### Session memory (not in this repo)

Deeper notes live in the maintainer's Claude session memory, not here:
`sleeper-league.md` (IDs), `league-meta-2025.md` (how last season was won across
the corpus), `opponent-book.md` (per-opponent scouting), `draft-2026-result.md`
(the 15 picks and how the room drafted), `draft-day-flow.md` (command-center
setup). A fork regenerates the equivalents with `ff scout`, `ff study`,
`ff meta crawl|study|adp`, and `ff profile`.
