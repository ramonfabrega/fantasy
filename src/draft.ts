// Live draft state: picks so far → who's on the clock, our next picks, our
// roster, and the recommendation board of what's still available. `ff live`
// polls this; `ff live --serve` renders it as an auto-refreshing localhost page
// to sit next to the Sleeper draft room.
import { api, LEAGUE_ID, leagueUsers, USER_ID } from './sleeper'
import {
  buildBoard,
  countPos,
  flag,
  picksForSlot,
  recommend,
  slotForPick,
  type ProjRow,
  type Rec,
} from './proj'

export type DraftState = Awaited<ReturnType<typeof draftState>>

export async function draftState(season: string, fresh = false) {
  const league = await api(`/league/${LEAGUE_ID}`)
  const draftId = league.draft_id
  const [draft, picks, users, board] = await Promise.all([
    api(`/draft/${draftId}`),
    api<any[]>(`/draft/${draftId}/picks`),
    leagueUsers(LEAGUE_ID),
    buildBoard(season, fresh),
  ])
  const teams: number = draft.settings?.teams ?? 12
  const rounds: number = draft.settings?.rounds ?? 15
  const slot: number = draft.draft_order?.[USER_ID] ?? 0
  const slotOwner: Record<number, string> = {}
  for (const [uid, s] of Object.entries(draft.draft_order ?? {}))
    slotOwner[s as number] = users[uid]?.display_name ?? uid
  picks.sort((a, b) => a.pick_no - b.pick_no)
  const taken = new Set(picks.map((p) => p.player_id))
  const byId = new Map(board.map((r) => [r.id, r]))
  const current = picks.length + 1
  const done = current > teams * rounds || draft.status === 'complete'
  const onClockSlot = done ? 0 : slotForPick(current, teams)
  const ourPicks = picksForSlot(slot, teams, rounds)
  const nextOurs = ourPicks.filter((n) => n >= current)
  const ours = picks
    .filter((p) => p.draft_slot === slot)
    .map((p) => pickRow(p, byId.get(p.player_id)))
  const owned = countPos(ours)
  const available = board.filter((r) => !taken.has(r.id))
  const at = nextOurs[0] ?? current
  const recs = recommend(available, owned, at, nextOurs[1] ?? null, teams, rounds)
  const byPos: Record<string, ReturnType<typeof recRow>[]> = {}
  for (const pos of ['RB', 'WR', 'TE', 'QB', 'K', 'DEF']) {
    byPos[pos] = recs
      .filter((r) => r.pos === pos)
      .sort((a, b) => b.val - a.val)
      .slice(0, 8)
      .map(recRow)
  }
  return {
    status: done ? 'complete' : draft.status,
    timer_s: draft.settings?.pick_timer,
    pick: current,
    round: Math.ceil(current / teams),
    on_clock: done ? '' : slotOwner[onClockSlot] ?? `slot ${onClockSlot}`,
    our_turn: !done && onClockSlot === slot,
    our_slot: slot,
    next_ours: nextOurs.slice(0, 3),
    picks_until_ours: nextOurs.length ? nextOurs[0]! - current : null,
    owned,
    ours,
    recent: picks
      .slice(-8)
      .reverse()
      .map((p) => ({
        ...pickRow(p, byId.get(p.player_id)),
        by: slotOwner[p.draft_slot] ?? p.picked_by,
      })),
    top: recs.slice(0, 18).map(recRow),
    by_pos: byPos,
    updated: new Date().toISOString(),
  }
}

function pickRow(p: any, r?: ProjRow) {
  return {
    pick: p.pick_no,
    rd: p.round,
    player: r?.player ?? `${p.metadata?.first_name ?? ''} ${p.metadata?.last_name ?? ''}`.trim(),
    pos: r?.pos ?? p.metadata?.position ?? '?',
    team: r?.team ?? p.metadata?.team ?? '?',
    pts: r?.pts ?? null,
    adp: r?.adp ?? null,
    id: p.player_id,
  }
}

function recRow(r: Rec) {
  return {
    player: r.player,
    pos: `${r.pos}${r.pos_rank}`,
    team: r.team,
    tier: r.tier,
    pts: Math.round(r.pts),
    vorp: r.vorp,
    val: r.val,
    rec: r.rec,
    adp: r.adp,
    gone: r.gone,
    gone2: r.gone2,
    flag: flag(r),
  }
}

// ------------------------------------------------------------------ serve

export function serveLive(season: string, port: number, everyMs: number) {
  let last: DraftState | null = null
  let lastErr = ''
  const tick = async () => {
    try {
      last = await draftState(season)
      lastErr = ''
    } catch (e: any) {
      lastErr = String(e?.message ?? e)
    }
  }
  tick()
  setInterval(tick, everyMs)
  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/data')
        return Response.json({ state: last, error: lastErr })
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  return server.url.toString()
}

const PAGE = /* html */ `<!doctype html><meta charset="utf-8"><title>ff live</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0f1115;color:#e6e6e6;font:13px/1.35 ui-monospace,Menlo,monospace}
header{display:flex;gap:24px;align-items:baseline;padding:10px 14px;background:#161a22;border-bottom:1px solid #2a2f3a;position:sticky;top:0}
header b{font-size:20px}.turn{background:#c0392b;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700}
.wait{color:#9aa4b2}main{display:grid;grid-template-columns:1.25fr 1fr;gap:12px;padding:12px}
section{background:#161a22;border:1px solid #2a2f3a;border-radius:6px;padding:8px 10px}h3{margin:0 0 6px;font-size:12px;color:#9aa4b2;text-transform:uppercase;letter-spacing:.06em}
table{width:100%;border-collapse:collapse}td,th{padding:2px 6px;text-align:right;white-space:nowrap}th{color:#9aa4b2;font-weight:500}
td:first-child,th:first-child,td.l,th.l{text-align:left}tr:nth-child(even){background:#1b202a}
.t1{color:#ffd166}.t2{color:#8ecae6}.gone{color:#ff6b6b}.safe{color:#7bd389}.flag{color:#f4a261}
.pos{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.pos table td{padding:1px 4px}.small{font-size:11px}
</style>
<header><b>ff live</b><span id=st></span><span id=clock></span><span id=next></span><span id=upd class=small></span></header>
<main>
<section><h3>Board — recommended for our next pick</h3><table id=top></table></section>
<div style="display:grid;gap:12px">
<section><h3>Recent picks</h3><table id=recent></table></section>
<section><h3>Our roster <span id=owned class=small></span></h3><table id=ours></table></section>
</div>
<section style="grid-column:1/-1"><h3>By position (top by VORP)</h3><div class=pos id=bypos></div></section>
</main>
<script>
const $=s=>document.querySelector(s);
const g=v=>v==null?'':'<span class="'+(v>=70?'gone':v<=30?'safe':'')+'">'+v+'%</span>';
const row=r=>'<tr><td class=l><b>'+r.player+'</b> <span class=small>'+r.team+'</span></td><td class="t'+Math.min(r.tier,2)+'">'+r.pos+' t'+r.tier+'</td><td>'+r.pts+'</td><td>'+r.vorp+'</td><td>'+r.val+'</td><td><b>'+r.rec+'</b></td><td>'+(r.adp??'—')+'</td><td>'+g(r.gone)+'</td><td>'+g(r.gone2)+'</td><td class="l flag">'+(r.flag||'')+'</td></tr>';
const hdr='<tr><th class=l>player</th><th>pos</th><th>pts</th><th>vorp</th><th>val</th><th>rec</th><th>adp</th><th>gone@1</th><th>gone@2</th><th class=l>flags</th></tr>';
async function load(){try{const {state:s,error}=await (await fetch('/data')).json();if(!s){$('#st').textContent=error||'loading…';return}
$('#st').textContent=s.status+' · pick '+s.pick+' (rd '+s.round+')';
$('#clock').innerHTML=s.our_turn?'<span class=turn>OUR PICK</span>':'<span class=wait>on clock: '+s.on_clock+'</span>';
$('#next').textContent=s.next_ours.length?'ours: '+s.next_ours.join(', ')+(s.picks_until_ours?' ('+s.picks_until_ours+' away)':''):'done';
$('#upd').textContent=new Date(s.updated).toLocaleTimeString()+(error?' · '+error:'');
$('#top').innerHTML=hdr+s.top.map(row).join('');
$('#recent').innerHTML='<tr><th>#</th><th class=l>player</th><th>pos</th><th>adp</th><th class=l>by</th></tr>'+s.recent.map(p=>'<tr><td>'+p.pick+'</td><td class=l>'+p.player+'</td><td>'+p.pos+'</td><td>'+(p.adp??'—')+'</td><td class=l>'+p.by+'</td></tr>').join('');
$('#owned').textContent=Object.entries(s.owned).map(([k,v])=>k+':'+v).join(' ');
$('#ours').innerHTML=s.ours.map(p=>'<tr><td>'+p.pick+'</td><td class=l>'+p.player+'</td><td>'+p.pos+'</td><td>'+p.team+'</td><td>'+(p.pts??'')+'</td></tr>').join('')||'<tr><td class=l>—</td></tr>';
$('#bypos').innerHTML=Object.entries(s.by_pos).map(([pos,list])=>'<div><h3>'+pos+'</h3><table>'+list.map(r=>'<tr><td class=l>'+r.player+'</td><td class="t'+Math.min(r.tier,2)+'">t'+r.tier+'</td><td>'+r.vorp+'</td><td>'+g(r.gone)+'</td><td class="l flag">'+(r.flag||'')+'</td></tr>').join('')+'</table></div>').join('');
}catch(e){$('#st').textContent='fetch failed: '+e}}
load();setInterval(load,3000);
</script>`
