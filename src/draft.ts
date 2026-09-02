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

/** League/draft/users change rarely; picks change every few seconds. The live
 * loop keeps a context for ~30s and re-fetches only picks each tick. */
type Ctx = { draft: any; users: Record<string, any>; board: ProjRow[]; at: number; key: string }
let ctx: Ctx | null = null
/** `draftId` overrides the league's draft — e.g. a Sleeper mock draft, to rehearse the flow. */
export async function draftCtx(season: string, fresh = false, draftId?: string): Promise<Ctx> {
  const key = draftId ?? 'league'
  if (ctx && !fresh && ctx.key === key && Date.now() - ctx.at < 30_000) return ctx
  const league = await api(`/league/${LEAGUE_ID}`)
  const [draft, users, board] = await Promise.all([
    api(`/draft/${draftId ?? league.draft_id}`),
    leagueUsers(LEAGUE_ID),
    buildBoard(season, fresh),
  ])
  // mock drafts have strangers in them: name slots by user id when not a leaguemate
  ctx = { draft, users, board, at: Date.now(), key }
  return ctx
}

export async function draftState(season: string, fresh = false, draftId?: string) {
  const { draft, users, board } = await draftCtx(season, fresh, draftId)
  const picks = await api<any[]>(`/draft/${draft.draft_id}/picks`)
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
  const ourPickRows = picks.filter((p) => p.draft_slot === slot)
  const ours = ourPickRows.map((p) => pickRow(p, byId.get(p.player_id)))
  const oursRows = ourPickRows.map((p) => byId.get(p.player_id)).filter((r): r is ProjRow => !!r)
  const owned = countPos(ours)
  const available = board.filter((r) => !taken.has(r.id))
  const at = nextOurs[0] ?? current
  const recs = recommend(available, oursRows, at, nextOurs[1] ?? null, teams, rounds)
  const byPos: Record<string, ReturnType<typeof recRow>[]> = {}
  for (const pos of ['RB', 'WR', 'TE', 'QB', 'K', 'DEF']) {
    byPos[pos] = recs
      .filter((r) => r.pos === pos)
      .sort((a, b) => b.val - a.val)
      .slice(0, 12)
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
    top: recs.slice(0, 30).map(recRow),
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
    gain: r.gain,
    rec: r.rec,
    adp: r.adp,
    gone: r.gone,
    gone2: r.gone2,
    flag: flag(r),
  }
}

// ------------------------------------------------------------------ serve
//
// Sleeper has no public websocket, so: poll picks every `everyMs` (1s is fine
// for their rate limits), diff, and PUSH to every open page over server-sent
// events. The page never polls; a pick shows up within one poll interval.

export function serveLive(season: string, port: number, everyMs: number, draftId?: string) {
  let last: DraftState | null = null
  let lastJson = ''
  let lastErr = ''
  const clients = new Set<ReadableStreamDefaultController>()
  const payload = () => `data: ${JSON.stringify({ state: last, error: lastErr })}\n\n`
  let server: ReturnType<typeof Bun.serve>
  // /ws: the agent feed. Only what changes a decision: a heads-up 3 picks out,
  // our pick (with the board), status changes, errors.
  let lastWsKey = ''
  const wsEvent = () => {
    const s = last
    if (!s) return lastErr ? { type: 'error', error: lastErr } : null
    const until = s.picks_until_ours
    const type = s.our_turn ? 'our_pick' : s.status === 'complete' ? 'complete' : until !== null && until <= 3 ? 'heads_up' : null
    if (!type) return null
    const key = `${type}:${s.pick}`
    if (key === lastWsKey) return null
    lastWsKey = key
    const top = s.top.slice(0, type === 'our_pick' ? 12 : 6).map((r) => `${r.player} ${r.pos} t${r.tier} rec=${r.rec} gain=${r.gain} adp=${r.adp} gone=${r.gone}%/${r.gone2 ?? '-'}% ${r.flag}`.trim())
    return { type, pick: s.pick, round: s.round, on_clock: s.on_clock, next_ours: s.next_ours, owned: s.owned, roster: s.ours.map((p) => `${p.player} ${p.pos}`), last: s.recent[0] ? `${s.recent[0].pick} ${s.recent[0].player} ${s.recent[0].pos} by ${s.recent[0].by}` : null, top }
  }
  const push = () => {
    const msg = payload()
    const ev = wsEvent()
    if (ev) server?.publish('agent', JSON.stringify(ev))
    for (const c of clients) {
      try {
        c.enqueue(msg)
      } catch {
        clients.delete(c)
      }
    }
  }
  const tick = async () => {
    try {
      const s = await draftState(season, false, draftId)
      const { updated, ...rest } = s
      const j = JSON.stringify(rest)
      const changed = j !== lastJson || lastErr !== ''
      last = s
      lastJson = j
      lastErr = ''
      if (changed) push()
    } catch (e: any) {
      lastErr = String(e?.message ?? e)
      push()
    }
  }
  tick()
  setInterval(tick, everyMs)
  setInterval(() => {
    for (const c of clients)
      try {
        c.enqueue(': ping\n\n')
      } catch {
        clients.delete(c)
      }
  }, 15_000)
  server = Bun.serve({
    port,
    hostname: '0.0.0.0', // reachable over the tailnet too (e.g. studio:4242), not just localhost
    websocket: {
      open(ws) {
        ws.subscribe('agent')
        const ev = wsEvent()
        ws.send(JSON.stringify(ev ?? { type: 'hello', pick: last?.pick, status: last?.status, next_ours: last?.next_ours }))
      },
      message() {},
    },
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/ws') return (srv as any).upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 })
      if (url.pathname === '/data') return Response.json({ state: last, error: lastErr })
      if (url.pathname === '/events') {
        let ctrl: ReadableStreamDefaultController
        const stream = new ReadableStream({
          start(c) {
            ctrl = c
            clients.add(c)
            c.enqueue(payload())
          },
          cancel() {
            clients.delete(ctrl)
          },
        })
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        })
      }
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  return `http://localhost:${server.port}/  (bound 0.0.0.0 — also any tailnet name for this host, e.g. http://studio:${server.port}/)`
}

// Fixed-viewport console: the page never scrolls, panels do (lore's explorer
// pattern: body flex column + overflow hidden, grid rows minmax(0,1fr),
// panel = flex column with min-height 0, one .scroll child).
const PAGE = /* html */ `<!doctype html><meta charset="utf-8"><title>ff live</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;--bg:#0f1115;--surface:#161a22;--surface-2:#1b202a;--line:#2a2f3a;--ink:#e6e6e6;--ink-3:#9aa4b2;--mono:ui-monospace,Menlo,monospace}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);display:flex;flex-direction:column;overflow:hidden;font:13px/1.35 var(--mono);font-variant-numeric:tabular-nums}
header.top{flex:none;display:flex;gap:22px;align-items:baseline;padding:8px 14px;background:var(--surface);border-bottom:1px solid var(--line);white-space:nowrap}
header.top b{font-size:18px}.turn{background:#c0392b;color:#fff;padding:2px 8px;border-radius:4px;font-weight:700;animation:pulse 1s infinite alternate}
@keyframes pulse{from{opacity:1}to{opacity:.55}}
.wait{color:var(--ink-3)}.small{font-size:11px;color:var(--ink-3)}.sp{margin-left:auto}
main{flex:1;min-height:0;display:grid;gap:8px;padding:8px;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);grid-template-rows:minmax(0,1.15fr) minmax(0,1fr)}
.panel{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:6px}
.panel>h3{flex:none;margin:0;padding:5px 10px;border-bottom:1px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.06em}
.panel>.scroll{flex:1;min-height:0;overflow:auto}
.right{display:grid;grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:8px;min-height:0}
.wide{grid-column:1/-1}
table{width:100%;border-collapse:collapse}td,th{padding:2px 6px;text-align:right;white-space:nowrap}
th{position:sticky;top:0;background:var(--surface);color:var(--ink-3);font-weight:500;z-index:1}
td:first-child,th:first-child,td.l,th.l{text-align:left}tbody tr:nth-child(even){background:var(--surface-2)}
.t1{color:#ffd166}.t2{color:#8ecae6}.gone{color:#ff6b6b}.safe{color:#7bd389}.flag{color:#f4a261}
.pos{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));grid-auto-rows:minmax(0,1fr);gap:0;height:100%;min-height:0}
.pos>div{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.pos>div:last-child{border-right:0}
.pos h3{flex:none;margin:0;padding:4px 8px;font-size:11px;color:var(--ink-3);border-bottom:1px solid var(--line)}
.pos .scroll{flex:1;min-height:0;overflow:auto}.pos td{padding:1px 5px}
</style>
<header class=top><b>ff live</b><span id=st></span><span id=clock></span><span id=next></span><span id=upd class="small sp"></span></header>
<main>
<section class=panel><h3>Board — recommended for our next pick</h3><div class=scroll><table id=top></table></div></section>
<div class=right>
<section class=panel><h3>Recent picks</h3><div class=scroll><table id=recent></table></div></section>
<section class=panel><h3>Our roster <span id=owned class=small></span></h3><div class=scroll><table id=ours></table></div></section>
</div>
<section class="panel wide"><div class=pos id=bypos></div></section>
</main>
<script>
const $=s=>document.querySelector(s);
const g=v=>v==null?'':'<span class="'+(v>=70?'gone':v<=30?'safe':'')+'">'+v+'%</span>';
const row=r=>'<tr><td class=l><b>'+r.player+'</b> <span class=small>'+r.team+'</span></td><td class="t'+Math.min(r.tier,2)+'">'+r.pos+' t'+r.tier+'</td><td>'+r.pts+'</td><td>'+r.vorp+'</td><td>'+r.val+'</td><td>'+r.gain+'</td><td><b>'+r.rec+'</b></td><td>'+(r.adp??'—')+'</td><td>'+g(r.gone)+'</td><td>'+g(r.gone2)+'</td><td class="l flag">'+(r.flag||'')+'</td></tr>';
const hdr='<thead><tr><th class=l>player</th><th>pos</th><th>pts</th><th>vorp</th><th>val</th><th>gain</th><th>rec</th><th>adp</th><th>gone@1</th><th>gone@2</th><th class=l>flags</th></tr></thead>';
let lastTitle='';
function render({state:s,error}){
if(!s){$('#st').textContent=error||'loading…';return}
$('#st').textContent=s.status+' · pick '+s.pick+' (rd '+s.round+')';
$('#clock').innerHTML=s.our_turn?'<span class=turn>OUR PICK</span>':'<span class=wait>on clock: '+s.on_clock+'</span>';
$('#next').textContent=s.next_ours.length?'ours: '+s.next_ours.join(', ')+(s.picks_until_ours?' ('+s.picks_until_ours+' away)':''):'done';
$('#upd').textContent=new Date(s.updated).toLocaleTimeString()+(error?' · '+error:'');
const title=(s.our_turn?'🔴 OUR PICK — ':'')+'ff live · pick '+s.pick; if(title!==lastTitle){document.title=title;lastTitle=title}
$('#top').innerHTML=hdr+'<tbody>'+s.top.map(row).join('')+'</tbody>';
$('#recent').innerHTML='<thead><tr><th>#</th><th class=l>player</th><th>pos</th><th>adp</th><th class=l>by</th></tr></thead><tbody>'+s.recent.map(p=>'<tr><td>'+p.pick+'</td><td class=l>'+p.player+'</td><td>'+p.pos+'</td><td>'+(p.adp??'—')+'</td><td class=l>'+p.by+'</td></tr>').join('')+'</tbody>';
$('#owned').textContent=Object.entries(s.owned).map(([k,v])=>k+':'+v).join(' ');
$('#ours').innerHTML='<tbody>'+(s.ours.map(p=>'<tr><td>'+p.pick+'</td><td class=l>'+p.player+'</td><td>'+p.pos+'</td><td>'+p.team+'</td><td>'+(p.pts??'')+'</td></tr>').join('')||'<tr><td class=l>—</td></tr>')+'</tbody>';
$('#bypos').innerHTML=Object.entries(s.by_pos).map(([pos,list])=>'<div><h3>'+pos+'</h3><div class=scroll><table><tbody>'+list.map(r=>'<tr><td class=l>'+r.player+'</td><td class="t'+Math.min(r.tier,2)+'">t'+r.tier+'</td><td>'+r.val+'</td><td>'+g(r.gone)+'</td><td class="l flag">'+(r.flag||'')+'</td></tr>').join('')+'</tbody></table></div></div>').join('');
}
function connect(){const es=new EventSource('/events');es.onmessage=e=>{try{render(JSON.parse(e.data))}catch(err){$('#st').textContent='bad payload: '+err}};
es.onerror=()=>{$('#upd').textContent='reconnecting…';es.close();setTimeout(connect,1500)}}
connect();
</script>`
