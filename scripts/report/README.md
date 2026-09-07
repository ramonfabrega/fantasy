# Draft / power-rankings report

Scores every roster in the league under your league's rules and renders a
standalone HTML page: projected starting lineups, who drafted best against par,
steals and reaches, positional runs.

Built for the 2026 post-draft report and kept as the base for a weekly
power-rankings page.

## Run it

```sh
bun scripts/report/postdraft.ts        # → out/postdraft.json + out/avatars.json
python3 scripts/report/build_report.py # → out/<league>-draft-report.html
```

Run both from the repo root. The output is one self-contained HTML file with no
external requests — avatars are fetched from `sleepercdn.com` and inlined as data
URIs, because artifact/CSP hosting blocks external images. A team with no Sleeper
avatar falls back to initials, and if `avatars.json` is missing entirely the page
still builds.

Everything comes from your configured league (`FF_LEAGUE_ID`) — team count, round
count, draft date and the bar scale are all derived from the data, so this works
for any league without editing the generator.

If you change `postdraft.ts`, run `bunx tsc --noEmit` before publishing. It builds
one big object literal, and a duplicate key there is silently legal JavaScript —
the later one wins and the earlier value vanishes without a runtime error. That
exact bug shipped here once (`teams` was both the team count and the team array,
so the count never reached the report). `tsc` catches it as TS1117; nothing else
will.

## What the numbers mean

- **lineupPts** — projected points of the best legal starting lineup, with empty
  slots credited at waiver-replacement level. This is the power ranking, and it
  rewards having drawn a good draft slot.
- **valOverPar** — value captured against what each pick position was "worth"
  (the board's Nth-best player at pick N, floored at zero). This is slot-neutral:
  it measures drafting, not luck of the draw.
- **steal / reach** — a pick's value minus par. Note this is *the board's* opinion,
  which is not the same as Sleeper's steal/reach labels (those are pure ADP
  distance).

One honest caveat, kept in the page itself: the board is one team's own draft aid,
so "who drafted best" measures agreement with those rankings, not objective truth.

The 2026 edition was published at
https://claude.ai/code/artifact/1f659510-5c7b-433f-95e2-1f05a675cc8c
