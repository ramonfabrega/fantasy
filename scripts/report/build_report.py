import json, html
T = 'scripts/report/out/'
d = json.load(open(T + 'postdraft.json'))
av = json.load(open(T + 'avatars.json'))
teams = d['teams']
esc = html.escape
SK = ('QB', 'RB', 'WR', 'TE')
def skill(p): return p['pos'] in SK
allp = [dict(p, owner=t['owner'], teamName=t['teamName']) for t in teams for p in t['picks']]
median = sorted(t['lineupPts'] for t in teams); median = (median[5] + median[6]) / 2
LO, HI = 1550, 1750

# position ranks (1 = best) per team for QB RB WR TE FLEX
posr = {}
for pos in ['QB', 'RB', 'WR', 'TE', 'FLEX']:
    order = sorted(teams, key=lambda t: -t['posPts'].get(pos, 0))
    for i, t in enumerate(order): posr.setdefault(t['owner'], {})[pos] = i + 1

# superlatives
steal = max((p for p in allp if skill(p)), key=lambda p: p['steal'])
reach = min((p for p in allp if skill(p) and p['pick'] <= 96), key=lambda p: p['steal'])
bargain = min((p for p in allp if p['adpEdge'] is not None and skill(p)), key=lambda p: p['adpEdge'])   # fell furthest past ADP
offmkt = max((p for p in allp if p['adpEdge'] is not None and skill(p)), key=lambda p: p['adpEdge'])    # taken furthest ahead of ADP
fragile = max(teams, key=lambda t: len(t['flagged']))
deep = max(teams, key=lambda t: t['benchVal'])
nodef = [t for t in teams if not any(l['slot'] == 'DEF' and l['player'] != '—' for l in t['lineup'])]
qbs = d['runs']['QB']; tes = d['runs']['TE']; defs = d['runs']['DEF']; ks = d['runs']['K']

def avatar(t, size=36):
    src = av.get(t['owner'])
    if src: return f'<img class="av" src="{src}" alt="" width="{size}" height="{size}">'
    return f'<span class="av av-txt" style="width:{size}px;height:{size}px">{esc(t["owner"][:2].upper())}</span>'

def chip(pos):
    k = pos if pos in SK else 'X'
    return f'<span class="chip p-{k}">{esc(pos)}</span>'

def pname(p): return esc(p['player'])

# ---- sections
rows = []
for t in teams:
    w = max(0, min(1, (t['lineupPts'] - LO) / (HI - LO))) * 100
    dm = t['lineupPts'] - median
    dms = f'{dm:+.0f}'
    pr = posr[t['owner']]
    cells = ''.join(f'<span class="pr {"top" if pr[k] <= 3 else "low" if pr[k] >= 10 else ""}"><i>{k}</i>{pr[k]}</span>' for k in ['QB', 'RB', 'WR', 'TE', 'FLEX'])
    rows.append(f'''<li class="row {'first' if t['rank'] == 1 else ''}">
  <span class="rk">{t['rank']}</span>
  {avatar(t, 32)}
  <span class="who"><b>{esc(t['teamName'])}</b><small>{esc(t['owner'])}</small></span>
  <span class="bar"><span class="fill" style="width:{w:.1f}%"></span></span>
  <span class="pts">{t['lineupPts']:,}<small>{dms}</small></span>
  <span class="prs">{cells}</span>
</li>''')

def sup(label, big, sub):
    return f'<div class="sup"><span class="lbl">{label}</span><b>{big}</b><span class="sub">{sub}</span></div>'
sups = [
    sup('Steal of the draft', f'{pname(steal)}', f'Pick {steal["pick"]} · {esc(steal["owner"])} · {steal["steal"]:+d} over par'),
    sup('Reach of the draft', f'{pname(reach)}', f'Pick {reach["pick"]} · {esc(reach["owner"])} · {reach["steal"]:+d} vs par (first 8 rounds)'),
    sup('Fell the furthest', f'{pname(bargain)}', f'Pick {bargain["pick"]}, ADP {bargain["adp"]:.0f} · {esc(bargain["owner"])}'),
    sup('Taken furthest ahead of ADP', f'{pname(offmkt)}', f'Pick {offmkt["pick"]}, ADP {offmkt["adp"]:.0f} · {esc(offmkt["owner"])}'),
    sup('Most fragile lineup', ' & '.join(esc(t['teamName']) for t in teams if len(t['flagged']) == len(fragile['flagged'])), f'{len(fragile["flagged"])} starters flagged Questionable'),
    sup('Deepest bench', esc(deep['teamName']), f'{deep["benchVal"]} bench value, most in the league'),
    sup('Forgot a defense', ' & '.join(esc(t['teamName']) for t in nodef), 'No DEF drafted, waivers Wednesday'),
    sup('Tightest race', f'{teams[0]["lineupPts"] - teams[-1]["lineupPts"]} pts', f'#1 to #12 over a full season, about {(teams[0]["lineupPts"] - teams[-1]["lineupPts"]) / 17:.0f} a week'),
]

def runrow(label, picks, cls):
    dots = ''.join(f'<i style="left:{(p - 1) / 179 * 100:.2f}%" title="pick {p}"></i>' for p in picks)
    return f'<div class="run"><span class="rl">{chip(label) if label in SK else f"<span class=\"chip p-X\">{label}</span>"}</span><span class="track {cls}">{dots}</span><span class="rn">{len(picks)}</span></div>'
runs = runrow('QB', qbs, 't-QB') + runrow('TE', tes, 't-TE') + runrow('DEF', defs, 't-X') + runrow('K', ks, 't-X')

drafters = sorted(teams, key=lambda t: -t['valOverPar'])
dr = ''.join(f'<li class="{"pos" if t["valOverPar"] > 0 else "neg"}"><span class="n">{i + 1}</span>{avatar(t, 28)}<span class="who"><b>{esc(t["teamName"])}</b><small>slot {t["slot"]}</small></span><span class="dv">{t["valOverPar"]:+d}</span></li>' for i, t in enumerate(drafters))

cards = []
for t in teams:
    st = ''.join(f'<li>{chip(l["slot"] if l["slot"] != "FLEX" else l["pos"])}<span class="nm">{esc(l["player"])}{" <em>Q</em>" if l["inj"] else ""}</span><span class="v">{l["pts"] if l["pts"] else "—"}</span></li>' for l in t['lineup'])
    bench = ', '.join(esc(b['player']) for b in t['bench'])
    best = max((p for p in t['picks'] if skill(p)), key=lambda p: p['steal'])
    worst = min((p for p in t['picks'] if skill(p)), key=lambda p: p['steal'])
    cards.append(f'''<article class="card {'first' if t['rank'] == 1 else ''}">
  <header>{avatar(t, 40)}<div class="ttl"><b>{esc(t['teamName'])}</b><small>{esc(t['owner'])} · slot {t['slot']}</small></div><span class="rank">#{t['rank']}</span></header>
  <ul class="starters">{st}</ul>
  <p class="bench"><span>Bench</span> {bench}</p>
  <p class="bw"><span class="good">Best</span> {pname(best)} <small>pick {best['pick']}, {best['steal']:+d}</small> &nbsp;<span class="bad">Reach</span> {pname(worst)} <small>pick {worst['pick']}, {worst['steal']:+d}</small></p>
</article>''')

page = f'''<title>Ballers Draft Report 2026</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Barlow:wght@400;500;600&display=swap">
<style>
:root{{color-scheme:light;--bg:#f4f4f0;--surf:#fbfbf8;--ink:#15201b;--ink2:#5d6a63;--line:#d9dcd4;--line2:#e9ebe4;--gold:#b0801a;--good:#1f7a5a;--bad:#b43a36;--bar:#1b2a24;
--qb:#d6423e;--rb:#1f9c8c;--wr:#3a6fd8;--te:#c27a12;--x:#6b7570;--font:'Barlow',system-ui,sans-serif;--disp:'Barlow Condensed','Arial Narrow',sans-serif}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{color-scheme:dark;--bg:#101614;--surf:#172019;--ink:#ecefe9;--ink2:#9aa59d;--line:#2b362f;--line2:#1f2923;--gold:#e0b04a;--good:#4fc596;--bad:#f07a74;--bar:#dfe6dd;--qb:#ea5a56;--rb:#27b39e;--wr:#5486ef;--te:#d8932a;--x:#8b958f}}}}
:root[data-theme="dark"]{{color-scheme:dark;--bg:#101614;--surf:#172019;--ink:#ecefe9;--ink2:#9aa59d;--line:#2b362f;--line2:#1f2923;--gold:#e0b04a;--good:#4fc596;--bad:#f07a74;--bar:#dfe6dd;--qb:#ea5a56;--rb:#27b39e;--wr:#5486ef;--te:#d8932a;--x:#8b958f}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 var(--font);font-variant-numeric:tabular-nums}}
.wrap{{max-width:1060px;margin:0 auto;padding:36px 22px 64px}}
h1,h2,h3{{font-family:var(--disp);margin:0;text-wrap:balance;letter-spacing:.005em}}
h1{{font-size:clamp(46px,8vw,84px);line-height:.92;font-weight:800;text-transform:uppercase}}
h2{{font-size:28px;font-weight:700;text-transform:uppercase;letter-spacing:.02em}}
.eyebrow{{font-family:var(--disp);font-weight:600;text-transform:uppercase;letter-spacing:.12em;font-size:13px;color:var(--ink2)}}
.mast{{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:end;border-bottom:3px solid var(--ink);padding-bottom:18px}}
.mast p{{margin:10px 0 0;max-width:62ch;color:var(--ink2)}}
.stamp{{font-family:var(--disp);text-transform:uppercase;text-align:right;line-height:1.15;color:var(--ink2);font-size:14px;letter-spacing:.06em}}
.stamp b{{display:block;color:var(--ink);font-size:22px;letter-spacing:.02em}}
section{{margin-top:44px}}
.sh{{display:flex;justify-content:space-between;align-items:baseline;gap:16px;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:14px}}
.sh small{{color:var(--ink2)}}
/* rankings */
.rank-list{{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}}
.row{{display:grid;grid-template-columns:28px 32px minmax(150px,200px) 1fr 96px auto;align-items:center;gap:12px;padding:6px 8px;border-radius:6px}}
.row.first{{background:var(--surf);outline:1px solid var(--line)}}
.rk{{font-family:var(--disp);font-weight:800;font-size:22px;color:var(--ink2);text-align:right}}
.row.first .rk{{color:var(--gold)}}
.av{{width:32px;height:32px;border-radius:50%;object-fit:cover;background:var(--line2);display:inline-flex;align-items:center;justify-content:center;font-family:var(--disp);font-weight:700;color:var(--ink2)}}
.who{{display:flex;flex-direction:column;line-height:1.15;min-width:0}}
.who b{{font-family:var(--disp);font-size:19px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.who small{{color:var(--ink2);font-size:12.5px}}
.bar{{height:14px;background:var(--line2);border-radius:3px;overflow:hidden}}
.fill{{display:block;height:100%;background:var(--bar);border-radius:0 3px 3px 0}}
.row.first .fill{{background:var(--gold)}}
.pts{{font-family:var(--disp);font-size:22px;font-weight:700;text-align:right;line-height:1}}
.pts small{{display:block;font-family:var(--font);font-size:12px;font-weight:500;color:var(--ink2);margin-top:2px}}
.prs{{display:flex;gap:4px}}
.pr{{display:inline-flex;flex-direction:column;align-items:center;width:34px;padding:3px 0;border:1px solid var(--line);border-radius:4px;font-family:var(--disp);font-weight:700;font-size:15px;line-height:1;color:var(--ink2)}}
.pr i{{font-style:normal;font-size:9.5px;letter-spacing:.06em;margin-bottom:2px;font-weight:600}}
.pr.top{{color:var(--ink);border-color:var(--ink)}}
.pr.low{{color:var(--bad);border-style:dashed}}
.axis{{display:grid;grid-template-columns:28px 32px minmax(150px,200px) 1fr 96px auto;gap:12px;padding:0 8px;color:var(--ink2);font-size:12px}}
.axis .a{{display:flex;justify-content:space-between}}
/* superlatives */
.sups{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}}
.sup{{background:var(--surf);border:1px solid var(--line);border-radius:6px;padding:14px 16px;display:flex;flex-direction:column;gap:4px;min-height:112px}}
.sup .lbl{{font-family:var(--disp);text-transform:uppercase;letter-spacing:.1em;font-size:12px;font-weight:600;color:var(--ink2)}}
.sup b{{font-family:var(--disp);font-size:24px;line-height:1.05;font-weight:700}}
.sup .sub{{color:var(--ink2);font-size:13px;margin-top:auto}}
/* drafters */
.drafters{{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:8px 14px}}
.drafters li{{display:grid;grid-template-columns:20px 28px 1fr auto;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surf)}}
.drafters .n{{font-family:var(--disp);font-weight:700;color:var(--ink2);text-align:right}}
.drafters .av{{width:28px;height:28px}}
.drafters .who b{{font-size:16px}}
.drafters .dv{{font-family:var(--disp);font-weight:700;font-size:18px}}
.drafters .pos .dv{{color:var(--good)}}.drafters .neg .dv{{color:var(--bad)}}
@media (max-width:820px){{.drafters{{grid-template-columns:repeat(2,1fr)}}}}
/* runs */
.runs{{display:flex;flex-direction:column;gap:10px}}
.run{{display:grid;grid-template-columns:44px 1fr 28px;gap:12px;align-items:center}}
.track{{position:relative;height:18px;border-bottom:1px solid var(--line)}}
.track i{{position:absolute;top:3px;width:9px;height:12px;margin-left:-4px;border-radius:2px;background:var(--dot,var(--ink))}}
.track.t-QB{{--dot:var(--qb)}}.track.t-TE{{--dot:var(--te)}}.track.t-X{{--dot:var(--x)}}
.rn{{font-family:var(--disp);font-weight:700;color:var(--ink2);text-align:right}}
.rounds{{display:grid;grid-template-columns:44px 1fr 28px;gap:12px;color:var(--ink2);font-size:12px}}
.rounds .r{{display:flex;justify-content:space-between}}
.runs-note{{color:var(--ink2);margin:10px 0 0;max-width:70ch}}
/* chips */
.chip{{display:inline-block;min-width:34px;text-align:center;padding:2px 5px;border-radius:3px;font-family:var(--disp);font-weight:700;font-size:12.5px;letter-spacing:.05em;color:#fff;background:var(--x)}}
.p-QB{{background:var(--qb)}}.p-RB{{background:var(--rb)}}.p-WR{{background:var(--wr)}}.p-TE{{background:var(--te)}}
/* cards */
.cards{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}}
.card{{background:var(--surf);border:1px solid var(--line);border-radius:8px;padding:14px 16px 12px;display:flex;flex-direction:column;gap:10px}}
.card.first{{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold) inset}}
.card header{{display:flex;align-items:center;gap:10px}}
.card .av{{width:40px;height:40px}}
.ttl{{display:flex;flex-direction:column;line-height:1.1;min-width:0;flex:1}}
.ttl b{{font-family:var(--disp);font-size:21px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.ttl small{{color:var(--ink2);font-size:12.5px}}
.rank{{font-family:var(--disp);font-weight:800;font-size:26px;color:var(--ink2)}}
.card.first .rank{{color:var(--gold)}}
.starters{{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px}}
.starters li{{display:grid;grid-template-columns:40px 1fr auto;gap:8px;align-items:center;font-size:14px}}
.starters .nm{{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.starters em{{font-style:normal;font-size:10.5px;font-weight:700;color:var(--bad);border:1px solid var(--bad);border-radius:3px;padding:0 3px;margin-left:4px;vertical-align:1px}}
.starters .v{{font-family:var(--disp);font-weight:600;color:var(--ink2);font-size:14px}}
.bench{{margin:0;font-size:12.5px;color:var(--ink2);border-top:1px solid var(--line2);padding-top:8px;line-height:1.35}}
.bench span,.bw .good,.bw .bad{{font-family:var(--disp);text-transform:uppercase;letter-spacing:.08em;font-size:11px;font-weight:700}}
.bw{{margin:0;font-size:13px;line-height:1.5}}
.bw .good{{color:var(--good)}}.bw .bad{{color:var(--bad)}}
.bw small{{color:var(--ink2)}}
/* method */
.method{{color:var(--ink2);font-size:13.5px;max-width:78ch;border-top:1px solid var(--line);padding-top:14px}}
.method p{{margin:6px 0}}
@media (max-width:820px){{
  .sups{{grid-template-columns:repeat(2,1fr)}}.cards{{grid-template-columns:1fr 1fr}}
  .row,.axis{{grid-template-columns:24px 28px 1fr 88px}}.bar,.axis .a{{display:none}}.prs{{grid-column:1/-1;justify-content:flex-start;padding-left:64px}}
}}
@media (max-width:560px){{.cards{{grid-template-columns:1fr}}.sups{{grid-template-columns:1fr}}.mast{{grid-template-columns:1fr}}.stamp{{text-align:left}}}}
@media (prefers-reduced-motion:no-preference){{.fill{{transition:width .6s ease-out}}}}
</style>
<div class="wrap">
<header class="mast">
  <div>
    <div class="eyebrow">The Ballers Fantasy League · Sleeper</div>
    <h1>Draft Report<br>2026</h1>
    <p>All 180 picks, every roster scored the same way: season projections rescored to league scoring (half-PPR, 4-pt pass TD), best legal starting lineup, 1 QB / 2 RB / 2 WR / 1 TE / FLEX / K / DEF. No vibes, one ruler.</p>
  </div>
  <div class="stamp">Drafted Sep 2, 2026<b>12 teams · 15 rounds</b>snake, slot 1 to 12</div>
</header>

<section>
  <div class="sh"><h2>Power rankings</h2><small>Projected starting-lineup points, full season</small></div>
  <div class="axis"><span></span><span></span><span></span><span class="a"><span>{LO:,}</span><span>league median {median:,.0f}</span><span>{HI:,}</span></span><span></span><span></span></div>
  <ol class="rank-list">{''.join(rows)}</ol>
  <p class="runs-note">Bars start at {LO:,}. The small boxes are each team's rank at that slot; solid boxes are top three, dashed are bottom three. Second number under points is the gap to the league median.</p>
</section>

<section>
  <div class="sh"><h2>Superlatives</h2><small>Par = what the board's Nth-ranked player was worth at that pick</small></div>
  <div class="sups">{''.join(sups)}</div>
</section>

<section>
  <div class="sh"><h2>Who drafted best</h2><small>Value gained over par, all 15 picks. Slot-neutral: slot 1 is supposed to end up stronger</small></div>
  <ol class="drafters">{dr}</ol>
  <p class="runs-note">Roster strength rewards the draft slot; this rewards the picks. A positive number means the team beat the board across the night, a negative one means it left value on the table.</p>
</section>

<section>
  <div class="sh"><h2>The runs</h2><small>When each position got taken, pick 1 to 180</small></div>
  <div class="runs">{runs}</div>
  <div class="rounds"><span></span><span class="r"><span>Rd 1</span><span>Rd 4</span><span>Rd 7</span><span>Rd 10</span><span>Rd 13</span><span>Rd 15</span></span><span></span></div>
  <p class="runs-note">Quarterbacks went in one burst from pick 56 to 71 after Allen and Lamar broke the seal. Tight ends were gone by pick 68 outside the streamers. Defenses started at 104 and the top five were gone in 27 picks.</p>
</section>

<section>
  <div class="sh"><h2>Every roster</h2><small>Starters with projected points, Q = questionable on the injury report</small></div>
  <div class="cards">{''.join(cards)}</div>
</section>

<section class="method">
  <p><b>How it's scored.</b> Projections are Sleeper's published season projections (Rotowire), rescored stat by stat under this league's settings. Lineup points are the best legal lineup from the drafted roster; an empty slot counts at waiver-replacement level. Position rank compares each team's starters at that slot against the other eleven. Steal and reach compare a player's value against the value of the board's Nth-ranked player at that pick, so a late-round pick can't be a big reach and a first-rounder can't be a big steal. Sleeper's own "steal/reach" tags measure distance from ADP only.</p>
  <p>Projections are a starting point, not a verdict. A 117-point spread across a 17-week season is about seven points a week, which is one touchdown. Nobody's cooked, and nobody's safe.</p>
  <p>Generated by claude boys' draft tooling on {d['generated'][:10]}.</p>
</section>
</div>
'''
open(T + 'ballers-draft-report.html', 'w').write(page)
print('ok', len(page))
print('steal', steal['player'], steal['owner'], '| reach', reach['player'], reach['owner'], '| bargain', bargain['player'], bargain['adp'], bargain['pick'], '| offmkt', offmkt['player'], offmkt['adp'], offmkt['pick'], '| fragile', fragile['owner'], len(fragile['flagged']), '| deep', deep['owner'], '| nodef', [t['owner'] for t in nodef], '| median', median)
