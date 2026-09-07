# Running a live draft

The runbook for draft night, written after using it for a real 15-round snake
draft on a 30-second clock: 15 of 15 picks landed as called, no autopicks, no
misclicks, through two commissioner pauses and one rewind.

The README's [The flow](../README.md#the-flow) covers the week leading up to this.
This page is only about the two hours themselves.

## The shape of it

The thing that wins the draft is not the board. It's that a decision arrives
before the clock does, every single time, and that nobody has to think under
pressure. The setup below exists to make that true.

Three components:

| | what it is | who reads it |
| --- | --- | --- |
| **sleeper.com draft room** | the only thing that can actually make a pick | you, clicking |
| **`ff live --serve 4242`** | polls Sleeper 1×/sec, serves `/data`, `/events`, `/ws` | the agent |
| **a Claude Code session** | watches `/ws`, decides, says the name out loud | you, reading |

Note what is *not* in that table: the served HTML page. See
[The dashboard question](#the-dashboard-question).

## Setup, in order

```sh
# 1. rules and board are fresh
bun ff league
bun ff board --fresh --top 60
bun ff mock --sims 300          # the pick plan for your slot

# 2. start the server (leave it running all night)
bun ff live --serve 4242
```

Then, in the Claude Code session, attach the agent feed with the `Monitor` tool:

```
source: ws
url: ws://localhost:4242/ws
persistent: true
```

`--serve` binds `0.0.0.0`, so if you run the server on a desktop and draft from a
laptop, `http://<host>:4242/` works over your tailnet.

### Rehearse against a mock first

Start a mock draft on Sleeper, take the draft id out of the URL, and run the
entire setup against it:

```sh
bun ff live --draft 1400974557115883520 --serve 4242
```

Do this. It is the only way to find out that something in your flow is ambiguous
while it's still free. The pick-call format below exists because a rehearsal
caught a name-only call selecting the wrong player in Sleeper's search box.

## The endpoints

`ff live --serve` exposes four things:

- **`/`** — the HTML board. Optional; see below.
- **`/events`** — SSE stream, one message per state change. What the page uses.
- **`/data`** — the current state as JSON, on demand. What the agent actually used.
- **`/ws`** — the agent feed. Deliberately quiet: it emits *only* a heads-up three
  picks out, your pick (with the top 12 off the board), status changes, and errors.
  Nothing else. It exists so the agent is woken by events instead of polling.

`/data` is worth knowing well. During the draft, the highest-value single command
was a plain read of it:

```sh
curl -s localhost:4242/data | python3 -m json.tool
```

**`/data`'s `recent` is a short window, not the full pick list.** For complete pick
history — checking what a specific opponent has taken, reconstructing after a
rewind — go to Sleeper directly:

```sh
curl -s "https://api.sleeper.app/v1/draft/<draft_id>/picks"
```

## Calling picks

**Always `Player, POS TEAM`. Never a bare name.** Sleeper's search will surface a
different person with a similar name and you will click it under a 30-second
clock. Position and team make it unambiguous.

**Always give two fallbacks.** The pick you want may go one slot before you.
Deciding the fallback in advance is the whole game; deciding it in eight seconds
is how mistakes happen.

**In a snake draft your picks come in pairs.** From slot 2 in a 12-team league:
23/26, 47/50, 71/74. Queue both names at the first pick of the pair. The second
name is nearly always the plan for the second pick, because the room only moves
so far in four selections.

**Push back on the board.** The most useful turns on the night were the human
asking "another RB?" and "are we sure?" — the board optimizes marginal lineup
points and doesn't know what you're comfortable rostering. A board that can't
survive one question shouldn't be trusted with the pick.

## Pauses, rewinds, and other reality

Real drafts are not clean. Expect at least one of these:

- **Commissioner pause.** The server keeps polling; `status` goes to `paused`.
  Sleeper's own status change reaches the server a few seconds late on resume, so
  don't treat the first post-resume reading as authoritative.
- **Rewind.** A commissioner can roll the draft back and re-run picks. This is the
  case that breaks naive watchers: if you key events on *pick number* alone, a
  rewind re-emits picks you've already seen and the watcher stays silent on the
  replacements. **Key on `pick + player`**, so a changed pick at the same number
  reads as new. We hit this at pick 77 and had to swap the watcher mid-draft.
- **A disconnected drafter.** Autopick covers them, and autopicked players come off
  ADP — which makes the room's next few picks *more* predictable, not less.

A belt-and-braces option that worked well: alongside the `/ws` Monitor feed, run a
plain shell loop polling `/data` every 3 seconds and printing each new pick. It's
redundant by design, it's rewind-safe when keyed correctly, and it costs nothing.

## The dashboard question

`ff live --serve` renders an HTML board meant to sit beside the Sleeper draft room.
In the draft it was written for, essentially nobody looked at it. The agent never
loaded the page once — it read `/data` and `/ws` — and the human's questions during
the draft ("I don't see him as #1 on Sleeper") place him on Sleeper's UI, not on the
board.

That is not a bug in the page. It's what the tool actually is: **the server is the
engine's HTTP face, and the conversation is the interface.** The value was in a
decision arriving 3 picks early, phrased unambiguously, with a fallback — and that
arrives through the agent, not through a screen you'd have to look away to read.

So: run `--serve` (the server does the work), and treat the page as optional. It's
genuinely useful for letting someone else follow along, and as a rehearsal aid. If
you're only setting up one thing, set up the `/ws` feed.

## Checklist

- [ ] `bun ff league` — rules are right
- [ ] `bun ff board --fresh` — projections are current
- [ ] `bun ff mock --sims 300` — pick plan for your slot
- [ ] server running; `curl -s localhost:4242/data` returns state
- [ ] agent attached to `ws://localhost:4242/ws`
- [ ] a second watcher on `/data`, keyed on **pick + player**
- [ ] your slot and your first three pick numbers, written down
- [ ] pick-call format agreed: `Player, POS TEAM` + two fallbacks
- [ ] rehearsed against a mock draft

## Afterwards

```sh
bun scripts/report/postdraft.ts
python3 scripts/report/build_report.py
```

Scores every roster in the league under your rules and renders a standalone
power-rankings page — projected lineups, who drafted best against par, steals,
reaches, positional runs. Sharing it with the league is optional but recommended;
it is the single cheapest way to make eleven people care about your tooling.
