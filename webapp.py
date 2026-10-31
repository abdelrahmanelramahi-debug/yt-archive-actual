"""
Build the browsable archive as a small single-page app + sharded data.

Reads the already-built output (output/ALL/videos.json, chunks.jsonl, topics.json,
stats.json) and writes a self-contained app into output/ALL/app/.

- Works over http: run a local server (serve_app.py) or upload the app/ folder to Vercel.
- Loads data in pieces, so it stays fast from 1k videos to 150k+.
- Touches nothing in raw/ , tags/ , spend.json , settings.json or .env.

Run:  python webapp.py
"""
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "output"
ALL = OUTPUT / "ALL"
APP = ALL / "app"
DATA = APP / "data"

LIST_SHARD = 4000        # light rows per list file
DETAIL_TARGET = 700000   # ~chars per detail file, so opening one video fetches a small file

TYPE_CODE = {"video": 0, "live": 1, "short": 2}


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def topic_slug(topic):
    t = re.sub(r"[^\w\s-]", "", (topic or "")).strip()
    t = re.sub(r"\s+", "-", t)
    return (t[:60].strip("-") or "untitled").lower()


def write_min(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def parse_t(url):
    m = re.search(r"[?&]t=(\d+)", url or "")
    return int(m.group(1)) if m else 0


def build_src(stats):
    """What the app is built from: the per-channel stats, the combined data files, the clip nesting
    and this file's own page code. While it matches the saved stamp, the app folder is current."""
    import hashlib
    parts = [hashlib.md5((INDEX_HTML + APP_JS).encode("utf-8")).hexdigest()[:12],
             hashlib.md5(json.dumps(stats.get("channels", {}), sort_keys=True).encode("utf-8")).hexdigest()[:12]]
    for f in (ALL / "videos.json", ALL / "chunks.jsonl", ALL / "topics.json", OUTPUT / "nests.json"):
        try:
            st = f.stat()
            parts.append(f"{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append("-")
    return "|".join(parts)


def build():
    stats = read_json(OUTPUT / "stats.json", {}) or {}
    src = build_src(stats)
    stamp = ALL / ".app_stamp.json"
    if (read_json(stamp, {}) or {}).get("src") == src and (APP / "index.html").exists() \
            and (DATA / "meta.json").exists():
        print("Archive app is current (nothing changed since it was last built).")
        return
    videos = read_json(ALL / "videos.json", []) or []
    if not videos:
        print("No output/ALL/videos.json yet. Run an Update first.")
        return

    # fresh app/data folder (our own; never touches raw/tags/data)
    shutil.rmtree(APP, ignore_errors=True)
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "t").mkdir(parents=True, exist_ok=True)

    # channels, ordered by total hours like the current shelf
    ch_stats = stats.get("channels", {})
    chans = []
    for slug, s in ch_stats.items():
        chans.append({"slug": slug, "name": s.get("name") or slug,
                      "videos": s.get("videos", 0), "lives": s.get("lives", 0),
                      "seconds": s.get("seconds", 0), "live_seconds": s.get("live_seconds", 0)})
    chans.sort(key=lambda c: -c.get("seconds", 0))
    ch_idx = {c["name"]: i for i, c in enumerate(chans)}

    # topic counts across all videos, for the Topics page and the filter
    topic_count = {}
    for v in videos:
        for t in v.get("topics") or []:
            topic_count[t["topic"]] = topic_count.get(t["topic"], 0) + 1
    topics_sorted = sorted(topic_count.items(), key=lambda kv: -kv[1])
    topic_idx = {lab: i for i, (lab, _) in enumerate(topics_sorted)}
    topics_meta = [[lab, n, topic_slug(lab)] for lab, n in topics_sorted]

    # nesting: clips/excerpts are listed under their parent stream, not on their own in the main list
    nests = read_json(OUTPUT / "nests.json", {}) or {}
    children = nests.get("children", {}) or {}
    parent = nests.get("parent", {}) or {}
    clip_set = set(parent)
    meta_by_vid = {v["videoId"]: (v.get("title") or "",
                                  round(float(v.get("durationSeconds") or 0) / 60) if v.get("durationSeconds") else 0)
                   for v in videos}

    # per-video light row (for the list) and detail metadata (for the video page)
    rows = []
    detail_meta = {}
    for v in videos:
        vid = v["videoId"]
        ci = ch_idx.get(v.get("channel"), 0)
        tlist = [topic_idx[t["topic"]] for t in (v.get("topics") or []) if t["topic"] in topic_idx]
        dur_s = v.get("durationSeconds") or 0
        durmin = round(float(dur_s) / 60) if dur_s else 0
        summ = (v.get("summary") or "")
        kids = children.get(vid) or []
        if vid not in clip_set:  # a clip gets no row of its own; it lives under its parent
            rows.append([vid, ci, TYPE_CODE.get(v.get("type"), 0), v.get("date") or "", durmin,
                         v.get("views") or 0, v.get("title") or "", tlist, summ, len(kids)])
        claims = [[c.get("claim") or "", c.get("timestamp") or "", c.get("url") or ""]
                  for c in (v.get("key_claims") or []) if c.get("claim")]
        td = [[t["topic"], topic_slug(t["topic"])] for t in (v.get("topics") or [])]
        rec = {
            "id": vid, "t": v.get("title") or "", "ch": ci, "d": v.get("date") or "",
            "y": TYPE_CODE.get(v.get("type"), 0), "m": durmin, "v": v.get("views") or 0,
            "url": v.get("url") or f"https://www.youtube.com/watch?v={vid}",
            "s": v.get("summary") or "", "f": v.get("format") or "",
            "w": v.get("counterpart") or "", "td": td, "c": claims,
        }
        if kids:
            rec["cl"] = [[kv, meta_by_vid[kv][0], meta_by_vid[kv][1]] for kv in kids if kv in meta_by_vid]
        if vid in parent and parent[vid] in meta_by_vid:
            rec["par"] = [parent[vid], meta_by_vid[parent[vid]][0]]
        detail_meta[vid] = rec

    # list shards (rows keep their global order, newest first already)
    n_list = 0
    for i in range(0, len(rows), LIST_SHARD):
        write_min(DATA / f"list-{n_list:03d}.json", rows[i:i + LIST_SHARD])
        n_list += 1

    # detail shards: stream chunks.jsonl (chunks for one video are contiguous),
    # attach transcript to each video, write in size-capped bundles so opening one
    # video fetches a small file no matter how long the transcripts are.
    locate = {}
    shard, shard_chars, n_detail = [], 0, 0

    def flush():
        nonlocal shard, shard_chars, n_detail
        if shard:
            write_min(DATA / f"detail-{n_detail:03d}.json", shard)
            n_detail += 1
            shard, shard_chars = [], 0

    def add(vid, segs):
        nonlocal shard_chars
        rec = detail_meta.get(vid)
        if not rec:
            return
        rec = dict(rec)
        rec["g"] = segs
        shard.append(rec)
        locate[vid] = n_detail
        shard_chars += len(rec["t"]) + len(rec["s"]) + sum(len(s[1]) for s in segs) + 200

    cur, segs = None, []
    cpath = ALL / "chunks.jsonl"
    if cpath.exists():
        with open(cpath, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                c = json.loads(line)
                vid = c["video_id"]
                if vid != cur:
                    if cur is not None:
                        add(cur, segs)
                        if shard_chars >= DETAIL_TARGET:
                            flush()
                    cur, segs = vid, []
                segs.append([round(float(c.get("start") or 0)), c.get("text") or ""])
        if cur is not None:
            add(cur, segs)
    flush()

    write_min(DATA / "locate.json", locate)

    # topic pages (one small file each)
    tmap = read_json(ALL / "topics.json", {}) or {}
    for topic, items in tmap.items():
        out = []
        for it in sorted(items, key=lambda x: x.get("date") or "", reverse=True):
            if it.get("video_id") in clip_set:
                continue
            mo = [[parse_t(m.get("url")), (m.get("preview") or "")[:170]] for m in it.get("moments") or []]
            out.append({"id": it.get("video_id"), "ch": ch_idx.get(it.get("channel"), 0),
                        "t": it.get("title") or "", "d": it.get("date") or "",
                        "y": TYPE_CODE.get(it.get("type"), 0), "mo": mo})
        write_min(DATA / "t" / f"{topic_slug(topic)}.json", {"label": topic, "items": out})

    meta = {
        "updated": stats.get("updated", ""),
        "counts": {"videos": sum(c["videos"] for c in chans),
                   "lives": sum(c["lives"] for c in chans),
                   "seconds": sum(c["seconds"] for c in chans)},
        "channels": chans,
        "topics": topics_meta,
        "shards": {"list": n_list, "detail": n_detail},
    }
    write_min(DATA / "meta.json", meta)

    (APP / "index.html").write_text(INDEX_HTML, encoding="utf-8")
    (APP / "app.js").write_text(APP_JS, encoding="utf-8")
    write_min(stamp, {"src": src})

    print(f"Built app for {len(rows):,} videos: {n_list} list shard(s), {n_detail} detail shard(s), "
          f"{len(topics_meta)} topics.")
    print(f"Folder: {APP}")


INDEX_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Archive</title>
<style>
:root{--bg:#eef1f4;--panel:#f8fafb;--fg:#18212b;--mut:#5e6b78;--line:#d3dae1;--acc:#1f5f8b;--live:#b9770e;--hit:#fff1c2;--thumb:#d3dae1}
:root[data-theme="dark"]{--bg:#12171d;--panel:#171e25;--fg:#e6ebf0;--mut:#8c99a6;--line:#25313c;--acc:#6fb3e0;--live:#e0a84a;--hit:#4a3d12;--thumb:#25313c}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#12171d;--panel:#171e25;--fg:#e6ebf0;--mut:#8c99a6;--line:#25313c;--acc:#6fb3e0;--live:#e0a84a;--hit:#4a3d12;--thumb:#25313c}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif}
a{color:var(--acc);text-underline-offset:2px}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line)}
.hwrap{max-width:1000px;margin:0 auto;padding:10px 16px;display:flex;gap:16px;align-items:center}
.brand{font-weight:700;letter-spacing:-.01em;text-decoration:none;color:var(--fg)}
nav{display:flex;gap:16px}
nav a{text-decoration:none;color:var(--mut);font-weight:600}
nav a.on{color:var(--fg)}
.sp{flex:1}
.tbtn{all:unset;cursor:pointer;color:var(--mut);font-size:1.2rem;padding:4px 8px;border-radius:6px}
.tbtn:hover{background:var(--panel)}
main{max-width:1000px;margin:0 auto;padding:18px 16px 96px}
h1{font-size:1.6rem;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:1.1rem;margin:26px 0 8px}
.lede{color:var(--mut);margin:0 0 16px;max-width:72ch}
.back{display:inline-block;margin:0 0 12px;text-decoration:none;color:var(--mut);font-weight:600}
.shelf{margin:4px 0 22px;display:grid;gap:10px}
.shelf button{all:unset;cursor:pointer;display:grid;grid-template-columns:minmax(150px,240px) 1fr;gap:14px;align-items:center;padding:6px 8px;border-radius:8px}
.shelf button:hover,.shelf button.on{background:var(--panel)}
.shelf .nm{font-weight:600}.shelf .nm small{display:block;font-weight:400;color:var(--mut);font-size:.82rem}
.shelf .track{height:14px;background:var(--line);border-radius:3px;overflow:hidden;display:flex}
.shelf .vid{background:var(--acc)}.shelf .lv{background:var(--live)}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 6px;position:sticky;top:53px;background:var(--bg);padding:8px 0;z-index:4}
.controls input{flex:1 1 240px}
input,select,button.more{font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg)}
.controls select{flex:1 1 150px}
.count{color:var(--mut);font-size:.9rem;margin:8px 0 4px}
.row{display:grid;grid-template-columns:120px 1fr auto;gap:4px 14px;padding:12px 0;border-top:1px solid var(--line);align-items:start}
.row .thumb{grid-row:span 2;width:120px;aspect-ratio:16/9;border-radius:8px;object-fit:cover;background:var(--thumb);display:block}
.row .t{font-weight:600;line-height:1.3;text-decoration:none}
.row .t:hover{text-decoration:underline}
.row .s{color:var(--mut);font-size:.9rem;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:72ch}
.row .meta2{color:var(--mut);font-size:.85rem;margin-top:4px}
.row .meta2 span+span::before{content:"·";margin:0 7px;color:var(--line)}
.tag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 7px;margin:4px 6px 0 0;font-size:.82rem;color:var(--mut);text-decoration:none;background:var(--panel)}
a.tag:hover{border-color:var(--acc);color:var(--acc)}
.tag.clips{border-color:var(--acc);color:var(--acc);font-weight:600}
.cliplist{display:grid;gap:8px;margin:6px 0 10px}
.clip{display:grid;grid-template-columns:120px 1fr;gap:12px;align-items:center;text-decoration:none;color:var(--fg);padding:4px;border-radius:8px}
.clip:hover{background:var(--panel)}
.clip img{width:120px;aspect-ratio:16/9;object-fit:cover;border-radius:6px;background:var(--thumb)}
.clip small{color:var(--mut)}
@media (max-width:640px){.clip{grid-template-columns:96px 1fr}.clip img{width:96px}}
.live{color:var(--live);border-color:var(--live);font-weight:600}
button.more{cursor:pointer;margin-top:18px}
.vmeta{color:var(--mut);font-size:.92rem;margin:0 0 12px}
.vmeta span+span::before{content:"·";margin:0 8px;color:var(--line)}
.hero{width:100%;max-width:420px;aspect-ratio:16/9;border-radius:12px;object-fit:cover;background:var(--thumb);margin:0 0 14px}
ul.claims{padding-left:20px;max-width:72ch}ul.claims li{margin:6px 0}
.find{position:sticky;top:53px;background:var(--bg);padding:10px 0;z-index:3;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--line)}
.find input{flex:1}
.seg{display:grid;grid-template-columns:76px 1fr;gap:14px;padding:9px 0;border-top:1px solid var(--line)}
.ts{font-variant-numeric:tabular-nums;font-weight:700;text-decoration:none;text-align:right;padding-top:1px}
.seg.hidden{display:none}.seg mark{background:var(--hit);color:inherit;border-radius:2px}
.turn{display:block}.turn+.turn{margin-top:4px}
.note{color:var(--mut);font-size:.88rem}
.tbar{display:grid;grid-template-columns:minmax(150px,280px) 1fr 52px;gap:12px;align-items:center;padding:7px 0;border-top:1px solid var(--line)}
.tbar a{text-decoration:none}.tbar a:hover{text-decoration:underline}
.tbar .track{height:10px;background:var(--line);border-radius:3px;overflow:hidden}.tbar .fill{height:100%;background:var(--acc)}
.tbar .n{text-align:right;color:var(--mut);font-variant-numeric:tabular-nums}
.moment{display:grid;grid-template-columns:76px 1fr;gap:14px;padding:6px 0}
.vtitle{margin:18px 0 2px}
.vtitle a{text-decoration:none}.vtitle a:hover{text-decoration:underline}
@media (max-width:640px){
.row{grid-template-columns:128px 1fr;gap:4px 12px}
.row .c{grid-column:1/-1}
.row .thumb{grid-row:span 3;width:128px}
.controls{top:49px}.find{top:49px}
.seg,.moment{grid-template-columns:60px 1fr;gap:10px}
.tbar{grid-template-columns:1fr 44px}.tbar .track{display:none}
.hwrap{gap:12px}
}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style>
</head>
<body>
<header><div class="hwrap">
<a class="brand" href="#/">Archive</a>
<nav><a href="#/" data-nav="archive">Browse</a><a href="#/topics" data-nav="topics">Topics</a></nav>
<span class="sp"></span>
<button class="tbtn" id="theme" title="Light / dark" aria-label="Toggle light or dark">◐</button>
</div></header>
<main id="app">Loading…</main>
<script src="app.js"></script>
</body>
</html>
"""


APP_JS = r"""
'use strict';
const app = document.getElementById('app');
let META = null, ROWS = null, ROWSNORM = null, LOCATE = null;
const detailCache = {}, topicCache = {};

// ---- helpers ----
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function day(d){ const p=(d||'').split('-'); return p.length===3 ? (+p[2])+' '+MON[+p[1]-1]+' '+p[0] : (d||'?'); }
function durtxt(m){ if(!m) return ''; return m>=60 ? (Math.floor(m/60)+' h '+(m%60)+' min') : (m+' min'); }
function fmtTs(s){ s=Math.floor(s||0); const h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=s%60;
  const p=n=>String(n).padStart(2,'0'); return h ? h+':'+p(m)+':'+p(x) : m+':'+p(x); }
function thumb(id){ return 'https://i.ytimg.com/vi/'+id+'/mqdefault.jpg'; }
function ytlink(id, s){ return 'https://youtu.be/'+id+'?t='+Math.floor(s||0); }

const AR_DIAC = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
function norm(s){
  s = (s||'').replace(AR_DIAC,'').replace(/[أإآٱ]/g,'ا')
      .replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/ؤ/g,'و').replace(/ئ/g,'ي')
      .toLowerCase();
  const words = s.match(/[0-9a-z_؀-ۿ]+/g) || [];
  const out = [];
  for(let w of words){
    if(w.length>5 && ['وال','بال','فال','كال'].includes(w.slice(0,3))) w=w.slice(3);
    else if(w.length>4 && ['لل','ال'].includes(w.slice(0,2))) w=w.slice(2);
    out.push(w);
  }
  return out.join(' ');
}
function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

async function getJSON(path){ const r = await fetch(path); if(!r.ok) throw new Error(path); return r.json(); }

async function loadMeta(){ if(!META) META = await getJSON('data/meta.json'); return META; }
async function loadRows(){
  if(ROWS) return ROWS;
  const n = META.shards.list, parts = [];
  for(let i=0;i<n;i++) parts.push(getJSON('data/list-'+String(i).padStart(3,'0')+'.json'));
  const chunks = await Promise.all(parts);
  ROWS = [].concat.apply([], chunks);
  ROWSNORM = ROWS.map(r => norm((r[6]||'')+' '+(r[8]||'')));
  return ROWS;
}
async function loadLocate(){ if(!LOCATE) LOCATE = await getJSON('data/locate.json'); return LOCATE; }
async function loadDetail(id){
  await loadLocate();
  const sh = LOCATE[id];
  if(sh==null) return null;
  if(!detailCache[sh]){
    const arr = await getJSON('data/detail-'+String(sh).padStart(3,'0')+'.json');
    const map = {}; arr.forEach(v => map[v.id]=v); detailCache[sh]=map;
  }
  return detailCache[sh][id] || null;
}
async function loadTopic(slug){
  if(!topicCache[slug]) topicCache[slug] = await getJSON('data/t/'+slug+'.json');
  return topicCache[slug];
}

// ---- router ----
function setNav(name){ document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav===name)); }
async function route(){
  const h = location.hash || '#/';
  try{
    await loadMeta();
    if(h==='#/'||h==='#'||h==='#/archive'){ setNav('archive'); return renderArchive(); }
    if(h==='#/topics'){ setNav('topics'); return renderTopics(); }
    if(h.startsWith('#/t/')){ setNav('topics'); return renderTopic(decodeURIComponent(h.slice(4))); }
    if(h.startsWith('#/v/')){ setNav('archive'); return renderVideo(decodeURIComponent(h.slice(4))); }
    setNav('archive'); renderArchive();
  }catch(e){ app.innerHTML = '<p class="note">Could not load the data for this page. If you opened the file directly, it needs to be served (run START and open the archive).</p>'; }
}

// ---- archive ----
const view = { ch:-1, shown:150, q:'', ty:'', tp:'', so:'new' };
async function renderArchive(){
  app.innerHTML = '<p class="note">Loading videos…</p>';
  await loadRows();
  const c = META.counts;
  const most = Math.max.apply(null, META.channels.map(x=>x.seconds).concat([1])) || 1;
  const shelf = META.channels.map((ch,i) => {
    const lv = Math.min(ch.live_seconds||0, ch.seconds||0);
    return '<button data-ci="'+i+'"><span class="nm"><bdi>'+esc(ch.name)+'</bdi><small>'+
      ch.videos.toLocaleString()+' videos, '+ch.lives.toLocaleString()+' lives, '+fmtHours(ch.seconds)+'</small></span>'+
      '<span class="track" style="width:'+Math.max(4,(ch.seconds/most*100)).toFixed(1)+'%">'+
      '<span class="vid" style="flex:'+Math.max(ch.seconds-lv,0).toFixed(0)+'"></span>'+
      '<span class="lv" style="flex:'+lv.toFixed(0)+'"></span></span></button>';
  }).join('');
  const topOpts = META.topics.map(t => '<option value="'+esc(t[0])+'">'+esc(t[0])+' ('+t[1]+')</option>').join('');
  app.innerHTML =
    '<h1>Archive</h1><p class="lede">'+c.videos.toLocaleString()+' transcripts, '+fmtHours(c.seconds)+
    ' of video across '+META.channels.length+' channel'+(META.channels.length===1?'':'s')+'. Pick a channel to narrow the list.'+(META.updated?' Updated '+day(META.updated.slice(0,10))+'.':'')+'</p>'+
    '<div class="shelf">'+shelf+'</div>'+
    '<div class="controls"><input id="q" type="search" placeholder="Search titles and summaries" value="'+esc(view.q)+'">'+
    '<select id="ty"><option value="">Videos and lives</option><option value="video">Videos only</option><option value="live">Lives only</option><option value="short">Shorts only</option></select>'+
    '<select id="tp"><option value="">Any topic</option>'+topOpts+'</select>'+
    '<select id="so"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="long">Longest first</option><option value="views">Most viewed</option></select></div>'+
    '<p class="count" id="count"></p><div id="rows"></div><button class="more" id="more" hidden>Show more</button>';
  const $ = id => document.getElementById(id);
  $('ty').value=view.ty; $('tp').value=view.tp; $('so').value=view.so;
  document.querySelectorAll('.shelf button').forEach(b => {
    b.classList.toggle('on', +b.dataset.ci===view.ch);
    b.addEventListener('click', () => { const ci=+b.dataset.ci; view.ch = view.ch===ci?-1:ci; view.shown=150;
      document.querySelectorAll('.shelf button').forEach(x=>x.classList.toggle('on',+x.dataset.ci===view.ch)); listRows(); });
  });
  let t=null;
  $('q').addEventListener('input', e => { clearTimeout(t); t=setTimeout(()=>{ view.q=e.target.value; view.shown=150; listRows(); },160); });
  ['ty','tp','so'].forEach(id => $(id).addEventListener('change', e => { view[id]=e.target.value; view.shown=150; listRows(); }));
  $('more').addEventListener('click', () => { view.shown+=300; listRows(); });
  listRows();
}

function listRows(){
  const q = norm(view.q), ty = view.ty, tp = view.tp, so = view.so;
  const tpIdx = tp ? (META.topics.findIndex(t=>t[0]===tp)) : -1;
  let r = [];
  for(let i=0;i<ROWS.length;i++){
    const d = ROWS[i];
    if(view.ch>=0 && d[1]!==view.ch) continue;
    if(ty && ['video','live','short'][d[2]]!==ty) continue;
    if(tpIdx>=0 && !d[7].includes(tpIdx)) continue;
    if(q && ROWSNORM[i].indexOf(q)<0) continue;
    r.push(d);
  }
  if(so==='old') r.sort((a,b)=>(a[3]||'').localeCompare(b[3]||''));
  else if(so==='long') r.sort((a,b)=>b[4]-a[4]);
  else if(so==='views') r.sort((a,b)=>b[5]-a[5]);
  else r.sort((a,b)=>(b[3]||'').localeCompare(a[3]||''));
  const hrs = r.reduce((a,d)=>a+d[4],0)/60;
  document.getElementById('count').textContent =
    r.length.toLocaleString()+' of '+ROWS.length.toLocaleString()+' videos, '+(hrs>=10?Math.round(hrs).toLocaleString():hrs.toFixed(1))+' hours';
  const slice = r.slice(0, view.shown);
  document.getElementById('rows').innerHTML = slice.map(d => {
    const clips = d[9] ? '<a class="tag clips" href="#/v/'+esc(d[0])+'">▸ '+d[9]+' clip'+(d[9]===1?'':'s')+'</a>' : '';
    const tags = (d[2]===1?'<span class="tag live">Live</span>':'') + clips +
      d[7].slice(0,4).map(ti => '<a class="tag" href="#/t/'+encodeURIComponent(META.topics[ti][2])+'">'+esc(META.topics[ti][0])+'</a>').join('');
    return '<div class="row"><img class="thumb" loading="lazy" src="'+thumb(d[0])+'" alt="" onerror="this.style.visibility=\'hidden\'">'+
      '<div><a class="t" dir="auto" href="#/v/'+esc(d[0])+'">'+esc(d[6])+'</a>'+
      (d[8]?'<div class="s" dir="auto">'+esc(d[8])+'</div>':'')+
      '<div>'+tags+'</div></div>'+
      '<div class="meta2"><span>'+esc(day(d[3]))+'</span>'+(d[4]?'<span>'+durtxt(d[4])+'</span>':'')+
      (d[5]?'<span>'+d[5].toLocaleString()+' views</span>':'')+'</div></div>';
  }).join('');
  document.getElementById('more').hidden = r.length<=view.shown;
}

// ---- topics ----
async function renderTopics(){
  const items = META.topics;
  const most = Math.max.apply(null, items.map(t=>t[1]).concat([1])) || 1;
  const rows = items.map(t => '<div class="tbar"><a href="#/t/'+encodeURIComponent(t[2])+'">'+esc(t[0].charAt(0).toUpperCase()+t[0].slice(1))+'</a>'+
    '<span class="track"><span class="fill" style="width:'+(t[1]/most*100).toFixed(1)+'%"></span></span><span class="n">'+t[1].toLocaleString()+'</span></div>').join('');
  app.innerHTML = '<h1>Topics</h1><p class="lede">'+items.length.toLocaleString()+' topics, by how many videos discuss them. Each page lists the exact moments.</p>'+rows;
  window.scrollTo(0,0);
}

async function renderTopic(slug){
  app.innerHTML = '<p class="note">Loading…</p>';
  let data; try{ data = await loadTopic(slug); }catch(e){ app.innerHTML='<a class="back" href="#/topics">← Topics</a><p class="note">Topic not found.</p>'; return; }
  const cap = data.label.charAt(0).toUpperCase()+data.label.slice(1);
  let html = '<a class="back" href="#/topics">← Topics</a><h1>'+esc(cap)+'</h1><p class="lede">Discussed in '+
    data.items.length.toLocaleString()+' video'+(data.items.length===1?'':'s')+'. Times open the video at that moment.</p>';
  html += data.items.map(it => {
    const live = it.y===1 ? ' <span class="tag live">Live</span>' : '';
    const ch = (META.channels[it.ch]||{}).name || '';
    const mo = (it.mo||[]).map(m => '<div class="moment"><a class="ts" href="'+ytlink(it.id,m[0])+'">'+fmtTs(m[0])+'</a><div dir="auto">'+esc((m[1]||'').replace(/\s*>>\s*/g,' » '))+'…</div></div>').join('');
    return '<h2 class="vtitle"><a dir="auto" href="#/v/'+esc(it.id)+'">'+esc(it.t)+'</a>'+live+'</h2>'+
      '<p class="vmeta"><span><bdi>'+esc(ch)+'</bdi></span><span>'+esc(day(it.d))+'</span></p>'+mo;
  }).join('');
  app.innerHTML = html; window.scrollTo(0,0);
}

// ---- video ----
async function renderVideo(id){
  app.innerHTML = '<p class="note">Loading…</p>';
  let v; try{ v = await loadDetail(id); }catch(e){ v=null; }
  if(!v){ app.innerHTML = '<a class="back" href="#/">← Browse</a><p class="note">This video is not in the archive, or the data is still being built.</p>'; return; }
  const ch = (META.channels[v.ch]||{}).name || '';
  const kind = v.y===1?'<span class="tag live">Live stream</span>':(v.y===2?'<span class="tag">Short</span>':'');
  const chips = kind + (v.td||[]).map(t => '<a class="tag" href="#/t/'+encodeURIComponent(t[1])+'">'+esc(t[0])+'</a>').join('');
  let meta = '<span><bdi>'+esc(ch)+'</bdi></span><span>'+esc(day(v.d))+'</span>';
  if(v.m) meta += '<span>'+fmtTs(v.m*60)+'</span>';
  if(v.v) meta += '<span>'+v.v.toLocaleString()+' views</span>';
  meta += '<span><a href="'+esc(v.url)+'" target="_blank" rel="noopener">Watch on YouTube</a></span>';
  let html = '<a class="back" href="#/">← Browse</a><h1 dir="auto">'+esc(v.t)+'</h1><p class="vmeta">'+meta+'</p>';
  if(v.par) html += '<p class="note">◂ Clip of <a href="#/v/'+esc(v.par[0])+'" dir="auto">'+esc(v.par[1])+'</a></p>';
  html += '<img class="hero" loading="lazy" src="https://i.ytimg.com/vi/'+id+'/hqdefault.jpg" alt="" onerror="this.onerror=null;this.src=\''+thumb(id)+'\'">';
  if(chips) html += '<p>'+chips+'</p>';
  if(v.s) html += '<p dir="auto">'+esc(v.s)+'</p>';
  if(v.w) html += '<p class="note">With: '+esc(v.w)+'</p>';
  if(v.c && v.c.length){
    html += '<h2>Key claims</h2><ul class="claims">'+v.c.map(c =>
      '<li dir="auto">'+esc(c[0])+(c[2]?' <a href="'+esc(c[2])+'">'+esc(c[1])+'</a>':'')+'</li>').join('')+'</ul>';
  }
  if(v.cl && v.cl.length){
    html += '<h2>Clips from this video ('+v.cl.length+')</h2><div class="cliplist">'+
      v.cl.map(c => '<a class="clip" href="#/v/'+esc(c[0])+'"><img loading="lazy" src="'+thumb(c[0])+'" alt="" onerror="this.style.visibility=\'hidden\'"><span dir="auto">'+esc(c[1])+(c[2]?' <small>'+durtxt(c[2])+'</small>':'')+'</span></a>').join('')+'</div>';
  }
  html += '<h2>Transcript</h2><p class="note">Auto-generated captions, so names and Arabic terms may be misspelled. Each time opens the video at that moment. » marks a new speaker.</p>';
  html += '<div class="find"><input id="f" type="search" placeholder="Find in transcript"><span class="note" id="fc"></span></div><div id="tx">';
  html += (v.g||[]).map(seg => {
    const turns = String(seg[1]||'').split(/\s*>>\s*/).filter(Boolean);
    const body = turns.map((t,i)=>'<span class="turn">'+(i?'» ':'')+esc(t)+'</span>').join('');
    return '<div class="seg"><a class="ts" href="'+ytlink(id,seg[0])+'">'+fmtTs(seg[0])+'</a><div dir="auto">'+body+'</div></div>';
  }).join('');
  html += '</div>';
  app.innerHTML = html; window.scrollTo(0,0);
  setupFind();
}

function setupFind(){
  const f = document.getElementById('f'), fc = document.getElementById('fc');
  if(!f) return;
  const segs = [...document.querySelectorAll('.seg')].map(s => ({el:s, box:s.children[1], html:s.children[1].innerHTML, txt:s.children[1].textContent.toLowerCase()}));
  let t=null;
  f.addEventListener('input', () => { clearTimeout(t); t=setTimeout(() => {
    const q = f.value.trim().toLowerCase(); let n=0;
    segs.forEach(s => {
      if(!q){ s.el.classList.remove('hidden'); s.box.innerHTML=s.html; return; }
      const hit = s.txt.indexOf(q)>=0; s.el.classList.toggle('hidden', !hit);
      s.box.innerHTML = hit ? s.html.replace(new RegExp('('+escRe(q)+')(?![^<]*>)','gi'),'<mark>$1</mark>') : s.html;
      if(hit) n++;
    });
    fc.textContent = q ? (n+' of '+segs.length+' moments') : '';
  },160); });
}

function fmtHours(sec){ sec=+sec||0; if(sec>=36000) return Math.round(sec/3600).toLocaleString()+' h'; if(sec>=3600) return (sec/3600).toFixed(1)+' h'; return Math.round(sec/60)+' min'; }

// ---- theme ----
(function(){
  const btn = document.getElementById('theme');
  let cur = null;
  try{ cur = localStorage.getItem('theme'); }catch(e){}
  if(cur) document.documentElement.setAttribute('data-theme', cur);
  btn.addEventListener('click', () => {
    const dark = matchMedia('(prefers-color-scheme:dark)').matches;
    const now = document.documentElement.getAttribute('data-theme');
    const next = now ? (now==='dark'?'light':'dark') : (dark?'light':'dark');
    document.documentElement.setAttribute('data-theme', next);
    try{ localStorage.setItem('theme', next); }catch(e){}
  });
})();

window.addEventListener('hashchange', route);
route();
"""


if __name__ == "__main__":
    build()
