"""
YouTube Archive v2

Turns YouTube channels into a searchable, readable archive with timestamp links.
Run START.bat for the menu, ask.bat to go straight to questions.

Command line (optional):
  python app.py            menu
  python app.py update     update all channels (asks before spending)
  python app.py overnight  set a budget once, then update with no questions
  python app.py ask        ask questions
  python app.py balance    show balances / spending
"""
import csv
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import warnings
from urllib.parse import quote, unquote
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from threading import Lock, Thread, local
from queue import Queue, Empty

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
warnings.filterwarnings("ignore")

from dotenv import load_dotenv  # noqa: E402

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

OUTPUT = ROOT / "output"
ALL = OUTPUT / "ALL"
ANSWERS = OUTPUT / "answers"
SETTINGS_PATH = ROOT / "settings.json"
SPEND_PATH = OUTPUT / "spend.json"
TOPIC_MAP_PATH = OUTPUT / "topic_map.json"

LIST_ACTOR = "eiv/youtube-channel-scraper"      # paid backup lister: full lists with durations, no 1,000 cap
STREAMS_ACTOR = "streamers/youtube-scraper"
TRANSCRIPT_ACTOR = "codepoetry/youtube-transcript-ai-scraper"

# rough Apify prices per item, used only for estimates (real cost is read from each run)
EST_LIST = 0.0003
EST_STREAM_LIST = 0.004
EST_TRANSCRIPT = 0.0009       # codepoetry: ~$0.0009 per successfully transcribed video (failures free)

# Claude prices, USD per million tokens: (input, output, input_over_100k, output_over_100k)
PRICES = {
    "claude-haiku-5-5": (0.10, 0.50, 0.50, 2.50),
    "claude-sonnet-5-5": (2.0, 10.0, 2.0, 10.0),
    "claude-opus-5-5": (5.0, 25.0, 5.0, 25.0),
}

SEARCH_MODELS = {
    "english": "BAAI/bge-small-en-v1.5",
    "multilingual": "intfloat/multilingual-e5-large",
}

TAG_VERSION = 2               # bump when the tagging method changes; older tags can be redone from Settings
CHUNK_SECONDS = 60
BUNDLE_SIZE = 20
TAG_WINDOW_WORDS = 45000      # long lives are tagged in parts to stay in the cheap price band
TAG_WORKERS = 4
BATCH_TAG_THRESHOLD = 30       # tag this many or more videos via the cheaper Message Batches API (auto mode)
TRANSCRIPT_BATCH = 50          # max videos per batch
MIN_BATCH = 10
PARALLEL_BATCHES = 8          # live download parallelism: seeded then auto-tuned (AIMD) each run
PARALLEL_CEILING = 24         # hard ceiling for the auto-tuner (YouTube blocks before Apify's run limit)
MINUTES_PER_BATCH = 4         # observed: one batch of 50 takes ~4 min on Apify
MAX_FAIL_ATTEMPTS = 3
DEEP_THRESHOLD = 19500        # the YouTube Data API only exposes ~20k uploads; above this, list the full history with yt-dlp

SEED_TOPICS = [
    "trinity", "divinity of jesus", "crucifixion and resurrection", "paul",
    "bible reliability", "biblical prophecy of muhammad", "quran preservation",
    "quran miracles", "hadith", "prophet muhammad's life", "aisha's age",
    "shia beliefs", "sahaba (companions)", "judaism", "talmud",
    "israel-palestine", "atheism and existence of god", "morality",
    "women in islam", "jihad and violence", "sharia", "salvation and afterlife",
    "dawah approach", "debate tactics", "sponsor",
]

# ---------------------------------------------------------------- terminal ui

if os.name == "nt":
    os.system("")  # turns on colors in the Windows console
B, G, Y, R, D, X = "\033[1m", "\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[0m"
C = "\033[36m"  # cyan accent
_ANSI = re.compile(r"\033\[[0-9;]*m")


def term_width():
    try:
        import shutil
        return max(60, min(shutil.get_terminal_size((100, 30)).columns, 140))
    except Exception:
        return 100


def visible_len(text):
    return len(_ANSI.sub("", text))


def clip(text, width):
    """Cut a colored string to a visible width without breaking color codes."""
    out, n, i = [], 0, 0
    while i < len(text):
        m = _ANSI.match(text, i)
        if m:
            out.append(m.group(0))
            i = m.end()
            continue
        if n >= width - 1:
            out.append("…")
            break
        out.append(text[i])
        n += 1
        i += 1
    return "".join(out) + X


_last_status = [0]


_STATUS_QUIET = local()  # background threads (lister, index belt) set .on so they never fight the main status line


def status(text):
    """Rewrite the current line in place. Never wraps, so it can't flood the screen."""
    if getattr(_STATUS_QUIET, "on", False):
        return
    text = _redact(text)
    w = term_width() - 1
    line = clip(text, w) if visible_len(text) > w else text
    pad = max(0, _last_status[0] - visible_len(line))
    sys.stdout.write("\r" + line + " " * pad)
    sys.stdout.flush()
    _last_status[0] = visible_len(line)


def status_done():
    if getattr(_STATUS_QUIET, "on", False):
        return
    if _last_status[0]:
        sys.stdout.write("\n")
        sys.stdout.flush()
    _last_status[0] = 0


def bar(done, total, width=22):
    frac = 0 if not total else max(0.0, min(1.0, done / total))
    full = int(frac * width)
    return f"{G}{'█' * full}{D}{'░' * (width - full)}{X} {int(frac * 100):>3}%"


def fmt_hours(sec):
    sec = float(sec or 0)
    if sec >= 3600 * 10:
        return f"{sec / 3600:,.0f} h"
    if sec >= 3600:
        return f"{sec / 3600:.1f} h"
    return f"{sec / 60:.0f} min"


def fmt_duration(sec):
    sec = int(sec or 0)
    if sec < 60:
        return f"{sec} s"
    if sec < 3600:
        return f"{round(sec / 60)} min"
    return f"{sec // 3600} h {sec % 3600 // 60} min"


def fmt_eta(sec):
    if sec is None or sec < 0:
        return ""
    sec = int(sec)
    if sec < 60:
        return "<1 min left"
    if sec < 3600:
        return f"~{sec // 60} min left"
    return f"~{sec // 3600} h {sec % 3600 // 60} min left"


_SECRET_ENV = ("APIFY_TOKEN", "ANTHROPIC_API_KEY", "YOUTUBE_API_KEY", "GITHUB_TOKEN", "BRAIN_KEY")


def _redact(text):
    """Strip any of our API keys out of a string before it is printed or logged. The YouTube Data
    API passes its key in the request URL, so an error message can otherwise echo it verbatim."""
    s = str(text)
    for k in _SECRET_ENV:
        v = os.environ.get(k)
        if v and len(v) >= 6:
            s = s.replace(v, "***")
    return s


def say(msg=""):
    if _last_status[0]:
        if not str(msg).startswith("\n"):
            sys.stdout.write("\n")
        _last_status[0] = 0
    print(_redact(msg), flush=True)


def ok(msg):
    say(f"{G}{msg}{X}")


def warn(msg):
    say(f"{Y}{msg}{X}")


def err(msg):
    say(f"{R}{msg}{X}")


def head(msg):
    status_done()
    w = min(term_width(), 100)
    say(f"\n{C}──{X} {B}{msg}{X} {C}{'─' * max(3, w - visible_len(msg) - 4)}{X}")


def yes(question):
    if os.getenv("AUTO_YES") == "1":
        return True
    while True:
        a = input(f"{question}\n  Type {B}y{X} and press Enter to go ahead, or {B}n{X} to skip: ").strip().lower()
        if a in ("y", "yes"):
            return True
        if a in ("n", "no"):
            return False


def choose(prompt, options, allow_blank=False):
    """options: list of (key, label). Returns key, or '' when blank allowed."""
    for k, label in options:
        say(f"  {B}{k}{X}  {label}")
    keys = {str(k) for k, _ in options}
    while True:
        a = input(f"{prompt}: ").strip()
        if a == "" and allow_blank:
            return ""
        if a in keys:
            return a


def pause():
    if os.getenv("AUTO_YES") != "1":
        input(f"\n{D}Press Enter to go back to the menu...{X}")


def plural(n, word):
    return f"{n} {word}" + ("" if n == 1 else "s")


def money(x):
    return f"${x:,.2f}" if x >= 0.01 or x == 0 else f"${x:,.3f}"


# ---------------------------------------------------------------- small helpers

def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return default


def read_obj(path):
    """read_json but guaranteed a dict: a missing, corrupt, or wrong-typed file (e.g. one that
    parses to a bare string or list) becomes {} instead of blowing up a later .get()."""
    d = read_json(path, {})
    return d if isinstance(d, dict) else {}


def read_list(path):
    """read_json but guaranteed a list: anything that isn't a JSON array becomes []."""
    d = read_json(path, [])
    return d if isinstance(d, list) else []


def replace_file(tmp, path):
    for attempt in range(10):  # on Windows another window may be reading the file for a moment
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.5)


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    replace_file(tmp, path)


def fmt_ts(sec):
    sec = int(float(sec or 0))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def link(vid, sec=0):
    return f"https://youtu.be/{vid}?t={int(float(sec or 0))}"


def safe_name(text, limit=70):
    text = re.sub(r"[^\w\s-]", "", text or "").strip()
    text = re.sub(r"\s+", "-", text)
    return text[:limit].strip("-") or "untitled"


def parse_duration(val):
    if val in (None, ""):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    parts = str(val).strip().split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return None
    sec = 0.0
    for n in nums:
        sec = sec * 60 + n
    return sec


def g(obj, *names, default=None):
    """Read a field from either a dict or an object (Apify client versions differ)."""
    for n in names:
        if obj is None:
            break
        v = obj.get(n) if isinstance(obj, dict) else getattr(obj, n, None)
        if v is not None:
            return v
    return default


def status_str(s):
    return str(getattr(s, "value", s) or "").upper()


def need_key(name):
    v = (os.getenv(name) or "").strip()
    if not v or v.startswith("paste"):
        return None
    return v


# ---------------------------------------------------------------- settings & channels

DEFAULT_SETTINGS = {
    "channels": [],
    "answer_language": "auto",
    "search_model": "english",
    "tag_model": "claude-haiku-5-5",
    "answer_model": "claude-sonnet-5-5",
    "tag_workers": 4,
    "tag_mode": "auto",
}


_HARAKAT = re.compile(r"[ؐ-ًؚ-ٰٟۖ-ۭـ]")
_AR_LATIN = {
    "ا": "a", "أ": "a", "إ": "i", "آ": "a", "ٱ": "a", "ء": "", "ؤ": "u", "ئ": "i", "ى": "a",
    "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh", "د": "d", "ذ": "dh", "ر": "r",
    "ز": "z", "س": "s", "ش": "sh", "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh",
    "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "ة": "h", "و": "w", "ي": "y",
}


def translit_ar(text):
    """Rough Arabic-to-Latin so Arabic handles get a readable folder name instead of hex."""
    text = _HARAKAT.sub("", text or "")
    return "".join(_AR_LATIN.get(c, c) for c in text)


def slug_for(handle):
    h = unquote(handle.strip()).rstrip("/")
    for tail in ("/videos", "/streams", "/shorts", "/featured", "/live"):
        if h.endswith(tail):
            h = h[: -len(tail)]
    s = h.split("@")[-1] if "@" in h else h.split("/")[-1]
    s = re.sub(r"\s+", "_", translit_ar(s).strip())
    s = re.sub(r"[^A-Za-z0-9_-]", "", s)
    s = re.sub(r"[_-]{2,}", "_", s).strip("_-")
    if not s:
        import hashlib
        s = "ch_" + hashlib.md5(handle.encode("utf-8")).hexdigest()[:8]
    return s[:60] or "channel"


def normalize_handle(text):
    t = text.strip()
    if not t:
        return ""
    if "youtube.com" in t or "youtu.be" in t:
        t = t.split("?")[0].rstrip("/")
        for tail in ("/videos", "/streams", "/shorts", "/featured", "/live"):
            if t.endswith(tail):
                t = t[: -len(tail)]
        m = re.search(r"youtube\.com/(@[^/]+)", t)
        if m:
            return unquote(m.group(1))
        if not t.startswith("http"):
            t = "https://" + t
        return t
    return unquote(t) if t.startswith("@") else "@" + unquote(t)


def new_channel(handle, language="en", lives=True, shorts=False):
    return {"handle": handle, "slug": slug_for(handle), "name": None, "language": language,
            "videos": True, "lives": lives, "shorts": shorts, "max_videos": 0, "full_refresh": False,
            "min_minutes": 0, "playlist": None, "title_include": [], "title_exclude": [],
            "search": "keyword" if language != "en" else "semantic"}


def length_ok(ch, v):
    mn = float(ch.get("min_minutes") or 0)
    if not mn:
        return True
    d = v.get("durationSeconds")
    if d is None:
        return False  # unknown length on a min-length channel: skip, so we never pay for maybe-short clips
    return float(d) >= mn * 60


def title_ok(ch, v):
    """Per-channel title filter: keep a video only if its title contains one of the 'include' words
    (when any are set) and none of the 'exclude' words. Case-insensitive substring match."""
    inc = ch.get("title_include") or []
    exc = ch.get("title_exclude") or []
    if not inc and not exc:
        return True
    t = (v.get("title") or "").lower()
    if exc and any(str(w).lower() in t for w in exc):
        return False
    if inc and not any(str(w).lower() in t for w in inc):
        return False
    return True


def load_settings():
    s = read_obj(SETTINGS_PATH)
    for k, v in DEFAULT_SETTINGS.items():
        s.setdefault(k, v if not isinstance(v, list) else list(v))
    if not s["channels"]:
        handle = normalize_handle(os.getenv("CHANNEL") or "@MuslimOrthodoxy")
        ch = new_channel(handle)
        try:
            ch["max_videos"] = int(os.getenv("MAX_VIDEOS") or 0)
        except ValueError:
            pass
        s["channels"].append(ch)
        save_settings(s)
    for ch in s["channels"]:
        for k, v in new_channel(ch["handle"], ch.get("language") or "en").items():
            ch.setdefault(k, v)
    return s


def save_settings(s):
    write_json(SETTINGS_PATH, s)


def cpaths(ch):
    base = OUTPUT / ch["slug"]
    return {
        "base": base, "raw": base / "raw", "tags": base / "tags", "read": base / "read",
        "topics": base / "topics", "nlm": base / "notebooklm", "data": base / "data",
        "search": base / "search", "list": base / "video_list.json", "failed": base / "failed.json",
    }


def full_name(ch):
    """The channel's real name, for the website and data files."""
    return ch.get("name") or ch["handle"]


def channel_label(ch):
    """Name for this window. Arabic shows backwards in the Windows console, so those channels go by a
    Latin label: the @handle when it's Latin, otherwise the (transliterated) slug."""
    name = full_name(ch)
    if re.search(r"[\u0590-\u08FF]", name):
        h = ch.get("handle", "")
        if h and not h.startswith("http") and not re.search(r"[\u0590-\u08FF]", h):
            return h
        return ch.get("slug") or h
    return name


def channel_url(ch):
    h = ch["handle"]
    return h if h.startswith("http") else "https://www.youtube.com/" + quote(h, safe="@._-")


def load_listing(ch):
    """Returns (meta, videos). Handles the old v1 format (a plain list)."""
    data = read_json(cpaths(ch)["list"], None)
    if data is None:
        return {"fetched": {}}, []
    if isinstance(data, list):
        for v in data:
            v.setdefault("type", "video")
        return {"fetched": {"video": True}}, data
    if not isinstance(data, dict):  # a corrupt list file could parse to something else
        return {"fetched": {}}, []
    return data.get("meta", {"fetched": {}}), data.get("videos", [])


def save_listing(ch, meta, videos):
    write_json(cpaths(ch)["list"], {"meta": meta, "videos": videos})


def load_failed(ch):
    data = read_json(cpaths(ch)["failed"], {}) or {}
    out = {}
    for k, v in data.items():
        out[k] = v if isinstance(v, dict) else {"reason": v, "attempts": 1}
    return out


# ---------------------------------------------------------------- spending

_spend_lock = Lock()


def add_spend(service, usd, note, channel=None):
    if not usd:
        return
    with _spend_lock:
        led = read_list(SPEND_PATH)
        led.append({"when": datetime.now().isoformat(timespec="seconds"), "service": service,
                    "usd": round(float(usd), 5), "note": note, "channel": channel})
        write_json(SPEND_PATH, led)


def spend_totals():
    led = read_list(SPEND_PATH)
    month = datetime.now().strftime("%Y-%m")
    tot = {}
    for e in led:
        svc = e["service"]
        t = tot.setdefault(svc, {"all": 0.0, "month": 0.0})
        t["all"] += e["usd"]
        if e["when"].startswith(month):
            t["month"] += e["usd"]
    return tot, led


PERF_PATH = OUTPUT / "perf.json"
STATS_PATH = OUTPUT / "stats.json"


def record_perf(key, value):
    """Remember how fast this PC/account actually is, so estimates get better each run."""
    perf = read_obj(PERF_PATH)
    old = perf.get(key)
    perf[key] = round(value if old is None else old * 0.5 + value * 0.5, 4)
    write_json(PERF_PATH, perf)


def get_perf(key, default):
    return read_obj(PERF_PATH).get(key) or default


BUDGET = None  # overnight mode: {"apify": usd, "claude": usd, "start": iso time}


class BudgetReached(Exception):
    pass


def spent_since(start, service):
    led = read_list(SPEND_PATH)
    return sum(e["usd"] for e in led if e["service"] == service and e["when"] >= start)


def budget_left(service):
    if not BUDGET:
        return None
    return max(BUDGET[service] - spent_since(BUDGET["start"], service), 0.0)


def keep_awake(on):
    """Stops Windows from sleeping while an update runs (the screen can still turn off)."""
    if os.name != "nt":
        return
    try:
        import ctypes
        flags = 0x80000000 | (0x00000001 if on else 0)  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        ctypes.windll.kernel32.SetThreadExecutionState(flags)
    except Exception:
        pass


def apify_balance():
    token = need_key("APIFY_TOKEN")
    if not token:
        return None
    try:
        req = urllib.request.Request("https://api.apify.com/v2/users/me/limits",
                                     headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.load(r)["data"]
        used = float(d["current"]["monthlyUsageUsd"])
        limit = float(d["limits"]["maxMonthlyUsageUsd"])
        end = (d.get("monthlyUsageCycle") or {}).get("endAt", "")[:10]
        lim, cur = d.get("limits") or {}, d.get("current") or {}
        return {"used": used, "limit": limit, "left": max(limit - used, 0.0), "resets": end,
                "max_runs": lim.get("maxConcurrentActorJobs"), "max_mem_gb": lim.get("maxActorMemoryGbytes"),
                "running": cur.get("activeActorJobCount")}
    except Exception:
        return None


def balance_line():
    b = apify_balance()
    tot, _ = spend_totals()
    claude = tot.get("claude", {})
    if b:
        color = G if b["left"] > 1 else (Y if b["left"] > 0.25 else R)
        a = f"Apify: {color}{money(b['left'])} left{X} ({money(b['used'])} of {money(b['limit'])} used, resets {b['resets']})"
    else:
        a = "Apify: balance unavailable (check APIFY_TOKEN in .env)"
    c = (f"Claude: {money(claude.get('month', 0))} spent by this tool this month. "
         f"Balance: console.anthropic.com/settings/billing")
    return a, c, b


def claude_cost(model, usage):
    p = PRICES.get(model, (1.0, 5.0, 1.0, 5.0))
    inp = (g(usage, "input_tokens", default=0) or 0) + (g(usage, "cache_creation_input_tokens", default=0) or 0)
    out = g(usage, "output_tokens", default=0) or 0
    long_ctx = inp > 100_000
    pin, pout = (p[2], p[3]) if long_ctx else (p[0], p[1])
    return inp / 1e6 * pin + out / 1e6 * pout


# ---------------------------------------------------------------- apify

def apify_client():
    from apify_client import ApifyClient
    token = need_key("APIFY_TOKEN")
    if not token:
        raise SystemExit("APIFY_TOKEN missing in .env")
    return ApifyClient(token)


def run_actor(client, actor, run_input, label, expected=None, on_start=None):
    run_id, ds = start_actor(client, actor, run_input)
    if on_start:
        on_start(run_id, ds)
    st, usd = wait_run(client, run_id, ds, label, expected)
    return ds, st, usd


def start_actor(client, actor, run_input):
    cap = budget_left("apify")
    if cap is not None and cap < 0.02:
        raise BudgetReached("Apify budget for this run is used up")
    if cap is not None:
        from decimal import Decimal
        try:
            run = client.actor(actor).start(run_input=run_input, max_total_charge_usd=Decimal(str(round(cap, 2))))
        except TypeError:  # older client without spend caps
            run = client.actor(actor).start(run_input=run_input)
    else:
        run = client.actor(actor).start(run_input=run_input)
    return g(run, "id"), g(run, "default_dataset_id", "defaultDatasetId")


def wait_run(client, run_id, ds, label, expected=None):
    t0 = time.time()
    info, st = None, ""
    while True:
        time.sleep(4)
        try:
            info = client.run(run_id).get() or info
        except Exception:
            pass
        st = status_str(g(info, "status"))
        n = None
        try:
            n = g(client.dataset(ds).get(), "item_count", "itemCount")
        except Exception:
            pass
        el = int(time.time() - t0)
        if n is not None and expected:
            status(f"    {label}  {bar(n, expected, 16)}  {n}/{expected} · {el // 60}m {el % 60:02d}s")
        else:
            status(f"    {label}: {n if n is not None else '…'} found · {el // 60}m {el % 60:02d}s")
        if st in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT", "TIMEDOUT"):
            break
        if time.time() - t0 > 3 * 3600:
            warn("\n    gave up waiting after 3 hours, using what finished")
            break
    status_done()
    usd = g(info, "usage_total_usd", "usageTotalUsd")
    try:
        usd = float(usd) if usd is not None else None
    except (TypeError, ValueError):
        usd = None
    return st, usd


def dataset_items(client, ds):
    for attempt in range(4):
        try:
            return list(client.dataset(ds).iterate_items())
        except Exception:
            if attempt == 3:
                raise
            time.sleep(15)


def norm_listing(it, kind):
    if it.get("recordType") == "channel" or it.get("success") is False:
        return None
    if it.get("recordType") == "video":  # eiv scraper format
        kind = "short" if it.get("isShort") else ("live" if it.get("isLive") else "video")
        it = {"id": it.get("videoId"), "title": it.get("title"), "date": it.get("publishedAt"),
              "viewCount": it.get("viewCount"), "durationSeconds": it.get("durationSeconds"),
              "description": it.get("descriptionSnippet"), "streamType": "ended" if kind == "live" else None}
    vid = it.get("id")
    if not vid or it.get("isMembersOnly"):
        return None
    if kind == "live" and it.get("streamType") not in (None, "ended"):
        return None  # still live or upcoming: no transcript yet
    dur = it.get("durationSeconds") or parse_duration(it.get("duration"))
    return {
        "videoId": vid, "type": kind, "title": it.get("title"),
        "url": f"https://www.youtube.com/watch?v={vid}",
        "date": (it.get("date") or "")[:10], "views": it.get("viewCount"),
        "likes": it.get("likes"), "comments": it.get("commentsCount"),
        "durationSeconds": dur,
        "description": (it.get("description") or it.get("text") or "")[:3000],
    }


YTDLP_MAX_AGE_DAYS = 45
FREE_LIST = {}


def ensure_ytdlp():
    """Channel lists come free from yt-dlp on this PC. YouTube changes often, so keep it fresh."""
    if "ok" in FREE_LIST:
        return FREE_LIST["ok"]
    try:
        from importlib.metadata import version
        v = version("yt-dlp")
        age = (datetime.now() - datetime.strptime(".".join(v.split(".")[:3]), "%Y.%m.%d")).days
    except Exception:
        age = 9999
    if age > YTDLP_MAX_AGE_DAYS:
        status("    updating the free channel lister (yt-dlp)...")
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", "-U", "-q", "yt-dlp"],
                           capture_output=True, timeout=300)
        except Exception:
            pass
        status_done()
    try:
        import yt_dlp  # noqa: F401
        FREE_LIST["ok"] = True
    except Exception:
        FREE_LIST["ok"] = False
    return FREE_LIST["ok"]


def free_list_tab(ch, tab, limit, label):
    """List one channel tab (videos / shorts / streams) with yt-dlp. No Apify cost.
    Returns (records, channel name, complete). If YouTube stops it partway, what was found is kept
    and complete is False. Raises only if nothing could be listed."""
    import yt_dlp

    class Quiet:
        def debug(self, m):
            pass

        info = warning = error = debug

    url = channel_url(ch).rstrip("/") + "/" + tab
    kind = {"videos": "video", "shorts": "short", "streams": "live"}[tab]
    opts = {"extract_flat": "in_playlist", "quiet": True, "no_warnings": True, "skip_download": True,
            "logger": Quiet(), "socket_timeout": 30, "retries": 10, "extractor_retries": 5,
            "extractor_args": {"youtubetab": {"approximate_date": [""]}}}
    t0, out, name, seen, complete = time.time(), [], None, 0, True
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False, process=False) or {}
            for _ in range(3):  # YouTube sometimes redirects the tab first
                if info.get("_type") in ("url", "url_transparent") and info.get("url"):
                    info = ydl.extract_info(info["url"], download=False, process=False) or {}
            name = info.get("channel") or info.get("uploader")
            for e in info.get("entries") or []:  # arrives page by page, 30 at a time
                seen += 1
                if seen % 30 == 0:
                    el = int(time.time() - t0)
                    status(f"    {label}: {seen:,} found · {el // 60}m {el % 60:02d}s")
                if e and e.get("id") and e.get("live_status") not in ("is_live", "is_upcoming", "post_live") \
                        and e.get("availability") not in ("subscriber_only", "premium_only", "needs_auth"):
                    ts = e.get("timestamp")
                    out.append({"videoId": e["id"], "type": kind, "title": e.get("title"),
                                "url": f"https://www.youtube.com/watch?v={e['id']}",
                                "date": datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else "",
                                "views": e.get("view_count"), "likes": None, "comments": None,
                                "durationSeconds": e.get("duration"),
                                "description": (e.get("description") or "")[:3000]})
                if limit and seen >= limit:
                    break
    except Exception as e:
        if "does not have a" in str(e) and "tab" in str(e):
            return [], name, True  # e.g. a channel that never streamed
        if not seen:
            raise
        complete = False
    finally:
        status_done()
    return out, name, complete


def apify_list(client, ch, kind, mode, covers, label):
    if kind == "uploads":
        run_input = {"channels": [ch["handle"]], "maxVideosPerChannel": 200000 if mode == "full" else 60,
                     "includeShorts": "short" in covers, "exactVideoStats": False,
                     "includeEngagement": False, "includeDescription": False}
        actor = LIST_ACTOR
    else:
        n = 1000 if mode == "full" else 20
        run_input = {"startUrls": [{"url": channel_url(ch)}], "maxResults": 0,
                     "maxResultsShorts": 0, "maxResultStreams": n}
        actor = STREAMS_ACTOR
    ds, st, usd = run_actor(client, actor, run_input, label + " (Apify)")
    add_spend("apify", usd, f"list {kind}", ch["slug"])
    recs, name = [], None
    for it in dataset_items(client, ds):
        name = name or it.get("channelName") or it.get("channelTitle") or (
            it.get("title") if it.get("recordType") == "channel" else None)
        rec = norm_listing(it, "live" if kind == "live" else "video")
        if rec:
            recs.append(rec)
    return recs, name


def _iso_dur(s):
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return None
    h, mi, se = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + se


def _yt_api(path, params, key):
    from urllib.parse import urlencode
    q = dict(params)
    q["key"] = key
    url = "https://www.googleapis.com/youtube/v3/" + path + "?" + urlencode(q)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _uploads_playlist(ch, key):
    h = ch["handle"]
    if "/channel/" in h:
        cid = h.split("/channel/")[1].split("/")[0]
        d = _yt_api("channels", {"part": "contentDetails,snippet", "id": cid}, key)
    else:
        handle = h if h.startswith("@") else "@" + h.split("@")[-1]
        d = _yt_api("channels", {"part": "contentDetails,snippet", "forHandle": handle}, key)
    items = d.get("items") or []
    if not items:
        return None, None
    it = items[0]
    return it["contentDetails"]["relatedPlaylists"]["uploads"], it.get("snippet", {}).get("title")


def _playlist_id(url):
    """Pull a YouTube playlist id out of a URL (…list=PL…), or accept a bare id."""
    from urllib.parse import urlparse, parse_qs
    u = (url or "").strip()
    if "list=" in u:
        got = parse_qs(urlparse(u).query).get("list") or []
        if got:
            return got[0]
    if u[:2] in ("PL", "UU", "FL", "OL", "RD") and len(u) > 12 and " " not in u:
        return u
    return None


def _playlist_meta(pid, key):
    """Playlist title, for naming a playlist-sourced channel; None if it can't be read."""
    try:
        items = (_yt_api("playlists", {"part": "snippet", "id": pid}, key) or {}).get("items") or []
        return items[0]["snippet"]["title"] if items else None
    except Exception:
        return None


def data_api_list(ch, key, mode):
    """List a channel (or a specific playlist) with the YouTube Data API: fast and free within Google's
    daily quota, with exact upload dates. Returns (records, name, complete); videos, shorts, ended lives."""
    if ch.get("playlist"):
        up, name = ch["playlist"], ch.get("name") or ch.get("handle")
    else:
        up, name = _uploads_playlist(ch, key)
    if not up:
        raise RuntimeError("channel not found via Data API")
    limit = None if mode == "full" else 120
    ids, token, t0 = [], None, time.time()
    while True:
        params = {"part": "contentDetails", "playlistId": up, "maxResults": 50}
        if token:
            params["pageToken"] = token
        d = _yt_api("playlistItems", params, key)
        for it in d.get("items") or []:
            vid = it.get("contentDetails", {}).get("videoId")
            if vid:
                ids.append(vid)
        el = int(time.time() - t0)
        status(f"    {channel_label(ch)}: listing via Data API: {len(ids):,} found · {el // 60}m {el % 60:02d}s")
        token = d.get("nextPageToken")
        if not token or (limit and len(ids) >= limit):
            break
    if limit:
        ids = ids[:limit]
    status(f"    {channel_label(ch)}: fetching details for {len(ids):,} videos...")
    recs, lock = [], Lock()

    def fetch(batch):
        d = _yt_api("videos", {"part": "snippet,contentDetails,statistics,liveStreamingDetails",
                               "id": ",".join(batch)}, key)
        out = []
        for it in d.get("items") or []:
            sn = it.get("snippet", {})
            if sn.get("liveBroadcastContent") in ("live", "upcoming"):
                continue  # still live / upcoming: no transcript yet
            vid = it["id"]
            dur = _iso_dur(it.get("contentDetails", {}).get("duration"))
            if "liveStreamingDetails" in it:
                typ = "live"
            elif dur is not None and dur <= 60:
                typ = "short"
            else:
                typ = "video"
            vc = it.get("statistics", {}).get("viewCount")
            out.append({"videoId": vid, "type": typ, "title": sn.get("title"),
                        "url": f"https://www.youtube.com/watch?v={vid}",
                        "date": (sn.get("publishedAt") or "")[:10],
                        "views": int(vc) if vc else None, "likes": None, "comments": None,
                        "durationSeconds": dur, "description": (sn.get("description") or "")[:3000]})
        with lock:
            recs.extend(out)

    batches = [ids[i:i + 50] for i in range(0, len(ids), 50)]
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(fetch, batches))
    status_done()
    return recs, name, True


def fetch_listing(client, ch, plan, confirm=None):
    """plan: dict kind -> 'full' | 'recent'. Merges into the saved list.
    Lists free with the YouTube Data API (if YOUTUBE_API_KEY is set) or yt-dlp; Apify is the paid backup."""
    meta, videos = load_listing(ch)
    by_id = {v["videoId"]: v for v in videos}
    added = 0
    steps = []
    vs = {k: m for k, m in plan.items() if k in ("video", "short")}
    if vs:
        steps.append(("uploads", "full" if "full" in vs.values() else "recent", vs))
    if "live" in plan:
        steps.append(("live", plan["live"], {"live": plan["live"]}))
    api_key = need_key("YOUTUBE_API_KEY")
    api_recs, api_name = None, None
    chan_mode = "full" if any(m == "full" for m in plan.values()) else "recent"
    # Big channels: the Data API caps the uploads feed at ~20k, so list their full history with yt-dlp
    # (free, no cap) on a full scan only. New uploads are recent, so incremental keeps using the fast API.
    use_api = api_key and (chan_mode == "recent" or not ch.get("_big"))
    if use_api:
        try:
            api_recs, api_name, _ = data_api_list(ch, api_key, chan_mode)
        except Exception as e:
            warn(f"    YouTube Data API listing didn't work ({str(e).splitlines()[0][:120]}); using yt-dlp.")
            api_recs = None
        if chan_mode == "full" and api_recs is not None and len(api_recs) >= DEEP_THRESHOLD:
            ch["_big"] = True  # hit YouTube's ~20k cap: this channel is bigger than the API shows
            say(f"    {channel_label(ch)}: bigger than YouTube's API lists (~20k). Getting the full history with "
                f"yt-dlp (free, one-time, slower).")
            api_recs = None
    free = ensure_ytdlp() if api_recs is None else False
    for kind, mode, covers in steps:
        what = " and ".join(k + "s" for k in covers) if kind == "uploads" else "lives"
        label = f"{channel_label(ch)}: listing {what} ({'all' if mode == 'full' else 'newest'})"
        recs, name, why, complete = None, api_name, "yt-dlp isn't installed", True
        if api_recs is not None:
            recs = [r for r in api_recs if r["type"] in covers]
        elif free:
            try:
                tabs = ["streams"] if kind == "live" else [t for k, t in (("video", "videos"), ("short", "shorts")) if k in covers]
                recs = []
                for tab in tabs:
                    limit = None if mode == "full" else (20 if tab != "videos" else 60)
                    got, nm, done = free_list_tab(ch, tab, limit, label)
                    recs += got
                    name = name or nm
                    complete = complete and done
            except Exception as e:
                recs, why = None, str(e).splitlines()[0][:160]
        if recs is None:
            warn(f"    free listing didn't work ({why}).")
            if mode == "full" and kind == "uploads":
                n = channel_sizes(client, [ch]).get(ch["slug"])
                cost = f"about {money(n * EST_LIST + 0.01)} for {n:,} videos" if n else "price depends on channel size"
            else:
                cost = "a few cents"
            if confirm and not confirm(f"    List {what} with Apify instead? ({cost})"):
                continue
            try:
                recs, name = apify_list(client, ch, kind, mode, covers, label)
            except Exception as e:
                err(f"    could not list {what}: {e}")
                continue
        if name and not ch.get("name"):
            ch["name"] = name
        got = 0
        for rec in recs:
            if rec["type"] not in covers:
                continue
            got += 1
            if rec["videoId"] in by_id:
                old = by_id[rec["videoId"]]
                for k in ("views", "likes", "comments", "title"):
                    if rec.get(k) is not None:
                        old[k] = rec[k]
                if not old.get("durationSeconds") and rec.get("durationSeconds"):
                    old["durationSeconds"] = rec["durationSeconds"]
            else:
                by_id[rec["videoId"]] = rec
                added += 1
        if not complete:
            warn(f"    YouTube cut the listing short after {got:,} {what}. Those are kept; the rest is picked up"
                 f" next update.")
            if mode == "full":
                continue  # stays unfinished, so the next update scans the whole channel again (free)
        if mode == "full" and got == 0 and kind == "uploads":
            warn(f"    nothing found for {ch['handle']} ({what}). If this is wrong, check the handle.")
        for k in covers:
            meta.setdefault("fetched", {})[k] = True
    videos = sorted(by_id.values(), key=lambda v: v.get("date") or "", reverse=True)
    meta["updated"] = datetime.now().isoformat(timespec="seconds")
    save_listing(ch, meta, videos)
    return added


def channel_sizes(client, chans):
    """How many videos each channel has (cheap: no video list), so first scans show a real price."""
    chans = [c for c in chans if c]
    if not chans:
        return {}
    try:
        ds, st, usd = run_actor(client, LIST_ACTOR, {"channels": [c["handle"] for c in chans], "maxVideosPerChannel": 0},
                                "checking channel sizes")
        add_spend("apify", usd, "check channel sizes")
        out = {}
        items = [it for it in dataset_items(client, ds) if it.get("recordType") == "channel"]
        for c in chans:
            h = c["handle"].lower().lstrip("@")
            for it in items:
                if h in str(it.get("input", "")).lower().lstrip("@") or h == str(it.get("handle", "")).lower().lstrip("@"):
                    out[c["slug"]] = int(it.get("videoCount") or 0) or None
                    if not c.get("name") and it.get("title"):
                        c["name"] = it["title"]
        return out
    except Exception:
        return {}


def wanted_kinds(ch):
    kinds = []
    if ch.get("videos", True):
        kinds.append("video")
    if ch.get("lives"):
        kinds.append("live")
    if ch.get("shorts"):
        kinds.append("short")
    return kinds


def pending_transcripts(ch):
    p = cpaths(ch)
    _, videos = load_listing(ch)
    kinds = set(wanted_kinds(ch))
    videos = [v for v in videos if v.get("type", "video") in kinds and length_ok(ch, v) and title_ok(ch, v)]
    if ch.get("max_videos"):
        videos = videos[: int(ch["max_videos"])]
    failed = load_failed(ch)
    return [v for v in videos
            if not (p["raw"] / f"{v['videoId']}.json").exists()
            and failed.get(v["videoId"], {}).get("attempts", 0) < MAX_FAIL_ATTEMPTS]


def norm_segments(segs, duration=None):
    out = []
    for s in segs or []:
        if not isinstance(s, dict):
            continue
        try:
            start = float(s.get("start", s.get("offset", 0)))
            dur = float(s.get("duration", s.get("dur", 0)) or 0)
        except (TypeError, ValueError):
            continue
        text = re.sub(r"\s+", " ", str(s.get("text") or "")).strip()
        if text:
            out.append({"start": start, "dur": dur, "text": text})
    if out and duration and out[-1]["start"] > float(duration) * 5:  # milliseconds guard
        for s in out:
            s["start"] /= 1000.0
            s["dur"] /= 1000.0
    return out


def pending_path(ch):
    return cpaths(ch)["base"] / "pending_batches.json"


def _permanent_fail(reason):
    """A failure that is the video's own (no captions on YouTube), not rate-limiting: don't retry it,
    and don't let it look like YouTube pushing back to the download speed tuner."""
    r = str(reason or "").lower()
    return any(w in r for w in ("disabled", "no native caption", "no caption",
                                "language_not_found", "language not found", "no transcript"))


def _adapt_transcript_item(it):
    """Reshape a codepoetry/youtube-transcript-ai-scraper output row into the fields save_batch_items
    expects: videoId, transcriptSegments ({start, dur, text} in seconds), status, languageUsed,
    isAutoGenerated, wordCount, errorMessage. Tied to TRANSCRIPT_ACTOR; change both together."""
    if not isinstance(it, dict):
        return {"videoId": None}
    meta = it.get("metadata") or {}
    vid = meta.get("id") or it.get("video_id") or it.get("videoId")
    segs = []
    for s in it.get("transcript_json") or []:
        if not isinstance(s, dict):
            continue
        start, end = s.get("start"), s.get("end")
        dur = (end - start) if isinstance(start, (int, float)) and isinstance(end, (int, float)) else 0
        segs.append({"start": start, "dur": dur, "text": s.get("text")})
    text = it.get("transcript_text") or ""
    ok = bool(segs)
    return {
        "videoId": vid,
        "transcriptSegments": segs,
        "status": "success" if ok else "failed",
        "languageUsed": it.get("language"),
        "isAutoGenerated": it.get("is_auto_generated"),
        "wordCount": len(text.split()) if text else sum(len((s.get("text") or "").split()) for s in segs),
        "errorMessage": None if ok else (it.get("error") or it.get("error_type") or it.get("status") or "no transcript"),
    }


def save_batch_items(ch, items, meta, part_ids, failed, run_ok=True):
    p = cpaths(ch)
    p["raw"].mkdir(parents=True, exist_ok=True)
    saved, got = 0, set()
    for raw in items:
        try:  # one odd item from the scraper shouldn't lose the whole batch's transcripts
            it = _adapt_transcript_item(raw)
            vid = it.get("videoId")
            if not vid:
                continue
            got.add(vid)
            base = meta.get(vid, {"videoId": vid})
            segs = norm_segments(it.get("transcriptSegments"), base.get("durationSeconds"))
            if it.get("status") == "success" and segs:
                rec = dict(base)
                rec.update({"language": it.get("languageUsed"), "autoGenerated": it.get("isAutoGenerated"),
                            "wordCount": it.get("wordCount"), "segments": segs})
                write_json(p["raw"] / f"{vid}.json", rec)
                failed.pop(vid, None)
                saved += 1
            else:
                f = failed.setdefault(vid, {"attempts": 0})
                f["reason"] = it.get("errorMessage") or "no transcript"
                f["attempts"] = MAX_FAIL_ATTEMPTS if _permanent_fail(f["reason"]) else f["attempts"] + 1
        except Exception:
            continue
    for vid in part_ids:
        if vid not in got and not (p["raw"] / f"{vid}.json").exists() and run_ok:
            # only the video's fault if the run finished normally (not stopped by credit running out etc.)
            f = failed.setdefault(vid, {"attempts": 0})
            f["attempts"] += 1
            f["reason"] = "not returned"
    write_json(p["failed"], failed)
    return saved


def recover_batches(client, ch):
    """Collect transcript batches that finished on Apify while this PC was off or offline."""
    pend = read_list(pending_path(ch))
    if not pend:
        return 0
    _, listing = load_listing(ch)
    meta = {v["videoId"]: v for v in listing}
    failed = load_failed(ch)
    saved = 0
    for b in list(pend):
        try:
            st, usd = wait_run(client, b["run"], b["ds"], f"{channel_label(ch)}: collecting an unfinished batch")
            add_spend("apify", usd if usd is not None else len(b["videos"]) * EST_TRANSCRIPT,
                      "recovered batch", ch["slug"])
            saved += save_batch_items(ch, dataset_items(client, b["ds"]), meta, b["videos"], failed)
        except Exception as e:
            warn(f"    couldn't collect an earlier batch ({str(e)[:100]}); those videos will be downloaded again")
        pend.remove(b)
        write_json(pending_path(ch), pend)
    return saved


def batch_size_for(total, slots):
    """Size batches so the parallel slots stay full: e.g. 103 videos with 6 slots -> 6 batches of 18."""
    if total <= 0:
        return TRANSCRIPT_BATCH
    rounds = -(-(-(-total // TRANSCRIPT_BATCH)) // slots)  # ceil(ceil(total/50) / slots)
    size = -(-total // (rounds * slots))
    return max(MIN_BATCH, min(TRANSCRIPT_BATCH, size))


def auto_parallel_bounds():
    """Where dynamic download parallelism starts and how high it may climb. The hard ceiling is the
    Apify plan's concurrent-run limit minus a little headroom (so Apify still has room to start the
    listing and recovery jobs); the live tuner finds the real sustainable level under YouTube's rate
    limits and remembers where it last blocked, so each run re-probes just past that point rather
    than flooring it or starting from scratch. The 256 is only a sanity guard, not a real cap."""
    max_runs = (apify_balance() or {}).get("max_runs")
    hard = max(4, min(256, max_runs - max(2, max_runs // 16))) if max_runs else 12
    block = int(get_perf("block_level", 0) or 0)
    # the plan sets how high we may climb; a remembered block only lowers where we START, so a
    # one-off rough run can never pin the ceiling down for good -- the tuner re-climbs each run
    ceiling = hard
    start = min(block + 4, hard) if block else min(int(get_perf("parallel_dl", 0) or 0) or 8, hard)
    return max(4, min(start, ceiling)), ceiling


def download_many(client, jobs, on_saved=None, status_fn=None, feed=None):
    """jobs: list of (channel, videos). One shared queue, so all parallel slots stay busy across channels.
    on_saved(ch, [video ids]) is called as each batch lands (the tagging belt picks them up from there).
    feed: an optional Queue that yields more (channel, videos) tuples as channels finish listing, then
    None when listing is done (overnight mode, so downloading overlaps listing). Returns {slug: saved}."""
    global PARALLEL_BATCHES
    ctx = {}
    for ch, todo in jobs:
        cpaths(ch)["raw"].mkdir(parents=True, exist_ok=True)
        ctx[ch["slug"]] = {"ch": ch, "meta": {v["videoId"]: v for v in todo}, "failed": load_failed(ch), "saved": 0}
    state = {"active": {}, "finished": 0, "total": 0, "blocked": [], "stopped": 0, "budget_hit": False,
             "judge": True, "window_tried": 0, "window_blocked": 0,
             "soft_cap": int(get_perf("block_level", 0) or 0) or PARALLEL_CEILING}
    t0 = time.time()

    def remember(ch, run_id, ds, part_ids):
        pend = read_list(pending_path(ch))
        pend.append({"run": run_id, "ds": ds, "videos": part_ids,
                     "when": datetime.now().isoformat(timespec="seconds")})
        write_json(pending_path(ch), pend)

    def finish(run_id, info):
        global PARALLEL_BATCHES
        slug, part, ds, _ = state["active"].pop(run_id)
        c = ctx[slug]
        ch = c["ch"]
        usd = g(info, "usage_total_usd", "usageTotalUsd")
        try:
            usd = float(usd) if usd is not None else None
        except (TypeError, ValueError):
            usd = None
        add_spend("apify", usd if usd is not None else len(part) * EST_TRANSCRIPT,
                  plural(len(part), "transcript"), slug)
        ids = [v["videoId"] for v in part]
        raw = cpaths(ch)["raw"]
        try:
            run_ok = status_str(g(info, "status")) == "SUCCEEDED"
            n_ok = save_batch_items(ch, dataset_items(client, ds), c["meta"], ids, c["failed"], run_ok)
            c["saved"] += n_ok
            if not run_ok:
                state["stopped"] += 1
            pend = [b for b in (read_list(pending_path(ch))) if b.get("ds") != ds]
            write_json(pending_path(ch), pend)
            if on_saved:
                on_saved(ch, [vid for vid in ids if (raw / f"{vid}.json").exists()])
            # gauge YouTube blocking: failures that aren't "captions disabled"
            disabled = [vid for vid in ids if _permanent_fail(c["failed"].get(vid, {}).get("reason", ""))]
            blocked = [vid for vid in ids if run_ok and not (raw / f"{vid}.json").exists() and vid not in disabled]
            state["blocked"] += [(slug, vid) for vid in blocked]
            # auto-tune parallelism: climb when clean, ease off proportionally when YouTube pushes back
            # (congestion-control style). Judge only on the main pass and on a real sample (20+ videos).
            if state["judge"] and run_ok:
                state["window_tried"] += len(ids) - len(disabled)
                state["window_blocked"] += len(blocked)
                if state["window_tried"] >= 20:
                    rate = state["window_blocked"] / state["window_tried"]
                    if rate > 0.15 and PARALLEL_BATCHES > 1:
                        state["soft_cap"] = min(state["soft_cap"], PARALLEL_BATCHES)
                        drop = max(2, round(PARALLEL_BATCHES * (rate - 0.1)))  # gentle for a blip, hard for a wall
                        PARALLEL_BATCHES = max(1, PARALLEL_BATCHES - drop)
                        say(f"\n    {Y}{state['window_blocked']} of the last {state['window_tried']} videos failed, "
                            f"likely YouTube pushing back. Easing to {PARALLEL_BATCHES} at a time.{X}")
                    elif rate < 0.05 and PARALLEL_BATCHES < PARALLEL_CEILING:
                        step = 2 if PARALLEL_BATCHES < min(state["soft_cap"] - 2, 20) else 1  # brisk low, cautious near the ceiling
                        PARALLEL_BATCHES = min(PARALLEL_CEILING, PARALLEL_BATCHES + step)
                    state["window_tried"] = state["window_blocked"] = 0
        except Exception as e:  # stays in pending_batches.json and is collected next run
            say(f"\n    {Y}couldn't read a finished batch yet ({str(e)[:80]}), will collect it next run{X}")
        state["finished"] += len(part)

    def run_pass(work, label, feed=None):
        queue = []
        state.update({"finished": 0, "total": 0, "blocked": []})

        def add_jobs(items):
            for ch, t in items:
                if not t:
                    continue
                slug = ch["slug"]
                if slug not in ctx:
                    cpaths(ch)["raw"].mkdir(parents=True, exist_ok=True)
                    ctx[slug] = {"ch": ch, "meta": {}, "failed": load_failed(ch), "saved": 0}
                ctx[slug]["meta"].update({v["videoId"]: v for v in t})
                size = batch_size_for(len(t), PARALLEL_BATCHES)
                for i in range(0, len(t), size):
                    queue.append((ch, t[i:i + size]))
                state["total"] += len(t)

        add_jobs(work)
        listing_done = feed is None
        active = state["active"]
        while True:
            if feed is not None and not listing_done:  # overnight: pull channels as they finish listing
                try:
                    while True:
                        item = feed.get_nowait()
                        if item is None:
                            listing_done = True
                        elif not state["budget_hit"]:
                            add_jobs([item])
                except Empty:
                    pass
            while queue and len(active) < PARALLEL_BATCHES:
                ch, part = queue.pop(0)
                try:
                    run_id, ds = start_actor(client, TRANSCRIPT_ACTOR, {
                        "startUrls": [{"url": v["url"]} for v in part],
                        "languages": [ch.get("language") or "en"],
                        "subType": "both",
                        "outputFormats": ["json", "text"],
                        "enableAiFallback": False,
                    })
                except BudgetReached:
                    say()
                    warn("    Apify budget for this run reached. The rest will be picked up next update.")
                    queue.clear()
                    state["budget_hit"] = True
                    break
                except Exception as e:
                    say()
                    msg = str(e).lower()
                    if any(w in msg for w in ("usage", "credit", "limit", "payment", "insufficient")):
                        warn(f"    Apify refused to start more batches ({str(e)[:120]}). Probably out of credit: "
                             f"the rest will be picked up next update, after your credit resets or you top up.")
                        queue.clear()
                        state["budget_hit"] = True
                        break
                    err(f"    a batch failed to start: {str(e)[:150]}. Run update again later to retry.")
                    continue
                remember(ch, run_id, ds, [v["videoId"] for v in part])
                active[run_id] = (ch["slug"], part, ds, time.time())
            if not active:
                if state["budget_hit"] or (not queue and listing_done):
                    break
                time.sleep(2)  # nothing running yet: wait for the lister to feed more channels
                continue
            time.sleep(5)
            in_progress = 0
            for run_id in list(active):
                _, part, ds, started = active[run_id]
                try:
                    info = client.run(run_id).get()
                except Exception:
                    continue  # connection blip: check again next round
                st = status_str(g(info, "status"))
                if st in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT", "TIMEDOUT") \
                        or time.time() - started > 3 * 3600:
                    finish(run_id, info)
                else:
                    try:
                        in_progress += g(client.dataset(ds).get(), "item_count", "itemCount", default=0) or 0
                    except Exception:
                        pass
            extra = f" · {status_fn()}" if status_fn else ""
            got = state['finished'] + in_progress
            el = time.time() - t0
            tail = f", {len(queue)} queued" if queue else ("" if listing_done else ", listing...")
            status(f"    {label:<11} {bar(got, state['total'], 18)}  {got:,}/{state['total']:,} · "
                   f"{len(active)} running{tail}{extra} · {int(el // 60)} min")
        status_done()

    if feed is None:
        size = batch_size_for(sum(len(t) for _, t in jobs), PARALLEL_BATCHES)
        n_batches = sum(-(-len(t) // size) for _, t in jobs)
        say(f"    {n_batches} batches of up to {size} videos, starting {PARALLEL_BATCHES} at a time "
            f"(auto-tuning speed, up to {PARALLEL_CEILING} at once that your Apify plan allows)")
    else:
        say(f"    listing and downloading together, starting {PARALLEL_BATCHES} at a time "
            f"(auto-tuning speed, up to {PARALLEL_CEILING} at once that your Apify plan allows)")
    t_main = time.time()
    run_pass([(ch, t) for ch, t in jobs if t], "Transcripts", feed=feed)
    total_main = sum(len(t) for _, t in jobs) if feed is None else state["total"]
    if total_main >= 30 and not state["budget_hit"] and feed is None:
        record_perf("dl_sec_per_video_slot", (time.time() - t_main) * PARALLEL_BATCHES / total_main)
        record_perf("parallel_dl", PARALLEL_BATCHES)
        if state["soft_cap"] < PARALLEL_CEILING:  # remember where YouTube started pushing back
            record_perf("block_level", state["soft_cap"])

    # one automatic retry of the ones YouTube pushed back on, at the (possibly reduced) speed
    retry = {}
    for slug, vid in dict.fromkeys(state["blocked"]):
        c = ctx[slug]
        if vid in c["meta"] and not (cpaths(c["ch"])["raw"] / f"{vid}.json").exists() \
                and c["failed"].get(vid, {}).get("attempts", 0) < MAX_FAIL_ATTEMPTS:
            retry.setdefault(slug, []).append(c["meta"][vid])
    if retry and not state["budget_hit"]:
        n = sum(len(v) for v in retry.values())
        say(f"    retrying {plural(n, 'video')} that failed...")
        state["judge"] = False
        run_pass([(ctx[slug]["ch"], vids) for slug, vids in retry.items()], "Retry")

    if state["stopped"]:
        b = apify_balance()
        hint = " Your Apify credit looks used up." if b and b["left"] < 0.05 else ""
        warn(f"    {plural(state['stopped'], 'batch')} stopped early on Apify's side.{hint} "
             f"Unfinished videos will be picked up next update.")
    still = [(slug, vid) for slug, vid in dict.fromkeys(state["blocked"])
             if not (cpaths(ctx[slug]["ch"])["raw"] / f"{vid}.json").exists()]
    if still:
        say(f"    {plural(len(still), 'video')} still failed (not charged), retried next update. "
            f"If this keeps happening, lower parallel downloads in Settings.")
    return {slug: c["saved"] for slug, c in ctx.items()}


# ---------------------------------------------------------------- videos & chunks

def load_videos(ch):
    p = cpaths(ch)
    vids = []
    for f in sorted(p["raw"].glob("*.json")):
        v = read_json(f)
        if not isinstance(v, dict) or not v.get("segments"):
            continue
        v["segments"] = norm_segments(v["segments"], v.get("durationSeconds"))
        v.setdefault("type", "video")
        if v["segments"]:
            vids.append(v)
    vids.sort(key=lambda v: v.get("date") or "", reverse=True)
    return vids


def make_chunks(video, channel=None):
    vid = video["videoId"]
    chunks, cur = [], None
    for s in video.get("segments") or []:
        if cur is None:
            cur = {"start": s["start"], "end": s["start"], "texts": []}
        cur["texts"].append(s["text"])
        cur["end"] = s["start"] + s["dur"]
        if cur["end"] - cur["start"] >= CHUNK_SECONDS:
            chunks.append(cur)
            cur = None
    if cur:
        chunks.append(cur)
    out = []
    for i, c in enumerate(chunks):
        out.append({
            "chunk_id": f"{vid}_{i:04d}", "n": i, "video_id": vid,
            "channel": channel, "type": video.get("type", "video"),
            "title": video.get("title") or "", "date": video.get("date") or "",
            "start": round(c["start"], 2), "end": round(c["end"], 2),
            "timestamp": fmt_ts(c["start"]), "url": link(vid, c["start"]),
            "text": " ".join(c["texts"]),
        })
    return out


def video_words(v):
    return sum(len(s["text"].split()) for s in v.get("segments") or [])


# ---------------------------------------------------------------- claude: tagging

TAG_PROMPT = """You are indexing transcripts from the YouTube channel "{channel}" so they can be searched and browsed by topic.
The transcript is auto-generated captions split into numbered chunks. ">>" marks a change of speaker. Names and Arabic or religious terms are often misspelled by the captioning. Write all output in English, whatever the transcript language.
{part_note}
Save your result with the save_tags tool.

Rules:
- summary: 2-3 plain sentences on who the host talks to and what is argued.
- 3 to 8 topics. Reuse labels from this list when they fit, invent a new short lowercase label only when none fit: {seeds}
- For each topic give up to 8 chunk numbers where it's discussed most (the number after "c").
- If there is a sponsor read, include the topic "sponsor" with its chunks.
- 3 to 8 key claims: one sentence each, a specific argument or factual claim, and who made it. Nothing that isn't in the transcript.

Video: {title} ({date}, {kind})

Transcript:
{body}"""

MERGE_PROMPT = """These are summaries of consecutive parts of one long YouTube {kind} titled "{title}". Write one 2-3 sentence plain summary of the whole thing. Return only the summary text.

{parts}"""


def anthropic_client():
    import anthropic
    key = need_key("ANTHROPIC_API_KEY")
    if not key:
        return None
    return anthropic.Anthropic(api_key=key, max_retries=8)


def call_claude(client, model, prompt, max_tokens):
    msg = client.messages.create(model=model, max_tokens=max_tokens,
                                 messages=[{"role": "user", "content": prompt}])
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    return text, claude_cost(model, msg.usage)


def call_claude_stream(client, model, prompt, max_tokens):
    """Like call_claude, but yields the answer as it is generated: ('delta', text) for each chunk,
    then ('done', (full_text, usd)) once. Lets the website show the answer as it writes."""
    parts = []
    with client.messages.stream(model=model, max_tokens=max_tokens,
                                 messages=[{"role": "user", "content": prompt}]) as stream:
        for text in stream.text_stream:
            parts.append(text)
            yield ("delta", text)
        final = stream.get_final_message()
    yield ("done", ("".join(parts), claude_cost(model, final.usage)))


TAG_TOOL = {
    "name": "save_tags",
    "description": "Save the index entry for this video.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "2-3 plain sentences"},
            "format": {"type": "string", "enum": ["live chat debate", "formal debate", "live stream", "reaction",
                                                  "lecture", "interview", "other"]},
            "counterpart": {"type": "string", "description": "who the host talks with or reacts to; empty if none"},
            "topics": {"type": "array", "items": {"type": "object", "properties": {
                "topic": {"type": "string"},
                "chunks": {"type": "array", "items": {"type": "integer"}}},
                "required": ["topic", "chunks"]}},
            "key_claims": {"type": "array", "items": {"type": "object", "properties": {
                "claim": {"type": "string"},
                "chunk": {"type": "integer"}},
                "required": ["claim", "chunk"]}},
        },
        "required": ["summary", "format", "topics", "key_claims"],
    },
}

MAP_TOOL = {
    "name": "save_mapping",
    "description": "Save the label -> canonical label mapping.",
    "input_schema": {
        "type": "object",
        "properties": {"mapping": {"type": "array", "items": {"type": "object", "properties": {
            "label": {"type": "string"}, "canonical": {"type": "string"}}, "required": ["label", "canonical"]}}},
        "required": ["mapping"],
    },
}


def call_claude_tool(client, model, prompt, tool, max_tokens):
    """Ask Claude to answer through a tool, so the API hands back well-formed data instead of text to parse."""
    usd = 0.0
    for attempt in range(2):
        msg = client.messages.create(model=model, max_tokens=max_tokens, tools=[tool],
                                     tool_choice={"type": "tool", "name": tool["name"]},
                                     messages=[{"role": "user", "content": prompt}])
        usd += claude_cost(model, msg.usage)
        for b in msg.content:
            if getattr(b, "type", "") == "tool_use" and isinstance(getattr(b, "input", None), dict):
                if getattr(msg, "stop_reason", "") != "max_tokens":
                    return b.input, usd
        max_tokens *= 2  # reply was cut off: try once more with more room
    raise RuntimeError("Claude's reply was cut off twice")


def parse_json_obj(text):
    return json.loads(text[text.index("{"): text.rindex("}") + 1])


def to_n(x, limit):
    try:
        n = int(str(x).strip().lstrip("cC"))
    except (TypeError, ValueError):
        return None
    return n if 0 <= n < limit else None


def clean_tags(tags, n_chunks):
    if not isinstance(tags, dict):  # a corrupt or odd tag file can parse to a string/list
        tags = {}
    topics = {}
    for t in tags.get("topics") or []:
        label = str(t.get("topic") or "").strip().lower()
        if not label:
            continue
        ids = {n for n in (to_n(x, n_chunks) for x in t.get("chunks") or []) if n is not None}
        topics.setdefault(label, set()).update(ids)
    claims = [{"claim": c["claim"], "chunk": to_n(c.get("chunk"), n_chunks)}
              for c in tags.get("key_claims") or [] if isinstance(c, dict) and c.get("claim")]
    return {**tags, "topics": [{"topic": k, "chunks": sorted(v)} for k, v in topics.items()],
            "key_claims": claims}


def tag_windows(chunks):
    windows, start, words = [], 0, 0
    for i, c in enumerate(chunks):
        w = len(c["text"].split())
        if words and words + w > TAG_WINDOW_WORDS:
            windows.append((start, i))
            start, words = i, 0
        words += w
    windows.append((start, len(chunks)))
    return windows


def tag_video(client, model, ch, v):
    chunks = make_chunks(v)
    windows = tag_windows(chunks)
    usd = 0.0
    parts = []
    for wi, (a, b) in enumerate(windows):
        body = "\n".join(f"[c{c['n']} | {c['timestamp']}] {c['text']}" for c in chunks[a:b])
        note = (f"This is part {wi + 1} of {len(windows)} of a long recording (chunks {a} to {b - 1}). "
                f"Tag only this part." if len(windows) > 1 else "")
        prompt = TAG_PROMPT.format(channel=full_name(ch), part_note=note, seeds=", ".join(SEED_TOPICS),
                                   title=v.get("title"), date=v.get("date"), kind=v.get("type", "video"),
                                   body=body)
        data, cost = call_claude_tool(client, model, prompt, TAG_TOOL, 3000)
        usd += cost
        if not str(data.get("counterpart") or "").strip():
            data["counterpart"] = None
        parts.append(data)
    out, mu = _merge_parts(client, model, v, parts, len(chunks))
    return out, usd + mu


def _merge_parts(client, model, v, parts, n_chunks):
    """Combine the per-window tag results for one video into its final tags."""
    usd = 0.0
    data = parts[0]
    if len(parts) > 1:
        topics, claims = [], []
        for pt in parts:
            topics += pt.get("topics") or []
            claims += pt.get("key_claims") or []
        summary_parts = "\n".join(f"Part {i + 1}: {pt.get('summary', '')}" for i, pt in enumerate(parts))
        try:
            summary, cost = call_claude(client, model, MERGE_PROMPT.format(
                kind=v.get("type", "video"), title=v.get("title"), parts=summary_parts), 400)
            usd += cost
        except Exception:
            summary = summary_parts
        data = {**parts[0], "summary": summary.strip(), "topics": topics, "key_claims": claims[:12]}
    out = clean_tags(data, n_chunks)
    out["tag_version"] = TAG_VERSION
    return out, usd


def _tag_window_requests(ch, v, model):
    """One Claude request (params) per transcript window for a video, for the Message Batches API."""
    chunks = make_chunks(v)
    windows = tag_windows(chunks)
    out = []
    for wi, (a, b) in enumerate(windows):
        body = "\n".join(f"[c{c['n']} | {c['timestamp']}] {c['text']}" for c in chunks[a:b])
        note = (f"This is part {wi + 1} of {len(windows)} of a long recording (chunks {a} to {b - 1}). "
                f"Tag only this part." if len(windows) > 1 else "")
        prompt = TAG_PROMPT.format(channel=full_name(ch), part_note=note, seeds=", ".join(SEED_TOPICS),
                                   title=v.get("title"), date=v.get("date"), kind=v.get("type", "video"),
                                   body=body)
        out.append((wi, {"model": model, "max_tokens": 4000, "tools": [TAG_TOOL],
                         "tool_choice": {"type": "tool", "name": TAG_TOOL["name"]},
                         "messages": [{"role": "user", "content": prompt}]}))
    return out, len(chunks), len(windows)


PENDING_TAG_BATCHES = OUTPUT / "pending_tag_batches.json"


def _save_pending_batch(rec):
    pend = read_list(PENDING_TAG_BATCHES)
    pend.append(rec)
    write_json(PENDING_TAG_BATCHES, pend)


def _drop_pending_batch(batch_id):
    pend = [r for r in (read_list(PENDING_TAG_BATCHES)) if r.get("batch_id") != batch_id]
    write_json(PENDING_TAG_BATCHES, pend)


def _collect_tag_batch(anth, model, channels, rec, status_fn=None):
    """Poll one submitted tag batch to completion and save the tags it produced. (done, failed, usd)."""
    bid = rec["batch_id"]
    by_slug = {c["slug"]: c for c in channels}
    total = len(rec.get("windows", {}))
    t0 = time.time()
    while True:
        try:
            b = anth.messages.batches.retrieve(bid)
        except Exception:
            time.sleep(10)
            continue
        rc = getattr(b, "request_counts", None)
        n = sum(getattr(rc, k, 0) for k in ("succeeded", "errored", "canceled", "expired")) if rc else 0
        el = int(time.time() - t0)
        extra = f" · {status_fn()}" if status_fn else ""
        status(f"    Batch tagging {bar(n, total, 16)}  {n:,}/{total:,} windows · {el // 60}m {el % 60:02d}s{extra}")
        if getattr(b, "processing_status", "") == "ended":
            break
        time.sleep(10)
    status_done()
    collected, usd = {}, 0.0
    try:
        for res in anth.messages.batches.results(bid):
            info = rec["windows"].get(res.custom_id)
            if not info:
                continue
            vid, wi = info[0], int(info[1])
            r = res.result
            data = None
            if getattr(r, "type", "") == "succeeded":
                m = r.message
                usd += claude_cost(model, m.usage) * 0.5
                for blk in m.content:
                    if getattr(blk, "type", "") == "tool_use" and isinstance(getattr(blk, "input", None), dict):
                        if getattr(m, "stop_reason", "") != "max_tokens":
                            data = blk.input
                        break
            collected.setdefault(vid, {})[wi] = data
    except Exception as e:
        err(f"    couldn't read batch results: {str(e)[:120]}")
        return 0, 0, usd
    done = failed = 0
    rec_videos = rec.get("videos") if isinstance(rec.get("videos"), dict) else {}
    for vid, pmap in collected.items():
        try:
            vinfo = rec_videos.get(vid)
            if not isinstance(vinfo, dict):  # a malformed entry shouldn't sink the whole batch
                failed += 1
                continue
            ch = by_slug.get(vinfo.get("slug"))
            if not ch:
                continue
            parts = [pmap.get(wi) for wi in range(int(vinfo.get("nwin") or 0))]
            if not parts or any(not isinstance(pp, dict) for pp in parts):
                failed += 1
                continue
            v = _load_one_video(ch, vid)
            if v is None:
                failed += 1
                continue
            for pp in parts:
                if not str(pp.get("counterpart") or "").strip():
                    pp["counterpart"] = None
            tags, mu = _merge_parts(anth, model, v, parts, vinfo.get("nch") or len(make_chunks(v)))
            usd += mu
            cpaths(ch)["tags"].mkdir(parents=True, exist_ok=True)
            write_json(cpaths(ch)["tags"] / f"{vid}.json", tags)
            done += 1
        except Exception:
            failed += 1  # one bad video is skipped; the rest of the batch still saves
    if usd:
        add_spend("claude", usd, plural(done, "tag") + " (batch)")
    return done, failed, usd


def submit_tag_batch(anth, model, jobs, channels):
    """Submit videos to the Message Batches API without waiting (fire-and-forget). Each batch is
    persisted so it can be collected later, even after an interrupted run. Returns (recs, out_of_credit)."""
    prepped = []
    for ch, v in jobs:
        wins, nch, nwin = _tag_window_requests(ch, v, model)
        prepped.append((ch, v, wins, nch, nwin))

    recs = []
    out_of_credit = False
    MAXREQ = 40000
    i = 0
    while i < len(prepped):
        reqs = []
        rec = {"batch_id": None, "when": datetime.now().isoformat(timespec="seconds"), "videos": {}, "windows": {}}
        cnt = 0
        while i < len(prepped) and (not reqs or cnt + len(prepped[i][2]) <= MAXREQ):
            ch, v, wins, nch, nwin = prepped[i]
            vid = v["videoId"]
            rec["videos"][vid] = {"slug": ch["slug"], "nwin": nwin, "nch": nch}
            for wi, params in wins:
                cid = "r%d" % cnt
                cnt += 1
                rec["windows"][cid] = [vid, wi]
                reqs.append({"custom_id": cid, "params": params})
            i += 1
        if not reqs:
            break
        try:
            batch = anth.messages.batches.create(requests=reqs)
        except Exception as e:
            if any(w in str(e).lower() for w in ("credit", "billing", "insufficient")):
                out_of_credit = True
            else:
                err(f"    batch tagging couldn't start: {str(e)[:150]}")
            break
        rec["batch_id"] = batch.id
        _save_pending_batch(rec)
        recs.append(rec)
    return recs, out_of_credit


def collect_tag_batches(anth, model, channels, recs, status_fn=None):
    """Collect a list of already-submitted tag batches to completion, saving their tags. (done, failed, usd)."""
    done = failed = 0
    usd = 0.0
    for rec in recs:
        d, f, u = _collect_tag_batch(anth, model, channels, rec, status_fn)
        _drop_pending_batch(rec["batch_id"])
        done += d
        failed += f
        usd += u
    return done, failed, usd


def tag_batch(anth, model, jobs, channels, status_fn=None):
    """Tag many videos with the Message Batches API: about half price and far higher throughput than
    live tagging. Each batch is persisted so an interrupted run can collect it next time.
    Returns (done, failed, usd, out_of_credit)."""
    left = budget_left("claude")
    if left is not None:
        price = PRICES.get(model, (1.0, 5.0))
        kept, est = [], 0.0
        for ch, v in jobs:
            c = (video_words(v) * 1.4 / 1e6 * price[0] + 800 / 1e6 * price[1]) * 0.5
            if est + c > left:
                break
            kept.append((ch, v))
            est += c
        if len(kept) < len(jobs):
            warn(f"    {plural(len(jobs) - len(kept), 'video')} left for next time (Claude budget)")
        jobs = kept
    recs, out_of_credit = submit_tag_batch(anth, model, jobs, channels)
    done, failed, usd = collect_tag_batches(anth, model, channels, recs, status_fn)
    return done, failed, usd, out_of_credit


def recover_tag_batches(anth, model, channels):
    """Collect any tag batches submitted but not finished collecting (e.g. the PC was turned off)."""
    pend = read_list(PENDING_TAG_BATCHES)
    if not pend or anth is None:
        return 0
    total = 0
    for rec in list(pend):
        try:
            say("  Collecting a batch tag job left from a previous run...")
            d, f, u = _collect_tag_batch(anth, model, channels, rec)
            total += d
        except Exception as e:
            warn(f"  couldn't collect an earlier batch tag job ({str(e)[:100]}); "
                 f"those videos get tagged again on this or the next run")
        _drop_pending_batch(rec.get("batch_id"))
    return total


def tag_version(ch, vid):
    """0 = not tagged, 1 = old method (no version stored), 2+ = current method."""
    f = cpaths(ch)["tags"] / f"{vid}.json"
    if not f.exists():
        return 0
    d = read_json(f, {})
    return int((d if isinstance(d, dict) else {}).get("tag_version") or 1)


def needs_tag(ch, vid, retag_old=False):
    v = tag_version(ch, vid)
    return v == 0 or (retag_old and v < TAG_VERSION)


class Tagger:
    """Tagging conveyor belt: videos are tagged in background threads as soon as they're available,
    while downloads keep going."""

    def __init__(self, client, model, workers, retag_old=False):
        self.client, self.model, self.retag_old = client, model, retag_old
        self.ex = ThreadPoolExecutor(max_workers=max(1, workers))
        self.lock = Lock()
        self.futs = []
        self.seen = set()
        self.done = self.failed = self.submitted = self.skipped_budget = 0
        self.usd = 0.0
        self.out_of_credit = False
        self.left = budget_left("claude")  # None = no limit (normal update)
        self.committed = 0.0
        self.price = PRICES.get(model, (1.0, 5.0))
        self.started = None
        self.call_secs = []

    def submit(self, ch, v):
        key = (ch["slug"], v["videoId"])
        if self.out_of_credit or key in self.seen or not needs_tag(ch, v["videoId"], self.retag_old):
            return
        self.seen.add(key)
        if self.left is not None:
            est = video_words(v) * 1.4 / 1e6 * self.price[0] + 800 / 1e6 * self.price[1]
            if self.committed + est > self.left:
                self.skipped_budget += 1
                return
            self.committed += est
        self.submitted += 1
        if self.started is None:
            self.started = time.time()
        self.futs.append(self.ex.submit(self._work, ch, v))

    def submit_ids(self, ch, ids):
        for vid in ids:
            v = read_json(cpaths(ch)["raw"] / f"{vid}.json")
            if isinstance(v, dict) and v.get("segments"):
                v["segments"] = norm_segments(v["segments"], v.get("durationSeconds"))
                v.setdefault("type", "video")
                self.submit(ch, v)

    def _work(self, ch, v):
        if self.out_of_credit:
            return
        try:
            t0 = time.time()
            data, usd = tag_video(self.client, self.model, ch, v)
            with self.lock:
                self.call_secs.append(time.time() - t0)
            cpaths(ch)["tags"].mkdir(parents=True, exist_ok=True)
            write_json(cpaths(ch)["tags"] / f"{v['videoId']}.json", data)
            add_spend("claude", usd, "tag video", ch["slug"])
            with self.lock:
                self.done += 1
                self.usd += usd
        except Exception as e:
            msg = str(e).lower()
            with self.lock:
                if "credit balance" in msg or "billing" in msg:
                    if not self.out_of_credit:
                        self.out_of_credit = True
                        say(f"\n    {Y}Claude credit is used up. Tagging stops here; the rest gets tagged next update "
                            f"after you add credit at console.anthropic.com/settings/billing.{X}")
                else:
                    self.failed += 1
                    say(f"\n    {Y}skipped tagging one video ({str(e)[:100]}), retried next update{X}")

    def status(self):
        return f"tagged {self.done}/{self.submitted}" + (f" ({self.failed} skipped)" if self.failed else "")

    def eta(self, elapsed):
        left = self.submitted - self.done - self.failed
        rate = self.done / elapsed if elapsed > 5 and self.done else None
        return fmt_eta(left / rate) if rate else ""

    def wait(self):
        t0 = time.time()
        while any(not f.done() for f in self.futs):
            el = time.time() - (self.started or t0)
            status(f"    Tagging     {bar(self.done + self.failed, self.submitted)}  {self.status()} · "
                   f"{money(self.usd)} · {self.eta(el)}")
            time.sleep(1)
        self.ex.shutdown(wait=True)
        if self.futs:
            status(f"    Tagging     {bar(self.done + self.failed, self.submitted)}  {self.status()} · {money(self.usd)}")
            status_done()
        if len(self.call_secs) >= 20:
            record_perf("tag_sec_per_video", sum(self.call_secs) / len(self.call_secs))
        if self.skipped_budget:
            warn(f"    {plural(self.skipped_budget, 'video')} left untagged to stay within the Claude budget")


class BatchPump:
    """Batch-tagging conveyor belt. As transcripts land during download, their IDs are queued (instant,
    on the download thread); a background worker reads them, builds the tag requests and submits them to
    Claude's Message Batches API in rolling chunks. All the heavy work (file reads, chunking, the API
    call) runs off the download loop, so downloads never stall. Submitted batches are persisted and
    collected at the end (or next run if this one is interrupted). About half price, like all batching."""

    def __init__(self, anth, model, channels, chunk=500, retag_old=False):
        self.anth, self.model, self.channels = anth, model, channels
        self.chunk, self.retag_old = chunk, retag_old
        self.q = Queue()           # (ch, vid) waiting to be submitted
        self.recs = []             # submitted batch records (guarded by lock)
        self.seen = set()          # (slug, vid) already queued (download thread only)
        self.lock = Lock()
        self.submitted_videos = 0
        self.out_of_credit = False
        self.left = budget_left("claude")  # None = no limit (normal update)
        self.committed = 0.0
        self.price = PRICES.get(model, (1.0, 5.0))
        self._stop = False
        self.worker = Thread(target=self._run, daemon=True)
        self.worker.start()

    def _enqueue(self, ch, vid):
        key = (ch["slug"], vid)
        if self.out_of_credit or key in self.seen or not needs_tag(ch, vid, self.retag_old):
            return
        self.seen.add(key)
        self.q.put((ch, vid))

    def submit_ids(self, ch, ids):  # called from the download thread as each batch lands
        for vid in ids:
            self._enqueue(ch, vid)

    def submit_pre_existing(self):
        """Queue already-downloaded-but-untagged videos (belt-first), cheaply by listing files."""
        for ch in self.channels:
            raw, tags = cpaths(ch)["raw"], cpaths(ch)["tags"]
            if not raw.exists():
                continue
            have = {f.stem for f in tags.glob("*.json")} if tags.exists() else set()
            for f in raw.glob("*.json"):
                if self.retag_old or f.stem not in have:
                    self._enqueue(ch, f.stem)

    def _run(self):
        batch = []
        while True:
            try:
                ch, vid = self.q.get(timeout=0.5)
            except Empty:
                if self._stop:
                    break
                continue
            v = read_json(cpaths(ch)["raw"] / f"{vid}.json")
            if isinstance(v, dict) and v.get("segments"):
                v["segments"] = norm_segments(v["segments"], v.get("durationSeconds"))
                v.setdefault("type", "video")
                keep = True
                if self.left is not None:
                    est = (video_words(v) * 1.4 / 1e6 * self.price[0] + 800 / 1e6 * self.price[1]) * 0.5
                    with self.lock:
                        if self.committed + est > self.left:
                            keep = False
                        else:
                            self.committed += est
                if keep:
                    batch.append((ch, v))
                    if len(batch) >= self.chunk:
                        self._flush(batch)
                        batch = []
            self.q.task_done()
        self._flush(batch)  # whatever is left when stopping

    def _flush(self, batch):
        if not batch or self.out_of_credit:
            return
        recs, ooc = submit_tag_batch(self.anth, self.model, batch, self.channels)
        with self.lock:
            self.recs.extend(recs)
            self.submitted_videos += sum(len(r["videos"]) for r in recs)
            if ooc:
                self.out_of_credit = True

    def status(self):
        with self.lock:
            n = self.submitted_videos
        return f"{n:,} sent to batch" if n else "batching tags"

    def collect(self, status_fn=None):
        self._stop = True
        self.worker.join(timeout=1200)  # drain the queue and flush the last partial batch
        with self.lock:
            recs = list(self.recs)
        return collect_tag_batches(self.anth, self.model, self.channels, recs, status_fn)


def tag_channel(client, model, ch, workers=TAG_WORKERS):
    p = cpaths(ch)
    p["tags"].mkdir(parents=True, exist_ok=True)
    todo = [v for v in load_videos(ch) if not (p["tags"] / f"{v['videoId']}.json").exists()]
    left = budget_left("claude")
    if left is not None and todo:
        price = PRICES.get(model, (1.0, 5.0))
        keep, est = [], 0.0
        for v in todo:
            c = video_words(v) * 1.4 / 1e6 * price[0] + 800 / 1e6 * price[1]
            if est + c > left:
                break
            keep.append(v)
            est += c
        if len(keep) < len(todo):
            warn(f"    {channel_label(ch)}: {len(todo) - len(keep)} left untagged to stay within the Claude budget")
        todo = keep
    if not todo:
        return 0, 0, False
    done, failed, total_usd = 0, 0, 0.0
    lock = Lock()

    def work(v):
        return v, *tag_video(client, model, ch, v)

    out_of_credit = False
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(work, v) for v in todo]
        for f in as_completed(futs):
            if out_of_credit:
                f.cancel()
                continue
            try:
                v, data, usd = f.result()
                write_json(p["tags"] / f"{v['videoId']}.json", data)
                add_spend("claude", usd, "tag video", ch["slug"])
                with lock:
                    done += 1
                    total_usd += usd
            except Exception as e:
                if "credit balance" in str(e).lower() or "billing" in str(e).lower():
                    out_of_credit = True
                    for other in futs:
                        other.cancel()
                    say(f"\n    {Y}Claude credit is used up. Stopping tagging here; the rest gets tagged next update "
                        f"after you add credit at console.anthropic.com/settings/billing.{X}")
                    continue
                with lock:
                    failed += 1
                say(f"\n    {Y}skipped one video ({str(e)[:120]}){X}")
            status(f"    {channel_label(ch)}: {bar(done + failed, len(todo))}  tagged {done}/{len(todo)}"
                   f"{f', {failed} skipped' if failed else ''} · {money(total_usd)}")
    status_done()
    return done, failed, out_of_credit


TOPIC_MERGE_PROMPT = """Below are topic labels used to tag YouTube videos (debates, lectures and streams, mostly about religion), with how many videos use each.
Map every label to a canonical label so synonyms and near-duplicates share one label. Examples: "apostle paul" and "paul" -> "paul"; "trinity doctrine" -> "trinity".
Keep canonical labels short and lowercase. Don't merge labels that mean genuinely different things.
Canonical labels already in use (reuse them when they fit): {existing}

Save the result with the save_mapping tool, with one entry for every label below.

Labels:
{labels}"""


def cleanup_topics(client, model, channels):
    mapping = read_obj(TOPIC_MAP_PATH)
    counts = {}
    for ch in channels:
        for f in cpaths(ch)["tags"].glob("*.json"):
            d = read_json(f, {})
            for t in (d.get("topics", []) if isinstance(d, dict) else []):
                if isinstance(t, dict) and t.get("topic"):
                    counts[t["topic"]] = counts.get(t["topic"], 0) + 1
    new = sorted([l for l in counts if l not in mapping], key=lambda l: -counts[l])
    if not new or client is None:
        return mapping
    say(f"    tidying {len(new)} new topic labels...")
    usd = 0.0
    for i in range(0, len(new), 300):
        part = new[i:i + 300]
        existing = sorted(set(mapping.values()) | set(SEED_TOPICS))
        prompt = TOPIC_MERGE_PROMPT.format(existing=", ".join(existing),
                                           labels="\n".join(f"{l} ({counts[l]})" for l in part))
        try:
            data, cost = call_claude_tool(client, model, prompt, MAP_TOOL, 8000)
            usd += cost
            got = {str(m.get("label", "")).strip().lower(): m.get("canonical")
                   for m in data.get("mapping") or [] if isinstance(m, dict)}
            for l in part:
                c = str(got.get(l) or l).strip().lower()
                mapping[l] = c or l
        except Exception as e:
            warn(f"    topic tidy-up skipped ({str(e)[:100]})")
            break
    write_json(TOPIC_MAP_PATH, mapping)
    add_spend("claude", usd, "topic tidy-up")
    return mapping


# ---------------------------------------------------------------- build outputs

def readable(text):
    return text.replace(" >> ", "  \n» ").replace(">> ", "» ")


def h(text):
    return html.escape(str(text or ""))


HTML_STYLE = """
:root{--bg:#eef1f4;--panel:#f8fafb;--fg:#18212b;--mut:#5e6b78;--line:#d3dae1;--acc:#1f5f8b;--live:#b9770e;--hit:#fff1c2}
@media (prefers-color-scheme:dark){:root{--bg:#12171d;--panel:#171e25;--fg:#e6ebf0;--mut:#8c99a6;--line:#25313c;--acc:#6fb3e0;--live:#e0a84a;--hit:#4a3d12}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 "Segoe UI",system-ui,-apple-system,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 96px}
a{color:var(--acc);text-decoration-thickness:1px;text-underline-offset:2px}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
nav{display:flex;gap:20px;align-items:baseline;padding:4px 0 18px;border-bottom:1px solid var(--line);margin-bottom:22px}
nav a{text-decoration:none;color:var(--mut);font-weight:600}nav a.on{color:var(--fg)}
nav .sp{flex:1}nav .stamp{color:var(--mut);font-size:.85rem}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:1.1rem;margin:28px 0 8px}
.lede{color:var(--mut);margin:0 0 18px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 7px;margin:2px 6px 2px 0;font-size:.82rem;color:var(--mut);text-decoration:none;background:var(--panel)}
a.tag:hover{border-color:var(--acc);color:var(--acc)}
.live{color:var(--live);border-color:var(--live);font-weight:600}
.shelf{margin:4px 0 26px;display:grid;gap:10px}
.shelf button{all:unset;cursor:pointer;display:grid;grid-template-columns:minmax(150px,230px) 1fr;gap:14px;align-items:center;padding:6px 8px;border-radius:6px}
.shelf button:hover,.shelf button.on{background:var(--panel)}
.shelf .nm{font-weight:600}.shelf .nm small{display:block;font-weight:400;color:var(--mut);font-size:.82rem}
.shelf .track{height:14px;background:var(--line);border-radius:3px;overflow:hidden;display:flex}
.shelf .vid{background:var(--acc)}.shelf .lv{background:var(--live)}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 6px}
.controls input{flex:1 1 260px}
input,select,button.more{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg)}
.count{color:var(--mut);font-size:.9rem;margin:8px 0 4px}
.row{display:grid;grid-template-columns:104px 1fr auto;gap:4px 16px;padding:14px 0;border-top:1px solid var(--line)}
.row .d{color:var(--mut);font-size:.88rem;font-variant-numeric:tabular-nums;padding-top:2px;white-space:nowrap}
.row .t{font-weight:600;line-height:1.3;text-decoration:none}.row .t:hover{text-decoration:underline}
.lede,.row .s,.seg>div,.moment>div,main>p,ul.claims{max-width:72ch}
.controls select{flex:1 1 150px}
.tbar a{text-decoration:none}.tbar a:hover{text-decoration:underline}
.row .s{color:var(--mut);font-size:.9rem;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row .c{color:var(--mut);font-size:.85rem;text-align:right;white-space:nowrap}
button.more{cursor:pointer;margin-top:16px}
.meta{color:var(--mut);font-size:.92rem;margin:0 0 10px}
.meta span{white-space:nowrap}.meta span+span::before{content:"/";margin:0 8px;color:var(--line)}
ul.claims{padding-left:20px}ul.claims li{margin:6px 0}
.find{position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:2;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--line)}
.find input{flex:1}
.seg{display:grid;grid-template-columns:86px 1fr;gap:16px;padding:10px 0;border-top:1px solid var(--line)}
.ts{font-variant-numeric:tabular-nums;font-weight:700;font-size:1.05rem;text-decoration:none;text-align:right;padding-top:1px}
.seg.hidden{display:none}.seg mark{background:var(--hit);color:inherit;border-radius:2px}
.turn{display:block}.turn+.turn{margin-top:4px}
.note{color:var(--mut);font-size:.88rem}
.tbar{display:grid;grid-template-columns:minmax(160px,280px) 1fr 52px;gap:12px;align-items:center;padding:6px 0;border-top:1px solid var(--line)}
.tbar .track{height:10px;background:var(--line);border-radius:3px;overflow:hidden}.tbar .fill{height:100%;background:var(--acc)}
.tbar .n{text-align:right;color:var(--mut);font-variant-numeric:tabular-nums}
.moment{display:grid;grid-template-columns:86px 1fr;gap:16px;padding:6px 0}
@media (max-width:640px){.row{grid-template-columns:1fr}.row .c{text-align:left}.seg,.moment{grid-template-columns:64px 1fr;gap:10px}
.shelf button{grid-template-columns:1fr}.tbar{grid-template-columns:1fr 44px}.tbar .track{display:none}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
"""


def nice_date(d):
    try:
        return datetime.strptime(d, "%Y-%m-%d").strftime("%d %b %Y").lstrip("0")
    except (TypeError, ValueError):
        return d or "?"


_BUILD = {"hashes": {}, "seen": set(), "written": 0, "skipped": 0}
BUILD_HASHES = OUTPUT / ".build_hashes.json"


def build_begin():
    _BUILD.update({"hashes": read_obj(BUILD_HASHES), "seen": set(), "written": 0, "skipped": 0})


def _key(path):
    try:
        return str(Path(path).resolve().relative_to(OUTPUT.resolve()))
    except ValueError:
        return str(path)


def write_if_changed(path, text):
    """Only touch files whose content changed: rebuilds stay fast as the archive grows."""
    import hashlib
    path = Path(path)
    key = _key(path)
    digest = hashlib.md5(text.encode("utf-8")).hexdigest()
    _BUILD["seen"].add(key)
    if _BUILD["hashes"].get(key) == digest and path.exists():
        _BUILD["skipped"] += 1
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    _BUILD["hashes"][key] = digest
    _BUILD["written"] += 1


def build_end(folders):
    """Remove files from earlier builds that no longer belong (renamed or removed videos/topics)."""
    removed = 0
    for folder, pattern in folders:
        if not folder.exists():
            continue
        for f in folder.glob(pattern):
            if _key(f) not in _BUILD["seen"]:
                try:
                    f.unlink()
                    removed += 1
                except OSError:
                    pass
    write_json(BUILD_HASHES, {k: v for k, v in _BUILD["hashes"].items() if k in _BUILD["seen"]})
    return removed


def topic_slug(topic):
    return safe_name(topic, 60).lower()


def html_page(title, body, depth=0, active="", stamp=False):
    up = "../" * depth
    nav = (f"<nav><a href='{up}index.html' class='{'on' if active == 'archive' else ''}'>Archive</a>"
           f"<a href='{up}topics.html' class='{'on' if active == 'topics' else ''}'>Topics</a><span class='sp'></span>"
           + (f"<span class='stamp'>Updated {datetime.now().strftime('%d %b %Y')}</span>" if stamp else "") + "</nav>")
    return (f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' "
            f"content='width=device-width,initial-scale=1'><title>{h(title)}</title><style>{HTML_STYLE}</style>"
            f"</head><body><main>{nav}{body}</main></body></html>")


def video_html(ch, v, chunks, tags, topics):
    vid = v["videoId"]
    kind = {"live": "<span class='tag live'>Live stream</span>", "short": "<span class='tag'>Short</span>"}.get(
        v.get("type"), "")
    meta = [f"<span dir='auto'>{h(full_name(ch))}</span>", f"<span>{h(nice_date(v.get('date')))}</span>"]
    dur = v.get("durationSeconds")
    if dur:
        meta.append(f"<span>{fmt_ts(dur)}</span>")
    if v.get("views") is not None:
        meta.append(f"<span>{int(v['views']):,} views</span>")
    meta.append(f"<span><a href='{h(v.get('url') or link(vid))}'>Watch on YouTube</a></span>")
    parts = [f"<h1 dir='auto'>{h(v.get('title'))}</h1>", f"<p class='meta'>{''.join(meta)}</p>"]
    chips = kind + "".join(f"<a class='tag' href='../t/{h(topic_slug(t))}.html'>{h(t)}</a>" for t in topics)
    if chips:
        parts.append(f"<p>{chips}</p>")
    if tags.get("summary"):
        parts.append(f"<p dir='auto'>{h(tags['summary'])}</p>")
    if tags.get("counterpart"):
        parts.append(f"<p class='note'>With: {h(tags['counterpart'])}</p>")
    if tags.get("key_claims"):
        lis = []
        for c in tags["key_claims"]:
            if c.get("chunk") is not None:
                ck = chunks[c["chunk"]]
                lis.append(f"<li>{h(c['claim'])} <a href='{h(ck['url'])}'>{ck['timestamp']}</a></li>")
            else:
                lis.append(f"<li>{h(c['claim'])}</li>")
        parts.append("<h2>Key claims</h2><ul class='claims'>" + "".join(lis) + "</ul>")
    parts.append("<h2>Transcript</h2><p class='note'>Auto-generated captions, so names and Arabic terms may be "
                 "misspelled. Each time opens the video at that moment. » marks a new speaker.</p>")
    parts.append("<div class='find'><input id='f' type='search' placeholder='Find in transcript, e.g. Paul'>"
                 "<span class='note' id='fc'></span></div><div id='tx'>")
    for c in chunks:
        turns = [t for t in re.split(r"\s*>>\s*", c["text"]) if t]
        body = "".join(f"<span class='turn'>{'» ' if i else ''}{h(t)}</span>" for i, t in enumerate(turns))
        parts.append(f"<div class='seg'><a class='ts' href='{h(c['url'])}'>{c['timestamp']}</a><div dir='auto'>{body}</div></div>")
    parts.append("</div>")
    parts.append("""<script>
const segs=[...document.querySelectorAll('.seg')].map(s=>({el:s,box:s.children[1],html:s.children[1].innerHTML,txt:s.children[1].textContent.toLowerCase()}));
const f=document.getElementById('f'),fc=document.getElementById('fc');
const esc=s=>s.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&');
f.addEventListener('input',()=>{const q=f.value.trim().toLowerCase();let n=0;
segs.forEach(s=>{if(!q){s.el.classList.remove('hidden');s.box.innerHTML=s.html;return}
const hit=s.txt.includes(q);s.el.classList.toggle('hidden',!hit);
s.box.innerHTML=hit?s.html.replace(new RegExp('('+esc(q)+')(?![^<]*>)','gi'),'<mark>$1</mark>'):s.html;if(hit)n++});
fc.textContent=q?(n+' of '+segs.length+' moments'):'';});
</script>""")
    return html_page(v.get("title") or vid, "".join(parts), depth=1)


def _mapping_sig(mapping):
    import hashlib
    return hashlib.md5(json.dumps(mapping, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:12]


def _video_sigs(ch, mapping):
    """Per-video fingerprint: raw transcript + tags + topic mapping + channel name. If a video's
    fingerprint is unchanged, it can be reused from the last build instead of recomputed."""
    p = cpaths(ch)
    mp = _mapping_sig(mapping)
    nm = full_name(ch)
    sigs = {}
    for f in sorted(p["raw"].glob("*.json")):
        vid = f.stem
        st = f.stat()
        t = p["tags"] / f"{vid}.json"
        tst = t.stat() if t.exists() else None
        sigs[vid] = "%s:%d:%d:%d:%d:%s" % (mp, st.st_mtime_ns, st.st_size,
                                           tst.st_mtime_ns if tst else 0, tst.st_size if tst else 0, nm)
    return sigs


def _grouped_chunks(path):
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    c = json.loads(line)
                    out.setdefault(c["video_id"], []).append(c)
    except OSError:
        pass
    return out


def _load_one_video(ch, vid):
    v = read_json(cpaths(ch)["raw"] / f"{vid}.json")
    if not isinstance(v, dict) or not v.get("segments"):
        return None
    v["segments"] = norm_segments(v["segments"], v.get("durationSeconds"))
    if not v["segments"]:
        return None
    v.setdefault("type", "video")
    return v


def _render_md(name, title, typ, date, url, views, dur, topics, counterpart, summary, claims, chunks):
    kind = {"live": "Live stream", "short": "Short"}.get(typ, "Video")
    lines = [f"# {title}", "",
             f"**Channel:** {name} · **Type:** {kind} · **Date:** {date or '?'}"
             + (f" · **Length:** {fmt_ts(dur)}" if dur else "")
             + (f" · **Views:** {int(views):,}" if views is not None else "") + "  ",
             f"**Video:** {url}  "]
    if topics:
        lines.append(f"**Topics:** {', '.join(topics)}  ")
    if counterpart:
        lines.append(f"**With:** {counterpart}  ")
    lines.append("")
    if summary:
        lines += ["## Summary", "", summary, ""]
    if claims:
        lines += ["## Key claims", ""]
        lines += [f"- {c['claim']}" + (f" ([{c['timestamp']}]({c['url']}))" if c.get("url") else "")
                  for c in claims]
        lines.append("")
    lines += ["## Transcript", "", "_Auto-generated captions: names and Arabic terms may be misspelled. "
              "Click a timestamp to check the original._", ""]
    for c in chunks:
        lines += [f"**[{c['timestamp']}]({c['url']})** {readable(c['text'])}", ""]
    return "\n".join(lines)


def _compute_artifact(ch, v, mapping, name):
    """Everything the build produces for one video, computed from its raw transcript + tags."""
    vid = v["videoId"]
    chunks = make_chunks(v, name)
    tags = clean_tags(read_obj(cpaths(ch)["tags"] / f"{vid}.json"), len(chunks))
    merged = {}
    for t in tags.get("topics", []):
        canon = mapping.get(t["topic"], t["topic"])
        merged.setdefault(canon, set()).update(t["chunks"])
    tags["topics"] = [{"topic": k, "chunks": sorted(s)} for k, s in merged.items()]
    topics = [t["topic"] for t in tags["topics"]]
    chunk_topics = {}
    topic_entries = []
    for t in tags["topics"]:
        for n in t["chunks"]:
            chunk_topics.setdefault(n, []).append(t["topic"])
        moments = [{"timestamp": chunks[n]["timestamp"], "url": chunks[n]["url"],
                    "preview": chunks[n]["text"][:220]} for n in t["chunks"][:6]]
        topic_entries.append((t["topic"], {
            "channel": name, "video_id": vid, "title": v.get("title"), "date": v.get("date"),
            "type": v.get("type"), "page": f"v/{vid}.html",
            "moments": moments or [{"timestamp": "0:00", "url": link(vid, 0), "preview": ""}]}))
    for c in chunks:
        c["topics"] = chunk_topics.get(c["n"], [])
    words = sum(len(c["text"].split()) for c in chunks)
    dur = v.get("durationSeconds") or (chunks[-1]["end"] if chunks else 0)
    claims = [{**c, "timestamp": chunks[c["chunk"]]["timestamp"] if c.get("chunk") is not None else None,
               "url": chunks[c["chunk"]]["url"] if c.get("chunk") is not None else None}
              for c in tags.get("key_claims", [])]
    row = {
        "channel": name, "video_id": vid, "type": v.get("type", "video"), "title": v.get("title"),
        "date": v.get("date"), "views": v.get("views"), "likes": v.get("likes"),
        "comments": v.get("comments"), "duration_min": round(float(dur) / 60, 1) if dur else "",
        "words": words, "language": v.get("language") or "", "format": tags.get("format", ""),
        "counterpart": tags.get("counterpart") or "", "topics": "; ".join(topics),
        "summary": tags.get("summary", ""), "url": v.get("url") or link(vid),
    }
    vj = {
        "channel": name, "videoId": vid, "type": v.get("type", "video"),
        **{k: v.get(k) for k in ("title", "date", "url", "views", "likes", "comments",
                                 "durationSeconds", "language", "description")},
        "summary": tags.get("summary"), "format": tags.get("format"),
        "counterpart": tags.get("counterpart"), "topics": tags["topics"], "key_claims": claims,
        "chunk_count": len(chunks), "words": words,
    }
    md = _render_md(name, v.get("title"), v.get("type", "video"), v.get("date"),
                    v.get("url") or link(vid), v.get("views"), dur, topics,
                    tags.get("counterpart"), tags.get("summary"), claims, chunks)
    fname = f"{v.get('date') or 'nodate'}_{safe_name(v.get('title'))}_{vid}.md"
    return {"vid": vid, "date": v.get("date"), "type": v.get("type", "video"), "title": v.get("title"),
            "fname": fname, "chunks": chunks, "vj": vj, "row": row, "md": md, "topics": topic_entries}


def _reuse_artifact(ch, vid, vj, row, chunks, name):
    """Rebuild a video's artifact from the last build's outputs, with no raw transcript re-parse."""
    bychunk = {c.get("n"): c for c in chunks}
    topic_entries = []
    for t in vj.get("topics", []):
        moments = [{"timestamp": bychunk[n]["timestamp"], "url": bychunk[n]["url"],
                    "preview": bychunk[n]["text"][:220]} for n in t.get("chunks", [])[:6] if n in bychunk]
        topic_entries.append((t["topic"], {
            "channel": name, "video_id": vid, "title": vj.get("title"), "date": vj.get("date"),
            "type": vj.get("type"), "page": f"v/{vid}.html",
            "moments": moments or [{"timestamp": "0:00", "url": link(vid, 0), "preview": ""}]}))
    topics = [t["topic"] for t in vj.get("topics", [])]
    dur = vj.get("durationSeconds") or (chunks[-1]["end"] if chunks else 0)
    md = _render_md(name, vj.get("title"), vj.get("type", "video"), vj.get("date"),
                    vj.get("url") or link(vid), vj.get("views"), dur, topics,
                    vj.get("counterpart"), vj.get("summary"), vj.get("key_claims") or [], chunks)
    fname = f"{vj.get('date') or 'nodate'}_{safe_name(vj.get('title'))}_{vid}.md"
    return {"vid": vid, "date": vj.get("date"), "type": vj.get("type", "video"), "title": vj.get("title"),
            "fname": fname, "chunks": chunks, "vj": vj, "row": row, "md": md, "topics": topic_entries}


def read_csv_rows(path):
    try:
        with open(path, encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))
    except OSError:
        return []


def build_channel(ch, mapping, progress=None):
    p = cpaths(ch)
    for k in ("read", "topics", "nlm", "data"):
        p[k].mkdir(parents=True, exist_ok=True)
    name = full_name(ch)
    cur_sig = _video_sigs(ch, mapping)
    state = read_obj(p["base"] / ".build_state.json")
    prev_sig = state.get("vids") if isinstance(state.get("vids"), dict) else {}
    outputs_ok = (p["data"] / "chunks.jsonl").exists() and (p["data"] / "videos.json").exists()

    # whole channel unchanged: reuse its outputs as-is, no rewrite
    if outputs_ok and prev_sig and cur_sig == prev_sig:
        vj = read_list(p["data"] / "videos.json")
        if progress:
            for _ in vj:
                progress()
        return {"rows": read_csv_rows(p["data"] / "videos.csv"), "videos": vj,
                "n_chunks": int(state.get("n_chunks") or 0),
                "topics": read_obj(p["data"] / "topics.json")}

    # load the previous build's outputs so unchanged videos can be reused without re-parsing
    old_vj, old_rows, old_chunks = {}, {}, {}
    if outputs_ok and prev_sig:
        old_vj = {x["videoId"]: x for x in (read_list(p["data"] / "videos.json"))}
        old_rows = {r["video_id"]: r for r in read_csv_rows(p["data"] / "videos.csv")}
        old_chunks = _grouped_chunks(p["data"] / "chunks.jsonl")

    arts = []
    for vid in cur_sig:
        a = None
        if (prev_sig.get(vid) == cur_sig[vid] and vid in old_vj
                and vid in old_chunks and vid in old_rows):
            a = _reuse_artifact(ch, vid, old_vj[vid], old_rows[vid], old_chunks[vid], name)
        if a is None:
            v = _load_one_video(ch, vid)
            if v is None:
                continue
            a = _compute_artifact(ch, v, mapping, name)
        arts.append(a)
        if progress:
            progress()
    arts.sort(key=lambda a: a["date"] or "", reverse=True)

    n_chunks = 0
    rows, video_json, topic_map, md_by_vid = [], [], {}, {}
    with open(p["data"] / "chunks.jsonl.tmp", "w", encoding="utf-8") as cf:  # with-block: no leaked handle on error
        for a in arts:
            for c in a["chunks"]:
                cf.write(json.dumps(c, ensure_ascii=False) + "\n")
                n_chunks += 1
            rows.append(a["row"])
            video_json.append(a["vj"])
            md_by_vid[a["vid"]] = a["md"]
            write_if_changed(p["read"] / a["fname"], a["md"])
            for topic, entry in a["topics"]:
                topic_map.setdefault(topic, []).append(entry)
    replace_file(p["data"] / "chunks.jsonl.tmp", p["data"] / "chunks.jsonl")

    idx = [f"# {name}", "", f"{len(arts)} transcripts, newest first.", ""]
    idx += [f"- {a['date']} | {'LIVE | ' if a['type'] == 'live' else ''}"
            f"[{a['title']}](read/{a['fname'].replace(' ', '%20')})" for a in arts]
    write_if_changed(p["base"] / "INDEX.md", "\n".join(idx))
    write_topic_pages(p["topics"], topic_map)

    ordered = sorted(arts, key=lambda a: a["date"] or "")
    for b in range(0, len(ordered), BUNDLE_SIZE):
        part = ordered[b:b + BUNDLE_SIZE]
        fname = (f"{ch['slug']}_bundle_{b // BUNDLE_SIZE + 1:02d}_"
                 f"{part[0]['date']}_to_{part[-1]['date']}.md")
        write_if_changed(p["nlm"] / fname, "\n\n---\n\n".join(md_by_vid[a["vid"]] for a in part))

    if rows:
        write_csv(p["data"] / "videos.csv", rows)
    write_json(p["data"] / "videos.json", video_json)
    write_json(p["data"] / "topics.json", dict(sorted(topic_map.items(), key=lambda kv: -len(kv[1]))))
    write_json(p["base"] / ".build_state.json", {"vids": cur_sig, "n_chunks": n_chunks})
    return {"rows": rows, "videos": video_json, "n_chunks": n_chunks, "topics": topic_map}


def write_csv(path, rows):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def write_jsonl(path, items):
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    replace_file(tmp, path)


def write_topic_pages(folder, topic_map):
    folder.mkdir(parents=True, exist_ok=True)
    for topic, items in sorted(topic_map.items()):
        lines = [f"# Topic: {topic}", "", f"{len(items)} videos.", ""]
        for it in sorted(items, key=lambda x: x["date"] or "", reverse=True):
            lines += [f"## {it['title']} ({it['channel']}, {it['date']})", ""]
            for m in it["moments"]:
                prev = readable(m["preview"]).replace("  \n", " ")
                lines.append(f"- [{m['timestamp']}]({m['url']}) {prev}...")
            lines.append("")
        write_if_changed(folder / f"{safe_name(topic, 60)}.md", "\n".join(lines))


def build_all(channels, mapping):
    ALL.mkdir(parents=True, exist_ok=True)
    build_begin()
    total = sum(len(list(cpaths(ch)["raw"].glob("*.json"))) for ch in channels if cpaths(ch)["raw"].exists())
    done = {"n": 0, "t": 0.0}

    def progress():
        done["n"] += 1
        now = time.time()
        if now - done["t"] > 0.3 or done["n"] == total:
            done["t"] = now
            status(f"    Building    {bar(done['n'], total, 18)}  {done['n']:,}/{total:,} videos · "
                   f"{_BUILD['written']:,} files updated, {_BUILD['skipped']:,} unchanged")
    rows, videos, topics = [], [], {}
    counts = []
    for ch in channels:
        r = build_channel(ch, mapping, progress)
        rows += r["rows"]
        videos += r["videos"]
        for k, v in r["topics"].items():
            topics.setdefault(k, []).extend(v)
        counts.append((ch, len(r["rows"]), r["n_chunks"]))
    stats = {"updated": datetime.now().isoformat(timespec="seconds"), "channels": {}, "total": {}}
    tot = {"videos": 0, "lives": 0, "shorts": 0, "seconds": 0.0, "live_seconds": 0.0, "words": 0, "tagged": 0}
    for ch, _, _ in counts:
        mine = [r for r in rows if r["channel"] == full_name(ch)]
        st = {"name": full_name(ch), "videos": len(mine),
              "lives": sum(1 for r in mine if r["type"] == "live"),
              "shorts": sum(1 for r in mine if r["type"] == "short"),
              "seconds": sum(float(r["duration_min"] or 0) * 60 for r in mine),
              "live_seconds": sum(float(r["duration_min"] or 0) * 60 for r in mine if r["type"] == "live"),
              "words": sum(int(r["words"] or 0) for r in mine),
              "tagged": sum(1 for r in mine if r["summary"]),
              "first": min((r["date"] for r in mine if r["date"]), default=""),
              "last": max((r["date"] for r in mine if r["date"]), default="")}
        stats["channels"][ch["slug"]] = st
        for k in tot:
            tot[k] += st[k]
    stats["total"] = tot
    write_json(STATS_PATH, stats)
    if rows:
        write_csv(ALL / "videos.csv", rows)
    write_json(ALL / "videos.json", videos)
    all_tmp = ALL / "chunks.jsonl.tmp"
    with open(all_tmp, "w", encoding="utf-8") as out:
        for ch in channels:
            cpath = cpaths(ch)["data"] / "chunks.jsonl"
            if cpath.exists():
                with open(cpath, encoding="utf-8") as f:
                    for line in f:
                        out.write(line)
    replace_file(all_tmp, ALL / "chunks.jsonl")
    write_json(ALL / "topics.json", dict(sorted(topics.items(), key=lambda kv: -len(kv[1]))))
    write_topic_pages(ALL / "topics", topics)
    idx = ["# Archive", ""]
    for ch, n, _ in counts:
        idx.append(f"- **{full_name(ch)}**: {n} transcripts. [Index]({ch['slug']}/INDEX.md)")
    idx += ["", "Browse in your browser: run the app and pick option 4 (Open the archive). "
            "Data files for AI tools are in `ALL/` and each channel folder."]
    write_if_changed(OUTPUT / "INDEX.md", "\n".join(idx))
    status_done()
    managed = [(ALL / "topics", "*.md")]
    for ch in channels:
        p = cpaths(ch)
        managed += [(p["read"], "*.md"), (p["topics"], "*.md"), (p["nlm"], "*.md")]
    build_end(managed)
    return counts


def write_site_index(videos, stats):
    data = [{"c": v["channel"], "i": v["videoId"], "y": v.get("type", "video"), "t": v.get("title") or "",
             "d": v.get("date") or "", "s": v.get("summary") or "", "w": v.get("views") or 0,
             "p": [t["topic"] for t in v.get("topics") or []],
             "g": [topic_slug(t["topic"]) for t in v.get("topics") or []],
             "m": round((v.get("durationSeconds") or 0) / 60)} for v in videos]
    data.sort(key=lambda x: x["d"], reverse=True)
    chans = sorted(stats.get("channels", {}).values(), key=lambda c: -c.get("seconds", 0))
    tot = stats.get("total", {})
    most = max((c.get("seconds", 0) for c in chans), default=1) or 1
    shelf = []
    for c in chans:
        secs = c.get("seconds", 0)
        lsecs = min(c.get("live_seconds", 0), secs)
        shelf.append(
            f"<button data-ch=\"{h(c['name'])}\"><span class='nm'><bdi>{h(c['name'])}</bdi>"
            f"<small>{c.get('videos', 0):,} videos, {c.get('lives', 0):,} lives, {fmt_hours(secs)}</small></span>"
            f"<span class='track' style='width:{max(4, secs / most * 100):.1f}%' title='Blue: videos. Gold: live streams.'>"
            f"<span class='vid' style='flex:{max(secs - lsecs, 0):.0f}'></span>"
            f"<span class='lv' style='flex:{lsecs:.0f}'></span></span></button>")
    lede = (f"{tot.get('videos', 0):,} transcripts, {fmt_hours(tot.get('seconds', 0))} of video across "
            f"{plural(len(chans), 'channel')}. Pick a channel below to narrow the list.")
    body = f"""<h1>Archive</h1><p class='lede'>{h(lede)}</p>
<div class='shelf'>{''.join(shelf)}</div>
<div class='controls'><input id='q' type='search' placeholder='Search titles and summaries'>
<select id='ty'><option value=''>Videos and lives</option><option value='video'>Videos only</option><option value='live'>Lives only</option><option value='short'>Shorts only</option></select>
<select id='tp'><option value=''>Any topic</option></select>
<select id='so'><option value='new'>Newest first</option><option value='old'>Oldest first</option><option value='long'>Longest first</option><option value='views'>Most viewed</option></select></div>
<p class='count' id='count'></p><div id='rows'></div><button class='more' id='more' hidden>Show more</button>
<script>
const D=__DATA__;let ch='',shown=150;
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c]));
const tops={{}};D.forEach(d=>d.p.forEach(t=>tops[t]=(tops[t]||0)+1));
Object.entries(tops).sort((a,b)=>b[1]-a[1]).forEach(([t,n])=>$('tp').insertAdjacentHTML('beforeend',`<option value="${{esc(t)}}">${{esc(t)}} (${{n}})</option>`));
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const day=d=>{{const p=d.split('-');return p.length==3?(+p[2])+' '+MON[+p[1]-1]+' '+p[0]:d;}};
const dur=m=>m>=60?(Math.floor(m/60)+' h '+(m%60)+' min'):(m+' min');
function list(){{const q=$('q').value.toLowerCase(),y=$('ty').value,t=$('tp').value,so=$('so').value;
let r=D.filter(d=>(!ch||d.c==ch)&&(!y||d.y==y)&&(!t||d.p.includes(t))&&(!q||(d.t+' '+d.s).toLowerCase().includes(q)));
if(so=='old')r.sort((a,b)=>a.d.localeCompare(b.d));else if(so=='long')r.sort((a,b)=>b.m-a.m);else if(so=='views')r.sort((a,b)=>b.w-a.w);
const hrs=r.reduce((a,d)=>a+d.m,0)/60;
$('count').textContent=r.length.toLocaleString()+' of '+D.length.toLocaleString()+' videos, '+(hrs>=10?Math.round(hrs).toLocaleString():hrs.toFixed(1))+' hours';
$('rows').innerHTML=r.slice(0,shown).map(d=>`<div class='row'><div class='d'>${{esc(day(d.d))}}</div><div><a class='t' dir='auto' href='v/${{esc(d.i)}}.html'>${{esc(d.t)}}</a>
<div class='s' dir='auto'>${{esc(d.s)}}</div><div>${{d.y=='live'?"<span class='tag live'>Live</span>":''}}${{d.p.slice(0,4).map((p,i)=>`<a class='tag' href='t/${{esc(d.g[i])}}.html'>${{esc(p)}}</a>`).join('')}}</div></div>
<div class='c'>${{d.m?dur(d.m):''}}<br>${{esc(d.c)}}</div></div>`).join('');
$('more').hidden=r.length<=shown;}}
document.querySelectorAll('.shelf button').forEach(b=>b.addEventListener('click',()=>{{ch=ch==b.dataset.ch?'':b.dataset.ch;
document.querySelectorAll('.shelf button').forEach(x=>x.classList.toggle('on',x.dataset.ch==ch));shown=150;list();}}));
['q','ty','tp','so'].forEach(id=>$(id).addEventListener('input',()=>{{shown=150;list();}}));
$('more').addEventListener('click',()=>{{shown+=300;list();}});list();
</script>"""
    body = body.replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    (ALL / "site").mkdir(parents=True, exist_ok=True)
    write_if_changed(ALL / "site" / "index.html", html_page("Archive", body, 0, "archive", stamp=True))


def write_site_topics(topic_map):
    site = ALL / "site"
    tdir = site / "t"
    tdir.mkdir(parents=True, exist_ok=True)
    items = sorted(topic_map.items(), key=lambda kv: -len(kv[1]))
    most = max((len(v) for _, v in items), default=1) or 1
    rows = [f"<div class='tbar'><a href='t/{h(topic_slug(t))}.html'>{h(t[:1].upper() + t[1:])}</a>"
            f"<span class='track'><span class='fill' style='display:block;width:{len(v) / most * 100:.1f}%'></span></span>"
            f"<span class='n'>{len(v):,}</span></div>" for t, v in items]
    body = (f"<h1>Topics</h1><p class='lede'>{len(items):,} topics, by how many videos discuss them. "
            f"Each topic page lists the exact moments, so you can jump straight to them.</p>" + "".join(rows))
    write_if_changed(site / "topics.html", html_page("Topics", body, 0, "topics"))
    for t, vids in items:
        parts = [f"<h1>{h(t[:1].upper() + t[1:])}</h1><p class='lede'>Discussed in {plural(len(vids), 'video')}. "
                 f"Times open the video at that moment.</p>"]
        for it in sorted(vids, key=lambda x: x["date"] or "", reverse=True):
            live = " <span class='tag live'>Live</span>" if it.get("type") == "live" else ""
            parts.append(f"<h2 dir='auto'><a href='../v/{h(it['video_id'])}.html'>{h(it['title'])}</a>{live}</h2>"
                         f"<p class='meta'><span>{h(it['channel'])}</span><span>{h(nice_date(it['date']))}</span></p>")
            for m in it["moments"]:
                prev = re.sub(r"\s*>>\s*", " » ", m["preview"]).rstrip(" .,")
                parts.append(f"<div class='moment'><a class='ts' href='{h(m['url'])}'>{m['timestamp']}</a>"
                             f"<div dir='auto'>{h(prev)}…</div></div>")
        write_if_changed(tdir / f"{topic_slug(t)}.html", html_page(t, "".join(parts), 1, "topics"))


# ---------------------------------------------------------------- search index

_embedders = {}


def get_embedder(model_name):
    if model_name not in _embedders:
        from fastembed import TextEmbedding
        _embedders[model_name] = TextEmbedding(model_name, cache_dir=str(ROOT / ".models"))
    return _embedders[model_name]


def passage_texts(model_name, chunks):
    pre = "passage: " if "e5" in model_name else ""
    return [f"{pre}{c['title']}: {c['text']}" for c in chunks]


def query_text(model_name, q):
    return ("query: " if "e5" in model_name else "") + q


def load_chunks(ch):
    path = cpaths(ch)["data"] / "chunks.jsonl"
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


FAST_INDEX = {"on": True, "failed": False}
INDEX_SLICE = 4000  # chunks per step; the index is saved after each step


def index_workers():
    return max(1, min(6, (os.cpu_count() or 2) - 1))


def embed_into(model, model_name, items, vecs, tick):
    """Embed items into vecs, on all cores when possible; falls back to one process if that fails."""
    fast = FAST_INDEX["on"] and not FAST_INDEX["failed"] and index_workers() > 1 and len(items) >= 200
    texts = passage_texts(model_name, items)
    try:
        gen = model.embed(texts, batch_size=64, parallel=index_workers()) if fast else model.embed(texts, batch_size=64)
        for c, e in zip(items, gen):
            vecs[c["chunk_id"]] = e
            tick()
    except Exception as e:
        if not fast:
            raise
        FAST_INDEX["failed"] = True
        say(f"\n    {Y}Fast indexing didn't work on this PC ({str(e)[:80]}). Continuing at normal speed.{X}")
        rest = [c for c in items if c["chunk_id"] not in vecs]
        for c, e in zip(rest, model.embed(passage_texts(model_name, rest), batch_size=64)):
            vecs[c["chunk_id"]] = e
            tick()


def save_index(p, ids, vecs, model_name):
    import numpy as np
    keep = [i for i in ids if i in vecs]
    mat = np.array([vecs[i] for i in keep], dtype=np.float32)
    if len(mat):
        mat /= np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9
    with open(p["search"] / "embeddings.tmp", "wb") as f:
        np.save(f, mat)
    replace_file(p["search"] / "embeddings.tmp", p["search"] / "embeddings.npy")
    write_json(p["search"] / "ids.json", keep)
    write_json(p["search"] / "meta.json", {"model": model_name, "count": len(keep)})


def nested_clip_ids():
    nests = read_obj(OUTPUT / "nests.json")
    return set((nests.get("parent") or {}).keys())


def index_channel(ch, model_name, status_fn=None, quiet=False):
    import numpy as np
    p = cpaths(ch)
    p["search"].mkdir(parents=True, exist_ok=True)
    chunks = load_chunks(ch)
    clips = nested_clip_ids()
    if clips:
        chunks = [c for c in chunks if c.get("video_id") not in clips]
    if not chunks:
        return 0
    ids = [c["chunk_id"] for c in chunks]
    meta = read_obj(p["search"] / "meta.json")
    old_ids = read_list(p["search"] / "ids.json")
    old_model = meta.get("model") or (SEARCH_MODELS["english"] if old_ids else None)
    vecs = {}
    if old_ids and old_model == model_name and (p["search"] / "embeddings.npy").exists():
        arr = np.load(p["search"] / "embeddings.npy")
        if len(arr) == len(old_ids):
            vecs = dict(zip(old_ids, arr))
    wanted = set(ids)
    vecs = {k: v for k, v in vecs.items() if k in wanted}
    new = [c for c in chunks if c["chunk_id"] not in vecs]
    if not new and old_ids == ids:
        return 0
    if new:
        model = get_embedder(model_name)
        t0 = time.time()
        prog = {"done": 0, "shown": 0.0}

        def tick(force=False):
            if quiet:
                return
            prog["done"] += 0 if force else 1
            now = time.time()
            if not force and now - prog["shown"] < 0.5:
                return
            prog["shown"] = now
            done, el = prog["done"], now - t0
            rate = done / el if el > 1 else 0
            mode = (f"{index_workers()} cores" if FAST_INDEX["on"] and not FAST_INDEX["failed"]
                    and index_workers() > 1 else "1 core")
            extra = f" · {status_fn()}" if status_fn else ""
            status(f"    {channel_label(ch)[:20]:<20} {bar(done, len(new), 18)}  {done:,}/{len(new):,}"
                   + (f" · {rate:,.0f}/s on {mode} · {fmt_eta((len(new) - done) / rate)}" if rate else f" · starting on {mode}")
                   + extra)

        tick(force=True)
        for a in range(0, len(new), INDEX_SLICE):
            embed_into(model, model_name, new[a:a + INDEX_SLICE], vecs, tick)
            save_index(p, ids, vecs, model_name)  # checkpoint: closing the window now loses at most one step
        tick(force=True)
        if not quiet:
            status_done()
        if len(new) >= 500:
            record_perf("index_chunks_per_sec", len(new) / max(time.time() - t0, 1e-6))
    save_index(p, ids, vecs, model_name)
    return len(new)


class IndexBelt:
    """Builds chunks and embeddings for semantic channels in the background as their transcripts
    land, so the heavy embedding is mostly finished by the time downloads do. Stays silent while it
    runs (the download line owns the screen); the final index pass cleans up anything left. Keyword
    (Arabic / big) channels are skipped here, as their on-disk index already builds in minutes."""

    def __init__(self, channels, mapping, model_name):
        self.mapping = mapping
        self.model_name = model_name
        self.by_slug = {c["slug"]: c for c in channels}
        self.dirty = set()
        self.lock = Lock()
        self._stop = False
        self.indexed = 0
        self.worker = Thread(target=self._run, daemon=True)
        self.worker.start()

    def mark(self, ch, ids=None):
        if ch.get("search") == "keyword":
            return
        with self.lock:
            self.dirty.add(ch["slug"])

    def _next(self):
        with self.lock:
            return self.dirty.pop() if self.dirty else None

    def _run(self):
        _STATUS_QUIET.on = True  # never fight the download line for the screen
        while not self._stop:
            slug = self._next()
            if slug is None:
                time.sleep(3)
                continue
            ch = self.by_slug.get(slug)
            if not ch:
                continue
            try:
                build_channel(ch, self.mapping, None)
                self.indexed += index_channel(ch, self.model_name, quiet=True)
            except Exception:
                pass  # best-effort accelerator; the final index pass will redo this channel

    def finish(self):
        self._stop = True
        self.worker.join(timeout=600)


# ---------------------------------------------------------------- keyword search (Arabic and big channels)

_AR_DIAC = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]")
_AR_TR = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"})


def norm_text(text):
    """Normalise for matching: no harakat, one alef, ة=ه, ى=ي, and ال/وال/بال/فال/كال/لل prefixes dropped."""
    t = _AR_DIAC.sub("", text or "").translate(_AR_TR).lower()
    out = []
    for w in re.findall(r"\w+", t):
        if len(w) > 5 and w[:3] in ("وال", "بال", "فال", "كال"):
            w = w[3:]
        elif len(w) > 4 and w[:2] in ("لل", "ال"):
            w = w[2:]
        out.append(w)
    return " ".join(out)


def kw_db(ch):
    import sqlite3
    p = cpaths(ch)
    p["search"].mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(p["search"] / "keyword.db"))
    try:
        con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(body, tokenize='unicode61 remove_diacritics 2')")
    except sqlite3.OperationalError:
        con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts4(body)")
    con.execute("""CREATE TABLE IF NOT EXISTS info(rowid INTEGER PRIMARY KEY, chunk_id TEXT UNIQUE, video_id TEXT,
                   title TEXT, date TEXT, ts TEXT, url TEXT, channel TEXT, type TEXT, text TEXT)""")
    return con


def kw_index_channel(ch, status_fn=None):
    """Keyword index: builds in minutes even for huge channels, lives on disk instead of in memory."""
    p = cpaths(ch)
    path = p["data"] / "chunks.jsonl"
    if not path.exists():
        return 0
    con = kw_db(ch)
    clips = nested_clip_ids()
    have = {r[0]: r[1] for r in con.execute("SELECT chunk_id, rowid FROM info")}
    current, new = set(), []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            c = json.loads(line)
            if clips and c.get("video_id") in clips:
                continue
            current.add(c["chunk_id"])
            if c["chunk_id"] not in have:
                new.append(c)
    stale = [rid for cid, rid in have.items() if cid not in current]
    for rid in stale:
        con.execute("DELETE FROM fts WHERE rowid = ?", (rid,))
        con.execute("DELETE FROM info WHERE rowid = ?", (rid,))
    t0 = time.time()
    for i, c in enumerate(new, 1):
        cur = con.execute("INSERT INTO info(chunk_id, video_id, title, date, ts, url, channel, type, text) "
                          "VALUES (?,?,?,?,?,?,?,?,?)",
                          (c["chunk_id"], c["video_id"], c["title"], c["date"], c["timestamp"], c["url"],
                           c.get("channel") or full_name(ch), c.get("type") or "video", c["text"]))
        con.execute("INSERT INTO fts(rowid, body) VALUES (?, ?)", (cur.lastrowid, norm_text(c["title"] + " " + c["text"])))
        if i % 2000 == 0 or i == len(new):
            con.commit()
            el = time.time() - t0
            extra = f" · {status_fn()}" if status_fn else ""
            status(f"    {channel_label(ch)[:20]:<20} {bar(i, len(new), 18)}  {i:,}/{len(new):,} keyword index"
                   f" · {i / el if el else 0:,.0f}/s{extra}")
    con.commit()
    con.close()
    if new:
        status_done()
    return len(new)


def kw_search(ch, terms, limit=40):
    parts = []
    for t in terms:
        toks = norm_text(t).split()
        if toks:
            parts.append('"' + " ".join(toks) + '"' + ("*" if len(toks) == 1 and len(toks[0]) >= 3 else ""))
    if not parts or not (cpaths(ch)["search"] / "keyword.db").exists():
        return []
    con = kw_db(ch)
    try:
        rows = con.execute("SELECT info.chunk_id, info.video_id, info.title, info.date, info.ts, info.url, "
                           "info.channel, info.type, info.text FROM fts JOIN info ON info.rowid = fts.rowid "
                           "WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?", (" OR ".join(dict.fromkeys(parts)), limit)).fetchall()
    except Exception:
        rows = []
    con.close()
    return [{"chunk_id": r[0], "video_id": r[1], "title": r[2], "date": r[3], "timestamp": r[4], "url": r[5],
             "channel": r[6], "type": r[7], "text": r[8]} for r in rows]


TERMS_TOOL = {
    "name": "search_terms",
    "description": "Search terms for a transcript archive.",
    "input_schema": {"type": "object", "properties": {
        "arabic": {"type": "array", "items": {"type": "string"}, "description": "Arabic words or short phrases"},
        "english": {"type": "array", "items": {"type": "string"}, "description": "English words or short phrases"}},
        "required": ["arabic", "english"]},
}

TERMS_PROMPT = """Someone is searching transcripts of Islamic lectures, fatawa and debates for this question:
{q}

Give the words and short phrases (1-3 words each) that would actually be spoken in a passage answering it:
- Arabic: 6-12 terms as a scholar would say them (fiqh/aqeedah terminology, key nouns, the likely ayah or hadith wording), without harakat.
- English: 4-8 terms, only if English speakers might discuss it.
Use the search_terms tool."""


def keyword_terms(client, model, q):
    try:
        data, usd = call_claude_tool(client, model, TERMS_PROMPT.format(q=q), TERMS_TOOL, 400)
        add_spend("claude", usd, "search terms")
        return [str(t) for t in (data.get("arabic") or []) + (data.get("english") or []) if str(t).strip()]
    except Exception:
        return []


# ---------------------------------------------------------------- update flow

class UpdateLock:
    """Only one Update at a time. The OS releases the lock if the window crashes or is closed."""

    def __enter__(self):
        OUTPUT.mkdir(parents=True, exist_ok=True)
        self.f = open(OUTPUT / ".update.lock", "a+")
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.f.close()
            return False
        return True

    def __exit__(self, *exc):
        try:
            if os.name == "nt":
                import msvcrt
                self.f.seek(0)
                msvcrt.locking(self.f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.f.fileno(), fcntl.LOCK_UN)
            self.f.close()
        except Exception:
            pass
        return False


def update(settings, unattended=False):
    lock = UpdateLock()
    if not lock.__enter__():
        err("An update is already running in another window. Let it finish first "
            "(you can still ask questions or open the archive meanwhile).")
        return
    keep_awake(True)
    try:
        _update(settings, unattended)
    finally:
        keep_awake(False)
        lock.__exit__(None, None, None)


def _update(settings, unattended):
    global PARALLEL_BATCHES, PARALLEL_CEILING
    PARALLEL_BATCHES, PARALLEL_CEILING = auto_parallel_bounds()
    FAST_INDEX["on"] = settings.get("fast_indexing", True)
    run_start, run_iso = time.time(), datetime.now().isoformat(timespec="seconds")
    before = read_obj(STATS_PATH).get("channels", {})
    confirm = (lambda q: True) if unattended else yes
    channels = settings["channels"]
    if not channels:
        warn("No channels yet. Add one from the menu first.")
        return
    if not need_key("APIFY_TOKEN"):
        err("APIFY_TOKEN is missing in .env.")
        return
    client = apify_client()
    a_line, c_line, bal = balance_line()
    head("Update")
    say(a_line)

    # 1. list videos (free with yt-dlp; Apify only as a backup)
    plans = {}
    for ch in channels:
        meta, _ = load_listing(ch)
        fetched = meta.get("fetched", {})
        plan = {}
        recent_ok = False
        try:
            recent_ok = (datetime.now() - datetime.fromisoformat(meta.get("updated", ""))).total_seconds() < 6 * 3600
        except ValueError:
            pass
        for kind in wanted_kinds(ch):
            if ch.get("full_refresh") or not fetched.get(kind):
                plan[kind] = "full"
            elif not recent_ok:
                plan[kind] = "recent"
        plans[ch["slug"]] = plan
    full_scans = [(ch, k) for ch in channels for k, m in plans[ch["slug"]].items() if m == "full"]
    if full_scans:
        names = sorted({channel_label(ch) for ch, k in full_scans})
        say(f"\nFirst-time scan of {', '.join(names)}: lists every video on the channel. Free (runs on this PC),\n"
            f"about a minute per 2,000 videos, so a huge channel takes a while.")
    pipeline = unattended  # overnight: list each channel and download it at the same time (see below)
    if not pipeline:
        say("\nChecking channels for new uploads...")
        for ch in channels:
            if not plans[ch["slug"]]:
                say(f"  {channel_label(ch)}: checked less than 6 hours ago, skipping")
            else:
                added = fetch_listing(client, ch, plans[ch["slug"]], confirm)
                ch["full_refresh"] = False
                say(f"  {channel_label(ch)}: {added} new in list")
        save_settings(settings)
    for ch in channels:
        n = recover_batches(client, ch)
        if n:
            ok(f"  {channel_label(ch)}: collected {plural(n, 'transcript')} that finished on Apify while this PC was off or offline")

    # 2. one cost summary, one confirmation
    head("Plan")
    tag_model = settings["tag_model"]
    if pipeline:
        # overnight: listing isn't done yet (it runs alongside downloading), so the real totals
        # aren't known here. Spend is capped by the run budget instead of an up-front confirmation.
        say("Overnight: listing each channel and downloading its transcripts at the same time,\n"
            "so the two overlap. Spend is capped by this run's budget.")
        say(f"Budget for this run: Apify {money(BUDGET['apify'])}, Claude {money(BUDGET['claude'])}" if BUDGET else "")
        total_tr, total_untagged, any_work = 0, 0, True
    else:
        total_tr, total_untagged, total_tag_usd, any_work = 0, 0, 0.0, False
        plan_rows = []
        for ch in channels:
            todo = pending_transcripts(ch)
            untagged = [v for v in load_videos(ch) if needs_tag(ch, v["videoId"], settings.get("retag_old"))]
            words = sum(video_words(v) for v in untagged)
            words += sum((v.get("durationSeconds") or 1200) / 60 * 150 for v in todo)
            p = PRICES.get(tag_model, (1.0, 5.0))
            tag_usd = words * 1.4 / 1e6 * p[0] + (len(untagged) + len(todo)) * 600 / 1e6 * p[1]
            total_tr += len(todo)
            total_untagged += len(untagged)
            total_tag_usd += tag_usd
            lives = sum(1 for v in todo if v.get("type") == "live")
            lives_note = " (incl. " + plural(lives, "live") + ")" if lives else ""
            flt = f" ({ch['min_minutes']}+ min only)" if ch.get("min_minutes") else ""
            plan_rows.append(f"  {channel_label(ch)}: {plural(len(todo), 'transcript')} to download{flt}"
                             f"{lives_note}, {len(untagged) + len(todo)} to tag")
            any_work = any_work or bool(todo or untagged)
        for r in plan_rows:
            say(r)
        est_tr = total_tr * EST_TRANSCRIPT
        tag_mode = settings.get("tag_mode", "auto")
        est_batch = (any_work and tag_mode != "live" and
                     (tag_mode == "batch" or settings.get("retag_old") or
                      total_tr + total_untagged >= BATCH_TAG_THRESHOLD))
        claude_est = total_tag_usd * 0.5 if est_batch else total_tag_usd
        batch_note = " (batch rate, about half price)" if est_batch else ""
        say(f"\nEstimated cost: Apify {money(est_tr)}, Claude {money(claude_est)}{batch_note}")
        if any_work:
            say(time_estimate(settings, channels))
        if bal and est_tr > bal["left"]:
            warn(f"Heads up: that's more than your Apify balance ({money(bal['left'])} left). "
                 f"Apify stops runs when the balance runs out. Progress is saved, so you can continue next month or after topping up.")
    # 3. set up Claude (and collect any tag batch left unfinished by an earlier/interrupted run)
    anth = anthropic_client()
    if anth is None:
        warn("No ANTHROPIC_API_KEY in .env: transcripts will download but tagging and Q&A are off.")
    else:
        rec_n = recover_tag_batches(anth, tag_model, channels)
        if rec_n:
            ok(f"  Collected {plural(rec_n, 'tag')} from a batch that finished while the PC was off or offline.")

    model_name = SEARCH_MODELS.get(settings["search_model"], SEARCH_MODELS["english"])

    live = {"tagger": None}

    def tag_status():
        t = live["tagger"]
        return t.status() if t and any(not f.done() for f in t.futs) else None

    def build_and_index(mapping, label):
        head(label)
        counts = build_all(channels, mapping)
        for ch, n, c in counts:
            say(f"  {channel_label(ch)}: {plural(n, 'transcript')}, {c:,} search chunks")
        for ch in channels:
            try:
                sf = (lambda: tag_status() or "tagging done") if live["tagger"] and live["tagger"].futs else None
                n = kw_index_channel(ch, sf) if ch.get("search") == "keyword" else index_channel(ch, model_name, sf)
                if n:
                    say(f"  {channel_label(ch)}: {n:,} new chunks added to search")
            except Exception as e:
                err(f"  {channel_label(ch)}: search indexing failed ({str(e)[:150]})")

    mapping = read_obj(TOPIC_MAP_PATH)
    if any_work and not confirm("Go ahead?"):
        say("Nothing downloaded. Rebuilding files from what you already have.")
        any_work = False

    def tag_backlog():
        return [(ch, v) for ch in channels for v in load_videos(ch)
                if needs_tag(ch, v["videoId"], settings.get("retag_old"))]

    def _untagged_estimate():
        n = 0
        for ch in channels:
            rd, td = cpaths(ch)["raw"], cpaths(ch)["tags"]
            if not rd.exists():
                continue
            have = {f.stem for f in td.glob("*.json")} if td.exists() else set()
            n += sum(1 for f in rd.glob("*.json") if f.stem not in have)
        return n

    # 4. start tagging in the background: a live belt, or the half-price batch service, picked by mode
    #    (batch is preferred for big jobs and overnight). Either way it runs while downloads continue.
    mode = settings.get("tag_mode", "auto")
    use_batch = (any_work and anth is not None and
                 (mode == "batch" or (mode != "live" and
                  (pipeline or settings.get("retag_old") or total_tr + _untagged_estimate() >= BATCH_TAG_THRESHOLD))))

    tagger = pump = None
    if any_work and anth is not None and not use_batch:
        tagger = Tagger(anth, tag_model, int(settings.get("tag_workers") or TAG_WORKERS),
                        retag_old=bool(settings.get("retag_old")))
        live["tagger"] = tagger
        for ch in channels:  # anything already downloaded but not tagged goes on the belt first
            for v in load_videos(ch):
                tagger.submit(ch, v)
        if tagger.submitted:
            head("Tagging with Claude")
            say(f"  {plural(tagger.submitted, 'video')} queued, tagging in the background "
                f"{int(settings.get('tag_workers') or TAG_WORKERS)} at a time. Progress shows on the lines below.")
    elif use_batch:
        pump = BatchPump(anth, tag_model, channels, retag_old=bool(settings.get("retag_old")))
        pump.submit_pre_existing()  # queue already-downloaded-but-untagged videos (belt-first, in the background)
        head("Batch tagging with Claude (about half price)")
        say("  Videos go to Claude's batch service in rolling chunks as they download, so tagging runs in\n"
            "  the background while the rest keeps downloading. Cheaper, and usually done within the hour.\n"
            "  Keep this window open so it can collect the results.")

    # 5. download the pending transcripts, feeding each to the tagging belt as it lands.
    #    Interactive: the list is known up front. Overnight (pipeline): channels are listed in a
    #    background thread and streamed to the downloader so listing and downloading overlap.
    if any_work and total_tr:
        belt = tagger or pump
        head("Downloading transcripts" + (" and tagging as they land" if belt else ""))
        quota = transcript_quota(channels)
        jobs = []
        for ch in channels:
            todo = pending_transcripts(ch)
            if quota is not None:
                if len(todo) > quota[ch["slug"]]:
                    warn(f"  {channel_label(ch)}: {len(todo) - quota[ch['slug']]} left for next time (budget)")
                todo = todo[: quota[ch["slug"]]]
            if todo:
                jobs.append((ch, todo))
        if jobs:
            # embed semantic channels in the background as transcripts land, so the heavy indexing
            # is mostly done by the time downloads finish (the CPU is otherwise idle during the wait)
            ib = IndexBelt(channels, mapping, model_name) if any(
                ch.get("search") != "keyword" for ch, _ in jobs) else None

            def on_saved(ch, ids):
                if belt:
                    belt.submit_ids(ch, ids)
                if ib:
                    ib.mark(ch, ids)

            saved = download_many(client, jobs, on_saved=on_saved,
                                  status_fn=belt.status if belt else None)
            if ib:
                ib.finish()
            for ch, _ in jobs:
                ok(f"  {channel_label(ch)}: {saved.get(ch['slug'], 0)} saved")

    elif pipeline:
        # overnight: list each channel in the background and feed its transcripts to the downloader
        # as soon as it's ready, so listing (minutes on a big channel) overlaps downloading (hours)
        belt = tagger or pump
        head("Downloading transcripts" + (" and tagging as they land" if belt else ""))
        feed = Queue()
        ib = IndexBelt(channels, mapping, model_name) if any(
            ch.get("search") != "keyword" for ch in channels) else None

        def on_saved(ch, ids):
            if belt:
                belt.submit_ids(ch, ids)
            if ib:
                ib.mark(ch, ids)

        def run_listing():
            _STATUS_QUIET.on = True  # the download line owns the screen; keep listing bars off it
            for ch in channels:
                try:
                    if plans[ch["slug"]]:
                        fetch_listing(client, ch, plans[ch["slug"]], confirm)
                        ch["full_refresh"] = False
                    feed.put((ch, pending_transcripts(ch)))
                except Exception as e:
                    err(f"\n  {channel_label(ch)}: listing failed ({str(e)[:100]})")
                    feed.put((ch, []))
            save_settings(settings)
            feed.put(None)

        lister = Thread(target=run_listing, daemon=True)
        lister.start()
        saved = download_many(client, [], on_saved=on_saved,
                              status_fn=belt.status if belt else None, feed=feed)
        lister.join(timeout=120)
        if ib:
            ib.finish()
        for ch in channels:
            if saved.get(ch["slug"], 0):
                ok(f"  {channel_label(ch)}: {saved.get(ch['slug'], 0)} saved")

    # 6. build files + search now so questions work immediately, then (below) wait for tagging to
    #    finish and rebuild once more so the final summaries and topics are in place.
    build_and_index(mapping, "Files and search index")

    def finish_retag():
        if settings.get("retag_old") and not any(0 < tag_version(ch, v["videoId"]) < TAG_VERSION
                                                 for ch in channels for v in load_videos(ch)):
            settings["retag_old"] = False
            save_settings(settings)
            ok("All videos are now tagged with the latest method.")

    if use_batch:
        if pump.seen:
            head("Finishing batch tagging")
            say("  Collecting the tag batches that processed in the background during download...")
        done, failed, busd = pump.collect()  # drains the worker (final partial batch) then collects all
        ooc = pump.out_of_credit
        leftover = tag_backlog() if not ooc else []  # stragglers (load failures etc.): one final batch
        if leftover:
            if not pump.seen:
                head("Batch tagging with Claude (about half price)")
            d2, f2, b2, ooc2 = tag_batch(anth, tag_model, leftover, channels)
            done += d2
            failed += f2
            busd += b2
            ooc = ooc or ooc2
        if pump.seen or leftover:
            ok(f"  Batch tagged {plural(done, 'video')}"
               + (f", {failed} failed (retried next update)" if failed else "") + f" · {money(busd)}")
            if ooc:
                warn("  Claude credit ran out during batch tagging. The rest gets tagged next update.")
            finish_retag()
            mapping = cleanup_topics(anth, tag_model, channels)
            build_and_index(mapping, "Adding summaries and topics")
    elif tagger and tagger.futs:
        if any(not f.done() for f in tagger.futs):
            ok("Search is ready. You can open ask.bat in a second window while tagging finishes.")
        head("Finishing tagging")
        tagger.wait()
        finish_retag()
        mapping = cleanup_topics(anth, tag_model, channels)
        build_and_index(mapping, "Adding summaries and topics")
    elif not any_work:
        ok("Everything is already downloaded and tagged.")

    try:
        import webapp
        webapp.build()
    except Exception as e:
        warn(f"  (couldn't refresh the app view: {str(e)[:100]})")

    fails = sum(1 for ch in channels for f in load_failed(ch).values() if f.get("attempts", 0) >= MAX_FAIL_ATTEMPTS)
    left = sum(len(pending_transcripts(ch)) for ch in channels)
    run_summary(channels, before, run_start, run_iso, left, fails)


def run_summary(channels, before, run_start, run_iso, left, fails):
    after = {k: v for k, v in read_obj(STATS_PATH).get("channels", {}).items() if isinstance(v, dict)}
    before = {k: v for k, v in (before or {}).items() if isinstance(v, dict)}
    head("Summary")
    rows = []
    for ch in channels:
        a, b = after.get(ch["slug"], {}), before.get(ch["slug"], {})
        dv = a.get("videos", 0) - b.get("videos", 0) if b else 0
        dh = a.get("seconds", 0) - b.get("seconds", 0) if b else 0
        rows.append(f"  {channel_label(ch)[:26]:<26} {a.get('videos', 0):>6,} videos  {fmt_hours(a.get('seconds', 0)):>8}"
                    + (f"  {G}+{dv:,} new (+{fmt_hours(dh)}){X}" if dv > 0 else ""))
    for r in rows:
        say(r)
    tot_a = sum(x.get("seconds", 0) for x in after.values())
    say(f"  {B}{'Total':<26} {sum(x.get('videos', 0) for x in after.values()):>6,} videos  {fmt_hours(tot_a):>8}{X}")
    sa, sc = spent_since(run_iso, "apify"), spent_since(run_iso, "claude")
    say(f"\n  Spent this run   Apify {money(sa)} · Claude {money(sc)}")
    say(f"  Time             {fmt_duration(time.time() - run_start)}")
    if fails:
        say(f"  {D}Skipped for good: {plural(fails, 'video')} with no captions on YouTube{X}")
    if left:
        say(f"  {Y}Still to download: {plural(left, 'transcript')}. Run Update again later "
            f"(e.g. after your Apify credit resets).{X}")
    ok("\nDone. Ask a question (3) or open the archive in your browser (4).")


def unindexed_chunks(ch):
    p = cpaths(ch)
    try:
        with open(p["data"] / "chunks.jsonl", encoding="utf-8") as f:
            total = sum(1 for _ in f)
    except OSError:
        total = 0
    return max(0, total - int((read_obj(p["search"] / "meta.json")).get("count") or 0))


def time_estimate(settings, channels):
    measured = bool(read_json(PERF_PATH, {}))
    slots = max(1, int(get_perf("parallel_dl", PARALLEL_BATCHES) or PARALLEL_BATCHES))
    workers = max(1, int(settings.get("tag_workers") or TAG_WORKERS))
    todo = [v for ch in channels for v in pending_transcripts(ch)]
    n_tag = sum(1 for ch in channels for v in load_videos(ch) if needs_tag(ch, v["videoId"], settings.get("retag_old")))
    n_tag += len(todo)
    sem = [ch for ch in channels if ch.get("search") != "keyword"]
    new_chunks = sum((v.get("durationSeconds") or 1200) / 60 for ch in sem for v in pending_transcripts(ch)) \
        + sum(unindexed_chunks(ch) for ch in sem)
    dl = len(todo) * get_perf("dl_sec_per_video_slot", 5.0) / slots
    ix = new_chunks / get_perf("index_chunks_per_sec", 20.0)
    tag_mode = settings.get("tag_mode", "auto")
    est_batch = bool(n_tag) and tag_mode != "live" and (
        tag_mode == "batch" or settings.get("retag_old") or n_tag >= BATCH_TAG_THRESHOLD)
    m = lambda x: f"{x / 60:.0f} min" if x >= 60 else "<1 min"  # noqa: E731
    parts = []
    if dl:
        parts.append(f"downloads {m(dl)}")
    if est_batch:
        tail = 900 if n_tag else 0  # batches ride along with downloads; only a short collection tail remains
        total = dl + tail + ix
        if n_tag:
            parts.append("tagging batched in the background")
    else:
        tg = n_tag * get_perf("tag_sec_per_video", 6.0) / workers
        total = max(dl, tg) + ix
        if tg:
            parts.append(f"tagging {m(tg)}" + (" (alongside downloads)" if dl else ""))
    if ix > 30:
        parts.append(f"search index {m(ix)}")
    basis = "measured on your PC" if measured else "rough until the first run is measured"
    return f"Estimated time: about {m(total)} ({', '.join(parts)}; {basis})"


def transcript_quota(channels):
    """Overnight mode: share what the Apify budget allows across channels, newest videos first."""
    left = budget_left("apify")
    if left is None:
        return None
    allowed = int(left / EST_TRANSCRIPT)
    want = {ch["slug"]: len(pending_transcripts(ch)) for ch in channels}
    quota = {k: 0 for k in want}
    while allowed > 0 and any(quota[k] < want[k] for k in want):
        for k in want:
            if allowed > 0 and quota[k] < want[k]:
                quota[k] += 1
                allowed -= 1
    return quota


def ask_money(prompt, default):
    while True:
        a = input(f"{prompt} in USD (Enter = {money(default)}): ").strip().replace("$", "")
        if not a:
            return default
        try:
            return max(float(a), 0.0)
        except ValueError:
            pass


def update_overnight(settings):
    global BUDGET
    head("Overnight update")
    a, c, bal = balance_line()
    say(a)
    say(c)
    say("\nSet spending limits now. After that it never asks anything: it checks every channel, downloads and tags\n"
        "until it's done or a limit is hit, then rebuilds everything. Your PC is kept awake while it runs\n"
        "(the screen can still turn off). Keep it plugged in.")
    default_apify = round(min(bal["left"], 5.0), 2) if bal else 5.0
    if bal and bal["left"] < 0.05:
        warn("Your Apify credit is used up for this cycle, so no new transcripts. Tagging and rebuilding still run.")
    apify_cap = ask_money("Max Apify spend", default_apify)
    claude_cap = ask_money("Max Claude spend", 2.0)
    if not yes(f"Start? Limits: Apify {money(apify_cap)}, Claude {money(claude_cap)}."):
        return
    BUDGET = {"apify": apify_cap, "claude": claude_cap, "start": datetime.now().isoformat(timespec="seconds")}
    t0 = time.time()
    try:
        update(settings, unattended=True)
    finally:
        spent_a = spent_since(BUDGET["start"], "apify")
        spent_c = spent_since(BUDGET["start"], "claude")
        BUDGET = None
        say(f"\n{B}Overnight run finished{X} in {fmt_duration(time.time() - t0)}. "
            f"Spent: Apify {money(spent_a)}, Claude {money(spent_c)}.")


# ---------------------------------------------------------------- ask

ASK_PROMPT = """You answer questions about these YouTube channels using ONLY the transcript excerpts below: {channels}
The excerpts are auto-generated captions, so wording and names can be garbled; ">>" marks a change of speaker, so be careful about who said what.

Rules:
- Cite the excerpt number in square brackets after every claim, like [3]. Only cite excerpts that actually support the claim.
- If the excerpts don't answer the question, say so plainly. Don't fill gaps from outside knowledge.
- Say who is speaking when it matters (the host or the other person), and flag when it's unclear.
- When an excerpt is in Arabic, quote the key Arabic words briefly before explaining them, so the reader can check the wording.
- {language}
- Plain, direct language. No em dashes.

Question: {question}

Excerpts:
{excerpts}"""

STOP = set("what when where which who whom whose does did have about with from that this they them their there "
           "your into than then also just some more most very been were will would could should said says talk "
           "talked talks video videos channel".split())


def answer_html(q, answer, picked, cited, names):
    """The answer as a web page: Arabic reads right-to-left there, and every [n] links to its moment."""
    def inline(t):
        t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", h(t))
        return re.sub(r"\[(\d+(?:\s*,\s*\d+)*)\]", lambda m: "[" + ", ".join(
            f"<a href='{h(picked[int(n) - 1]['url'])}'>{n}</a>" if 0 < int(n) <= len(picked) else n
            for n in re.findall(r"\d+", m.group(1))) + "]", t)
    body = [f"<h1 dir='auto'>{h(q)}</h1>",
            f"<p class='meta'><span dir='auto'>{h(names)}</span><span>{datetime.now():%d %b %Y, %H:%M}</span></p>"]
    for block in re.split(r"\n\s*\n", answer.strip()):
        lines = [ln for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        bullet = re.compile(r"^\s*([-*]|\d+\.)\s+")
        if all(bullet.match(ln) for ln in lines):
            items = [inline(bullet.sub("", ln)) for ln in lines]
            body.append("<ul>" + "".join(f"<li dir='auto'>{it}</li>" for it in items) + "</ul>")
        elif lines[0].startswith("#"):
            body.append(f"<h2 dir='auto'>{inline(lines[0].lstrip('#').strip())}</h2>")
            if lines[1:]:
                body.append(f"<p dir='auto'>{'<br>'.join(inline(ln) for ln in lines[1:])}</p>")
        else:
            body.append(f"<p dir='auto'>{'<br>'.join(inline(ln) for ln in lines)}</p>")
    body.append("<h2>Sources</h2>")
    for n in cited:
        c = picked[n - 1]
        body.append(f"<div class='seg'><a class='ts' href='{h(c['url'])}'>[{n}] {h(c['timestamp'])}</a>"
                    f"<div><b dir='auto'>{h(c['title'])}</b> <span class='meta'>(<bdi>{h(c.get('channel') or '')}</bdi>, "
                    f"<bdi>{h(nice_date(c.get('date')))}</bdi>)</span><div dir='auto' style='margin-top:4px'>{h(c['text'][:500])}…</div></div></div>")
    page = html_page(q, "".join(body))
    return re.sub(r"<nav>.*?</nav>", "", page, count=1)  # answer pages are standalone; the HTML site was retired


def render_answer(text):
    """Markdown-ish answer -> readable terminal text: bold, bullets, wrapped lines, highlighted [n]."""
    import textwrap
    width = min(term_width() - 4, 100)
    out = []
    for para in text.strip().split("\n"):
        line = para.rstrip()
        if not line.strip():
            out.append("")
            continue
        m = re.match(r"^(\s*)([-*]|\d+\.)\s+(.*)", line)
        heading = re.match(r"^#+\s+(.*)", line)
        if heading:
            out.append(f"{B}{heading.group(1)}{X}")
            continue
        if m:
            bullet = "•" if m.group(2) in "-*" else m.group(2)
            body = textwrap.fill(m.group(3), width=width - 4, initial_indent=f"  {bullet} ",
                                 subsequent_indent="    ")
        else:
            body = textwrap.fill(line, width=width, initial_indent="  ", subsequent_indent="  ")
        body = re.sub(r"\*\*(.+?)\*\*", lambda mm: f"{B}{mm.group(1)}{X}", body)
        body = re.sub(r"\[(\d+(?:,\s*\d+)*)\]", lambda mm: f"{C}[{mm.group(1)}]{X}", body)
        out.append(body)
    return "\n".join(out)


CAND_MAX = 500        # how many top moments to feed the deep-answer map-reduce per question
ANSWER_MAX_DEFAULT = 12000  # answer token ceiling when a mode/caller sets none (comprehensive answers)
CUSTOM_MOMENTS_MAX = 10000  # admin "custom" depth ceiling (soft - the UI shows diminishing returns)
CUSTOM_ANSWER_MAX = 32000   # answer-length ceiling, safely within the answer model's output limit

# Depth presets for the website's mode picker. More candidates = more thorough, but pricier/slower.
# `cand_max` = moments read in; `answer_max` = how long the written answer may get (tokens).
# `usd` is a typical estimate shown in the UI; the real cost comes back with each answer.
MODES = {
    "quick":    {"label": "Quick",    "cand_max": 120,  "per_video": 4, "answer_max": 6000,  "usd": 0.04},
    "standard": {"label": "Standard", "cand_max": 500,  "per_video": 6, "answer_max": 12000, "usd": 0.18, "route": True},
    "deep":     {"label": "Deep",     "cand_max": 1000, "per_video": 8, "answer_max": 16000, "usd": 0.30, "route": True},
}
DEFAULT_MODE = "standard"

# Deep-mode routing: pull the best clips from this many topically-matched videos (by centroid),
# and up to this many clips each, then union them with the direct clip search. ROUTE_MARGIN keeps
# only routed clips within this cosine of the best direct hit, so off-topic routing adds nothing.
ROUTE_VIDEOS = 16
ROUTE_PER_VID = 6
ROUTE_MARGIN = 0.10

MAP_PROMPT = """Question: {q}

Below are numbered transcript excerpts from Islamic lectures and Q&A (auto-generated captions, so wording and names may be garbled; ">>" marks a change of speaker). Each excerpt begins with its number and the channel it is from, like "[12] ChannelName | ...". For EACH excerpt that helps answer the question, write ONE concise line: start with the channel in parentheses, then the relevant point (with a short key quote if useful), ending with its number in brackets, e.g. (ChannelName) ... [12]. Skip excerpts that don't address the question. If none are relevant, reply with exactly: NONE

{batch}"""

REDUCE_PROMPT = """You report what these YouTube channels say, using the findings below: {channels}
Each finding starts with the channel it came from and ends with its excerpt number, like [3]. The captions are auto-generated, so names and Arabic terms can be garbled.

Write a COMPREHENSIVE, well-organised answer - a thorough briefing, not a summary. Your job is to surface everything the findings say about the question; being brief is NOT a goal.
- Organise by channel: give every channel that has something relevant its own heading on its own line, prefixed with "## " (the channel's name). Under that heading, lay out that channel's full position on the question.
- Under each channel, cover EVERY distinct relevant point it makes - the ruling, the reasoning, the conditions, the evidences, the examples, the caveats. Do not stop at one or two points when more are supported, and never drop a supported point just to be concise. When a channel's stance is long, break it into short bold sub-headings or sub-points so it stays clear.
- Quote the speaker's own key words (briefly) wherever a point turns on specific wording, especially Arabic terms.
- Put the excerpt number in square brackets after every claim, like [3] or [3, 7]. When several moments support a point, cite them all. Only cite numbers that actually support the claim.
- Attribute every point to the channel that said it (name the speaker too only when the finding makes it clear; don't invent names). Different channels and speakers may hold different views.
- Do NOT flatten those differences: where they disagree, lay out each position distinctly under its own channel. Do not resolve the disagreement, harmonise them, pick a side, or add a ruling of your own. You are reporting what was said, not giving a fatwa.
- If the findings genuinely don't answer the question, say so plainly. Don't fill gaps from outside knowledge.
- {language}

Question: {question}

Findings:
{findings}"""


VERBATIM_PROMPT = """You are given numbered transcript excerpts from Islamic lectures and Q&A - the speakers' own words (auto-generated captions, so wording and names may be garbled; ">>" marks a change of speaker). Each excerpt begins with its number, its channel, and the video title, like: [3] ChannelName | "Video title ..." (2020-10-17) at 11:42

Answer the question by QUOTING THE SPEAKERS VERBATIM, in their original language, exactly as in the excerpts. Organise the answer by channel:
- Group the quotes by the channel they came from, and lead each group with that channel's name as a heading on its own line, prefixed with "## ".
- Under each channel, list its relevant quotes as bullet points, one quote per bullet, and LEAD EVERY BULLET WITH THE SPEAKER'S NAME followed by a colon, then the quote. Work out who the speaker is from the video title (it usually names the lecturer, e.g. "...الشيخ خالد إسماعيل"), or from the channel name when the channel is itself a person, or from the excerpt's own words. If none of these identify the speaker, lead with a short "speaker not identified" note (in the question's language) instead of a name. Never invent or guess a name beyond what the title, channel, or excerpt supports.
- Keep each quote word for word in its ORIGINAL language - do NOT paraphrase, summarise, or translate the quoted words. Put its excerpt number in brackets right after it, like [3].
- EVERYTHING THAT IS NOT A VERBATIM QUOTE - the speaker names and labels, the lead-in, and any note - must be written in the same language as the question, transliterating an Arabic name into that language where needed. {language} Only the quoted words themselves stay in their original language.
- Different channels and speakers may disagree. Keep their quotes distinct; do not harmonise them, pick a side, or add a ruling of your own. You are reporting what was said, not giving a fatwa. Keep any words of your own to a minimum.
- Quote EVERY excerpt that DIRECTLY addresses the specific question asked - if many of them do, include them all; do not sample, trim the list, or stop early. The goal is comprehensive coverage: if the matter is discussed across many moments, give all of those moments. Leave out only excerpts that are merely about the general topic, however related they seem. Do not describe your search or the excerpts (which ones are closest, how many you found, or what the others are about) - just give the relevant quotes under their channel headings. If none of them directly address the question, say so plainly, in the same language as the question.

Question: {question}

Excerpts:
{quotes}"""


MIDREDUCE_PROMPT = """Question: {q}

Below are many findings distilled from transcript excerpts, each ending with its excerpt number like [3]. Condense them into a smaller, grouped set of points for the question — merge duplicates, but keep every distinct point AND its [n] citation numbers. No preamble.

{findings}"""


def _decompose(anth, model, q):
    """Break a question into a few distinct search angles so retrieval covers it from several sides.
    Returns [original question] + sub-queries (de-duplicated)."""
    try:
        txt, _ = call_claude(anth, model,
                             "Break this question into 3 to 6 distinct search angles that together cover it fully: "
                             "rephrasings, the key sub-topics, and the terms a scholar would actually use (Arabic "
                             "terms too where relevant). One angle per line, no numbering, no extra text.\n\n"
                             "Question: " + q, 400)
        subs = [s.strip(" -*.•\t") for s in txt.splitlines() if s.strip()]
    except Exception:
        subs = []
    out, seen = [q], {q.lower()}
    for s in subs[:6]:
        if len(s) > 2 and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out


def _numbered_excerpts(candidates):
    """The candidate moments as numbered raw excerpts ('[n] channel | "title" (date) at ts\\ntext').
    Used both to feed the map step and to quote verbatim."""
    return [f"[{n}] {c.get('channel') or ''} | \"{c['title']}\" ({c['date']}"
            f"{', live' if c.get('type') == 'live' else ''}) at {c['timestamp']}\n{c['text']}"
            for n, c in enumerate(candidates, 1)]


def _cited_numbers(text, upper):
    """The distinct [n] citation numbers appearing in `text`, in first-seen order, 1..upper."""
    out, seen = [], set()
    for grp in re.findall(r"\[(\d+(?:\s*,\s*\d+)*)\]", text):
        for x in re.findall(r"\d+", grp):
            n = int(x)
            if 0 < n <= upper and n not in seen:
                seen.add(n)
                out.append(n)
    return out


def _reduce_prompt(q, candidates, findings, style, names, lang):
    """Build the answer-model prompt. 'topical' (default) synthesises the findings; 'verbatim' quotes
    the cited excerpts' own words (original language) with only minimal additions in the question's
    language."""
    if style == "verbatim":
        numbered = _numbered_excerpts(candidates)
        cited = _cited_numbers(findings, len(numbered))
        block = "\n\n".join(numbered[n - 1] for n in cited) if cited else "\n\n".join(numbered[:120])
        return VERBATIM_PROMPT.format(question=q, quotes=block, language=lang)
    return REDUCE_PROMPT.format(channels=names, language=lang, question=q, findings=findings)


def _map_findings(anth, settings, q, candidates):
    """The 'map' half of the deep answer: the cheap tag model distills the candidate excerpts into a
    compact findings block in parallel, condensing in a middle layer when there are too many. Returns
    (findings_text, usd)."""
    numbered = _numbered_excerpts(candidates)
    cost = [0.0]
    lock = Lock()

    def cheap(prompt):
        txt, u = call_claude(anth, settings["tag_model"], prompt, 1500)
        with lock:
            cost[0] += u
        return txt

    if len(candidates) <= 40:
        findings = "\n\n".join(numbered)  # small set: let the answer model read the excerpts directly
    else:
        batches = [numbered[i:i + 25] for i in range(0, len(numbered), 25)]
        with ThreadPoolExecutor(max_workers=min(12, len(batches))) as ex:
            mapped = list(ex.map(lambda b: cheap(MAP_PROMPT.format(q=q, batch="\n\n".join(b))), batches))
        lines = [ln for r in mapped if r and r.strip().upper() != "NONE"
                 for ln in r.strip().splitlines() if ln.strip()]
        if len(lines) > 900:  # only for truly massive sets: condense in a middle layer first
            groups = [lines[i:i + 60] for i in range(0, len(lines), 60)]
            with ThreadPoolExecutor(max_workers=min(8, len(groups))) as ex:
                cond = list(ex.map(lambda g: cheap(MIDREDUCE_PROMPT.format(q=q, findings="\n".join(g))), groups))
            lines = [ln for r in cond if r and r.strip() for ln in r.strip().splitlines() if ln.strip()]
        findings = "\n".join(lines) or "NONE"
    return findings, cost[0]


def _deep_answer(anth, settings, q, candidates, lang, names, style=None, answer_max=None):
    """Hierarchical map-reduce: _map_findings distills many excerpts (map), then the answer model
    writes the cited answer (reduce) — topical synthesis, or verbatim quotes. `answer_max` caps the
    written answer's length (tokens). Returns (answer, usd)."""
    findings, cost = _map_findings(anth, settings, q, candidates)
    answer, u = call_claude(anth, settings["answer_model"],
                            _reduce_prompt(q, candidates, findings, style, names, lang),
                            answer_max or ANSWER_MAX_DEFAULT)
    return answer, cost + u


def searchable_channels(settings):
    """Channels with a usable search index for the current search model; warns about any indexed with
    a different model. Cheap readiness check (no heavy loading). Shared by the CLI and the web server."""
    model_name = SEARCH_MODELS.get(settings["search_model"], SEARCH_MODELS["english"])
    ready = []
    for ch in settings["channels"]:
        p = cpaths(ch)
        if ch.get("search") == "keyword":
            if (p["search"] / "keyword.db").exists():
                ready.append(ch)
            continue
        meta = read_obj(p["search"] / "meta.json")
        has = (p["search"] / "embeddings.npy").exists()
        if has and (meta.get("model") or SEARCH_MODELS["english"]) == model_name:
            ready.append(ch)
        elif has:
            warn(f"{channel_label(ch)} was indexed with a different search model. Run Update to re-index it.")
    return ready


def load_search(settings, scope):
    """Load the embedding matrix, chunks and keyword indexes for `scope` once, into a reusable context
    that answers many questions without reloading. Returns the context, or None if nothing is
    searchable right now (e.g. an index is mid-rebuild). The web server calls this once at startup;
    the CLI once per session."""
    import numpy as np
    anth = anthropic_client()
    if anth is None:
        return None
    model_name = SEARCH_MODELS.get(settings["search_model"], SEARCH_MODELS["english"])
    sem_scope = [c for c in scope if c.get("search") != "keyword"]
    kw_scope = [c for c in scope if c.get("search") == "keyword"]
    chunks, mats, row_slugs = [], [], []
    for ch in sem_scope:
        p = cpaths(ch)
        ids = read_list(p["search"] / "ids.json")
        by_id = {c["chunk_id"]: c for c in load_chunks(ch)}
        mat = np.load(p["search"] / "embeddings.npy")
        if len(mat) != len(ids):
            warn(f"{channel_label(ch)}: search is being updated right now, skipping it for this session.")
            continue
        keep = [i for i, cid in enumerate(ids) if cid in by_id]
        # Stamp each chunk with the channel's CURRENT display name, so renaming a channel
        # (settings.json) shows on the website without re-indexing the data.
        name = full_name(ch)
        kept = [by_id[ids[i]] for i in keep]
        for c in kept:
            c["channel"] = name
            c["_slug"] = ch["slug"]  # so the transcript window knows which channel a moment is from
            c["_kw"] = False
        chunks += kept
        mats.append(mat[keep])
        row_slugs += [ch["slug"]] * len(kept)  # which channel each matrix row belongs to
    mat = np.vstack(mats) if mats else None
    # Integer channel id per matrix row, so the website's channel picker can mask fast.
    slug_to_cid = {s: i for i, s in enumerate(dict.fromkeys(row_slugs))}
    row_cid = (np.array([slug_to_cid[s] for s in row_slugs], dtype=np.int32)
               if row_slugs else np.zeros(0, dtype=np.int32))
    # Per-video centroids (the mean of a video's chunk vectors) for deep-mode routing: find the
    # videos whose overall content matches the question, then pull their best clips - unioned with
    # the direct clip search so the serendipitous one-off moments are still kept. Built free from
    # the vectors already in memory, so no re-indexing or re-publishing is needed.
    vid_ids, vid_mat, vid_rows, vid_cid = [], None, {}, np.zeros(0, dtype=np.int32)
    if mat is not None and len(chunks):
        rows_by_vid = {}
        for i, c in enumerate(chunks):
            rows_by_vid.setdefault(c["video_id"], []).append(i)
        vid_ids = list(rows_by_vid.keys())
        vid_mat = np.vstack([mat[rows_by_vid[v]].mean(axis=0) for v in vid_ids])
        vid_mat /= np.linalg.norm(vid_mat, axis=1, keepdims=True) + 1e-9
        vid_cid = np.array([row_cid[rows_by_vid[v][0]] for v in vid_ids], dtype=np.int32)
        vid_rows = {v: np.array(r, dtype=np.int64) for v, r in rows_by_vid.items()}
    lowered = [(c["title"] + " " + c["text"]).lower() for c in chunks]
    embedder = get_embedder(model_name) if mat is not None else None
    kw_count, kw_videos = 0, 0
    for ch in kw_scope:
        try:
            con = kw_db(ch)
            kw_count += con.execute("SELECT count(*) FROM info").fetchone()[0]
            kw_videos += con.execute("SELECT count(DISTINCT video_id) FROM info").fetchone()[0]
            con.close()
        except Exception:
            pass
    if mat is None and not kw_count:
        return None
    lang = {"auto": "Answer in the same language as the question.",
            "english": "Answer in English.", "arabic": "Answer in Arabic."}.get(
                settings["answer_language"], "Answer in the same language as the question.")
    return {"settings": settings, "anth": anth, "scope": scope, "kw_scope": kw_scope,
            "chunks": chunks, "mat": mat, "lowered": lowered, "embedder": embedder,
            "by_id": {c["chunk_id"]: c for c in chunks},  # chunk lookup for transcript windows
            "model_name": model_name, "lang": lang,
            "names": ", ".join(channel_label(c) for c in scope),
            "row_cid": row_cid, "slug_to_cid": slug_to_cid,
            "vid_ids": vid_ids, "vid_mat": vid_mat, "vid_rows": vid_rows, "vid_cid": vid_cid,
            "channels_meta": [{"slug": c["slug"], "name": full_name(c),
                               "kind": "keyword" if c.get("search") == "keyword" else "meaning"}
                              for c in scope],
            "total_moments": len(chunks) + kw_count,
            "total_videos": len({c["video_id"] for c in chunks}) + kw_videos}


def retrieve(ctx, q, channels=None, cand_max=None, per_vid=6, route=False):
    """Find the candidate moments for a question: decompose it into angles, union the semantic and
    keyword retrieval (keeping each chunk's best score), then diversify (<=per_vid per video, up to
    cand_max). `channels` (a list of slugs) limits the search to those channels; None/empty = all.
    Pure data; used by the CLI and the web server."""
    import numpy as np
    cand_max = cand_max or CAND_MAX
    anth, settings = ctx["anth"], ctx["settings"]
    mat, chunks, lowered, embedder = ctx["mat"], ctx["chunks"], ctx["lowered"], ctx["embedder"]
    model_name = ctx["model_name"]
    sel = set(channels) if channels else None  # selected channel slugs, or None for all
    sel_ids = [cid for s, cid in ctx["slug_to_cid"].items() if s in sel] if sel else None
    queries = _decompose(anth, settings["tag_model"], q)  # the question broken into several search angles
    sem_hits, qvs = [], []
    if mat is not None:
        wterms = [w for w in re.findall(r"\w{4,}", q.lower()) if w not in STOP]
        row_mask = np.isin(ctx["row_cid"], sel_ids) if sel_ids is not None else None
        best, best_sim = {}, 0.0
        for sq in queries:
            qv = np.array(list(embedder.query_embed([query_text(model_name, sq)]))[0], dtype=np.float32)
            qv /= np.linalg.norm(qv) + 1e-9
            qvs.append(qv)  # kept for centroid routing below
            scores = mat @ qv
            if row_mask is not None:
                scores = np.where(row_mask, scores, -1e9)  # drop deselected channels
            best_sim = max(best_sim, float(scores.max()))  # the strongest direct hit, for the route floor
            for i in np.argsort(-scores)[:800]:
                if scores[int(i)] <= -1e8:
                    break  # only deselected rows remain
                sc = float(scores[int(i)]) + min(0.12, 0.03 * sum(1 for t in wterms if t in lowered[int(i)]))
                if sc > best.get(int(i), -2.0):
                    best[int(i)] = sc
        sem_hits = [chunks[i] for i, _ in sorted(best.items(), key=lambda kv: -kv[1])]
    kw_hits = []
    kw_scope = [ch for ch in ctx["kw_scope"] if not sel or ch["slug"] in sel]
    if kw_scope:
        terms = keyword_terms(anth, settings["tag_model"], q) + queries
        per = max(40, 160 // len(kw_scope))
        lists = []
        for ch in kw_scope:
            hits = kw_search(ch, terms, per)
            nm = full_name(ch)  # current display name, so a rename shows without re-indexing
            for h in hits:
                h["channel"] = nm
                h["_slug"] = ch["slug"]
                h["_kw"] = True
            lists.append(hits)
        for i in range(max((len(x) for x in lists), default=0)):  # interleave channels
            kw_hits += [x[i] for x in lists if i < len(x)]
    # summary-style routing: find the videos whose overall content best matches the question (by
    # centroid), pull their strongest clips, and union those in - so a video that is *about* the
    # question contributes even when no single moment topped the direct search.
    route_hits = []
    if route and ctx.get("vid_mat") is not None and qvs:
        vbest = None
        for qv in qvs:
            s = ctx["vid_mat"] @ qv
            vbest = s if vbest is None else np.maximum(vbest, s)
        if sel_ids is not None:
            vbest = np.where(np.isin(ctx["vid_cid"], sel_ids), vbest, -1e9)
        floor = best_sim - ROUTE_MARGIN  # only clips nearly as strong as the best direct hit
        for vi in np.argsort(-vbest)[:ROUTE_VIDEOS]:
            vi = int(vi)
            if vbest[vi] <= -1e8:
                break  # only deselected videos remain
            rows = ctx["vid_rows"][ctx["vid_ids"][vi]]
            cs = None
            for qv in qvs:
                s = mat[rows] @ qv
                cs = s if cs is None else np.maximum(cs, s)
            for k in np.argsort(-cs)[:ROUTE_PER_VID]:
                if float(cs[int(k)]) < floor:
                    break  # clips are sorted strongest-first, so the rest are weaker too
                route_hits.append(chunks[int(rows[int(k)])])
    # cast a wide net: many moments across many videos, then synthesise with a deep map-reduce
    streams = [x for x in (sem_hits, kw_hits, route_hits) if x]
    candidates, per_video, seen = [], {}, set()
    idx = [0] * len(streams)
    while len(candidates) < cand_max and any(idx[j] < len(streams[j]) for j in range(len(streams))):
        for j, st in enumerate(streams):
            while idx[j] < len(st):
                c = st[idx[j]]
                idx[j] += 1
                if c["chunk_id"] in seen or per_video.get(c["video_id"], 0) >= per_vid:
                    continue
                seen.add(c["chunk_id"])
                per_video[c["video_id"]] = per_video.get(c["video_id"], 0) + 1
                candidates.append(c)
                break
            if len(candidates) >= cand_max:
                break
    return candidates, queries


def synthesize(ctx, q, candidates, style=None, answer_max=None):
    """Write the cited answer from the candidate moments (the deep map-reduce). `answer_max` caps the
    written answer's length. Returns {answer, usd, cited, coverage}. Raises on a Claude error
    (callers handle credit/billing)."""
    answer, usd = _deep_answer(ctx["anth"], ctx["settings"], q, candidates, ctx["lang"], ctx["names"], style, answer_max)
    cited = sorted({int(n) for grp in re.findall(r"\[(\d+(?:\s*,\s*\d+)*)\]", answer)
                    for n in re.findall(r"\d+", grp) if 0 < int(n) <= len(candidates)})
    cov_c = len({candidates[n - 1].get("channel") for n in cited}) or len(ctx["scope"])
    return {"answer": answer, "usd": usd, "cited": cited,
            "coverage": {"moments": len(candidates),
                         "videos": len({c["video_id"] for c in candidates}), "channels": cov_c}}


def _apply_channel_names(ctx, q, candidates, channel_names):
    """Return the candidates with their display 'channel' replaced by an admin name override, in the
    question's language. channel_names is {slug: {"en":.., "ar":..}} sent by the web (from Firestore);
    the terminal-set names stay the fallback. Candidates are COPIED so the shared in-memory chunks are
    never mutated (the override is per-request). Applying it here lets the override flow through the
    excerpt headers, the findings, the verbatim grouping and the source cards with no further plumbing."""
    if not channel_names:
        return candidates
    ar = bool(re.search(r"[؀-ۿ]", q))  # the answer follows the question's language
    override = {}
    for ch in ctx["scope"]:
        o = channel_names.get(ch["slug"])
        if not o:
            continue
        name = (o.get("ar") if ar else o.get("en")) or o.get("en") or o.get("ar")
        if name and name != full_name(ch):
            override[full_name(ch)] = name
    if not override:
        return candidates
    return [{**c, "channel": override.get(c.get("channel"), c.get("channel"))} for c in candidates]


def answer_question(ctx, q, channels=None, mode=None, style=None, channel_names=None,
                    cand_max=None, answer_max=None):
    """Retrieve + synthesize in one call: the whole deluxe answer as plain data (empty=True if nothing
    matched). `channels` (slugs) limits the search; `mode` (quick/standard/deep) sets the depth;
    `style` (topical/verbatim) sets how the answer is written; `channel_names` (slug -> {en, ar}) is the
    admin name override. `cand_max`/`answer_max` override the mode's moment and answer-length budgets
    (the admin 'custom' depth), clamped. No printing or file I/O - callers format and persist it."""
    m = MODES.get(mode or DEFAULT_MODE, MODES[DEFAULT_MODE])
    cmax = max(1, min(int(cand_max), CUSTOM_MOMENTS_MAX)) if cand_max else m["cand_max"]
    amax = max(1000, min(int(answer_max), CUSTOM_ANSWER_MAX)) if answer_max else m.get("answer_max")
    candidates, queries = retrieve(ctx, q, channels=channels, cand_max=cmax,
                                   per_vid=m["per_video"], route=m.get("route", False))
    if not candidates:
        return {"q": q, "empty": True, "answer": None, "candidates": [], "cited": [], "queries": queries,
                "coverage": {"moments": 0, "videos": 0, "channels": 0}, "usd": 0.0}
    candidates = _apply_channel_names(ctx, q, candidates, channel_names)
    res = synthesize(ctx, q, candidates, style, amax)
    return {"q": q, "empty": False, "candidates": candidates, "queries": queries, **res}


def answer_question_stream(ctx, q, channels=None, mode=None, style=None, channel_names=None,
                           cand_max=None, answer_max=None):
    """Streaming deluxe answer: a generator of (kind, payload) events for the website's live answer.
    Yields ('status', stage) as it searches then reads, many ('delta', text) as the answer writes,
    then one ('done', {...}) with the final answer, candidates and cited numbers - or ('empty', None)
    when nothing matched. `style` (topical/verbatim) sets how the answer is written; `channel_names`
    (slug -> {en, ar}) applies the admin name override; `cand_max`/`answer_max` override the mode's
    moment and answer-length budgets (the admin 'custom' depth), clamped. Same retrieval and
    map-reduce as answer_question; only the final write streams."""
    m = MODES.get(mode or DEFAULT_MODE, MODES[DEFAULT_MODE])
    cmax = max(1, min(int(cand_max), CUSTOM_MOMENTS_MAX)) if cand_max else m["cand_max"]
    amax = max(1000, min(int(answer_max), CUSTOM_ANSWER_MAX)) if answer_max else m.get("answer_max")
    yield ("status", "searching")
    candidates, _ = retrieve(ctx, q, channels=channels, cand_max=cmax,
                             per_vid=m["per_video"], route=m.get("route", False))
    if not candidates:
        yield ("empty", None)
        return
    candidates = _apply_channel_names(ctx, q, candidates, channel_names)
    yield ("status", "reading")
    findings, map_cost = _map_findings(ctx["anth"], ctx["settings"], q, candidates)
    yield ("status", "writing")
    prompt = _reduce_prompt(q, candidates, findings, style, ctx["names"], ctx["lang"])
    answer, reduce_cost, emitted = "", 0.0, set()
    cite_re = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")

    def new_sources(text):
        # emit each cited moment's source card, in first-citation order. Resolving a source reads the
        # transcript window (sometimes from SQLite), so we do this AFTER the answer has finished
        # streaming - doing it inline stalled the token stream each time a citation closed.
        for grp in cite_re.findall(text):
            for x in re.findall(r"\d+", grp):
                n = int(x)
                if 0 < n <= len(candidates) and n not in emitted:
                    emitted.add(n)
                    yield ("source", source_json(ctx, candidates[n - 1], n))

    for kind, payload in call_claude_stream(ctx["anth"], ctx["settings"]["answer_model"], prompt,
                                            amax or ANSWER_MAX_DEFAULT):
        if kind == "delta":
            yield ("delta", payload)
            answer += payload
        else:  # ('done', (full_text, usd))
            answer, reduce_cost = payload
    yield from new_sources(answer)  # sources stream in after the full answer (keeps the text smooth)
    cov_c = len({candidates[n - 1].get("channel") for n in sorted(emitted)}) or len(ctx["scope"])
    yield ("done", {"usd": map_cost + reduce_cost,
                    "coverage": {"moments": len(candidates),
                                 "videos": len({c["video_id"] for c in candidates}), "channels": cov_c}})


def transcript_context(ctx, chunk, before=4, after=4):
    """A window of consecutive transcript segments around `chunk`, for the website's source
    preview (3 lines, centre emphasised) and the expand-to-scroll view. Returns (lines, cited_idx)
    where lines is [{"ts": str, "text": str}] in time order and cited_idx marks the cited segment.
    Semantic moments are already in memory; keyword-channel moments are read from the FTS db."""
    vid, cid = chunk.get("video_id"), chunk.get("chunk_id")
    one = [{"ts": chunk.get("timestamp"), "text": chunk.get("text", "")}]  # safe fallback: cited line only
    if not vid:
        return one, 0
    if chunk.get("_kw"):
        ch = next((c for c in ctx["scope"] if c.get("slug") == chunk.get("_slug")), None)
        if ch is None:
            return one, 0
        con = None
        try:
            con = kw_db(ch)
            rows = con.execute("SELECT chunk_id, ts, text FROM info WHERE video_id=? ORDER BY chunk_id",
                               (vid,)).fetchall()
        except Exception:
            rows = []
        finally:
            if con is not None:
                con.close()
        if not rows:
            return one, 0
        pos = next((i for i, r in enumerate(rows) if r[0] == cid),
                   next((i for i, r in enumerate(rows) if r[1] == chunk.get("timestamp")), 0))
        lo, hi = max(0, pos - before), min(len(rows), pos + after + 1)
        return [{"ts": r[1], "text": r[2]} for r in rows[lo:hi]], pos - lo
    # semantic channel: neighbours share the video with adjacent chunk indices (chunk_id = vid_NNNN)
    n = chunk.get("n")
    if n is None:
        return one, 0
    by_id, lines, cited_idx = ctx.get("by_id", {}), [], 0
    for i in range(n - before, n + after + 1):
        c = by_id.get(f"{vid}_{i:04d}")
        if c is None:
            continue
        if i == n:
            cited_idx = len(lines)
        lines.append({"ts": c.get("timestamp"), "text": c.get("text", "")})
    return (lines, cited_idx) if lines else (one, 0)


def source_json(ctx, chunk, n):
    """One cited moment as plain JSON for the website's source card: its metadata plus a short
    window of surrounding transcript (`context` + `citedIdx`). Shared by /ask and the stream.
    `video_id` + `slug` let the site fetch the video's full transcript on demand (download button)."""
    lines, ci = transcript_context(ctx, chunk)
    return {"n": n, "timestamp": chunk["timestamp"], "title": chunk["title"],
            "channel": chunk.get("channel"), "date": chunk.get("date"), "url": chunk["url"],
            "video_id": chunk.get("video_id"), "slug": chunk.get("_slug"),
            "context": lines, "citedIdx": ci}


def full_transcript(ctx, video_id, slug=None):
    """Every transcript segment of one source video, in time order, as [{ts, text}] - for the
    website's per-source transcript download. Keyword channels are read from their FTS db; semantic
    moments are already in memory. Returns [] if the video isn't in the loaded scope."""
    if not video_id:
        return []
    if slug:  # keyword channel: read the whole video straight from its FTS db
        ch = next((c for c in ctx["scope"]
                   if c.get("slug") == slug and c.get("search") == "keyword"), None)
        if ch is not None:
            con = None
            try:
                con = kw_db(ch)
                rows = con.execute("SELECT ts, text FROM info WHERE video_id=? ORDER BY chunk_id",
                                   (video_id,)).fetchall()
            except Exception:
                rows = []
            finally:
                if con is not None:
                    con.close()
            if rows:
                return [{"ts": r[0], "text": r[1]} for r in rows]
            # nothing in the keyword db: fall through to the in-memory scan as a safety net
    # semantic channel: the video's chunks share its id with adjacent indices (chunk_id = vid_NNNN)
    items = [c for c in ctx.get("by_id", {}).values() if c.get("video_id") == video_id]
    items.sort(key=lambda c: c.get("n", 0))
    return [{"ts": c.get("timestamp"), "text": c.get("text", "")} for c in items]


def ask(settings):
    if anthropic_client() is None:
        err("ANTHROPIC_API_KEY is missing in .env.")
        return
    ready = searchable_channels(settings)
    if not ready:
        err("Nothing is searchable yet. Run Update first.")
        return
    scope = ready
    if len(ready) > 1:
        say("\nSearch which channel?")
        k = choose("Number, or just Enter for all", [(i + 1, channel_label(c)) for i, c in enumerate(ready)],
                   allow_blank=True)
        if k:
            scope = [ready[int(k) - 1]]
    status(f"    Loading search for {', '.join(channel_label(c) for c in scope)}…")
    ctx = load_search(settings, scope)
    status_done()
    if ctx is None:
        err("Search is being updated right now. Try again in a minute.")
        return
    names = ctx["names"]
    ANSWERS.mkdir(parents=True, exist_ok=True)
    say(f"\nSearching {ctx['total_moments']:,} moments ({names}).")
    say(f"{D}Tip: ask specific things, in English or Arabic. Empty line to stop.{X}")
    last_page = None
    while True:
        try:
            q = input(f"\n{B}Question:{X} ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not q:
            break
        if q.lower() in ("o", "open") and last_page:
            open_path(last_page)
            continue
        candidates, _ = retrieve(ctx, q)
        if not candidates:
            say(f"{Y}Nothing matched. Try other words, or ask in Arabic.{X}")
            continue
        cv = len({c["video_id"] for c in candidates})
        say(f"{D}Reading {len(candidates)} moments across {cv} videos, then writing...{X}")
        try:
            res = synthesize(ctx, q, candidates)
        except Exception as e:
            if "credit balance" in str(e).lower() or "billing" in str(e).lower():
                err("Claude credit is used up. Add credit at console.anthropic.com/settings/billing, then ask again.")
                break
            err(f"Claude error: {e}")
            continue
        answer, usd, cited, cov_c = res["answer"], res["usd"], res["cited"], res["coverage"]["channels"]
        add_spend("claude", usd, "question")
        say("")
        say(render_answer(answer))
        say(f"\n{D}Drew on {len(candidates)} moments across {cv} videos; cited {len(cited)} "
            f"from {cov_c} channel{'s' if cov_c != 1 else ''}.{X}")
        say(f"\n{C}Sources{X} {D}(Ctrl+click a link to open the video at that moment){X}")
        multi = len({c.get("channel") for c in candidates}) > 1
        short = {full_name(c): channel_label(c) for c in scope}
        for n in cited:
            c = candidates[n - 1]
            who = f"{short.get(c.get('channel'), c.get('channel'))} · " if multi and c.get("channel") else ""
            say(f"  {C}[{n}]{X} {B}{c['timestamp']:>8}{X}  {c['title'][:70]} {D}({who}{c['date']}){X}")
            say(f"             {D}{c['url']}{X}")
        if not cited:
            say("  (none cited)")
        stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
        src = "\n".join(f"- [{n}] [{candidates[n - 1]['title']} at {candidates[n - 1]['timestamp']}]({candidates[n - 1]['url']})"
                        f" ({candidates[n - 1].get('channel') or ''}, {candidates[n - 1]['date']})" for n in cited)
        base = ANSWERS / f"{stamp}_{safe_name(q, 50)}"
        base.with_suffix(".md").write_text(f"# {q}\n\n{answer}\n\n## Sources\n\n{src}\n", encoding="utf-8")
        last_page = base.with_suffix(".html")
        last_page.write_text(answer_html(q, answer, candidates, cited, names), encoding="utf-8")
        arabic = bool(re.search(r"[\u0600-\u06FF]", answer + "".join(candidates[n - 1]["title"] for n in cited)))
        say(f"{D}  cost {money(usd)} · saved in output\\answers{X}")
        say(f"  {Y}Type o{X} to read it in your browser" + (" (Arabic shows properly there)" if arabic else "") + ".")


# ---------------------------------------------------------------- duplicate / excerpt detection

def _video_shingles(v, k=12):
    """Hashes of k-word runs of a video's (normalised) transcript. Arabic is folded like the search,
    so caption spelling noise doesn't block matches."""
    words = norm_text(" ".join(s["text"] for s in v.get("segments") or [])).split()
    if len(words) < k:
        return set()
    return {hash(" ".join(words[i:i + k])) for i in range(len(words) - k + 1)}


def find_duplicates(channels, k=12, contain=0.80, min_shared=10, min_distinct=15, progress=None):
    """Find near-verbatim duplicate / excerpt videos. Conservative and quote-aware: runs of words that
    appear across many videos (shared Quran / hadith and stock phrases) are ignored, so a video is only
    flagged when its distinctive wording is largely contained in another. Returns a list of groups."""
    import collections
    items, df = [], collections.Counter()
    for ch in channels:
        for v in load_videos(ch):
            sh = _video_shingles(v, k)
            if progress:
                progress()
            if not sh:
                continue
            items.append({"slug": ch["slug"], "channel": full_name(ch), "vid": v["videoId"],
                          "title": v.get("title") or "", "words": video_words(v),
                          "dur": v.get("durationSeconds") or 0, "date": v.get("date") or "", "sh": sh})
            for s in sh:
                df[s] += 1
    n = len(items)
    if n < 2:
        return []
    maxdf = max(4, round(0.005 * n))      # ignore runs seen in more than ~0.5% of videos (shared quotes)
    for it in items:
        it["dist"] = {s for s in it["sh"] if df[s] <= maxdf}
        it["sh"] = None
    inv = collections.defaultdict(list)
    for idx, it in enumerate(items):
        if len(it["dist"]) >= min_distinct:
            for s in it["dist"]:
                inv[s].append(idx)
    overlap = collections.Counter()
    for lst in inv.values():
        if 2 <= len(lst) <= maxdf + 2:
            for a in range(len(lst)):
                for b in range(a + 1, len(lst)):
                    overlap[(lst[a], lst[b])] += 1
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    flagged = {}
    for (ia, ib), ov in overlap.items():
        if ov < min_shared:
            continue
        small = ia if len(items[ia]["dist"]) <= len(items[ib]["dist"]) else ib
        c = ov / max(1, len(items[small]["dist"]))
        if c >= contain:
            ra, rb = find(ia), find(ib)
            if ra != rb:
                parent[ra] = rb
            flagged[(ia, ib)] = c
    members = collections.defaultdict(set)
    for ia, ib in flagged:
        members[find(ia)].add(ia)
        members[find(ib)].add(ib)
    groups = []
    for idxs in members.values():
        g = sorted((items[i] for i in idxs), key=lambda x: (x["words"], x["dur"]), reverse=True)
        groups.append({"primary": g[0], "members": g[1:]})
    groups.sort(key=lambda gr: len(gr["members"]), reverse=True)
    return groups


NESTS_PATH = OUTPUT / "nests.json"


def apply_nests(groups):
    children, parent = {}, {}
    for g in groups:
        pv = g["primary"]["vid"]
        kids = [m["vid"] for m in g["members"]]
        if kids:
            children[pv] = kids
            for kv in kids:
                parent[kv] = pv
    write_json(NESTS_PATH, {"children": children, "parent": parent})
    return sum(len(v) for v in children.values())


def _write_dup_report(groups):
    flagged = sum(len(g["members"]) for g in groups)
    lines = ["# Duplicate / excerpt review", "",
             f"{flagged} videos look like clips or excerpts of {len(groups)} longer videos. The longest in each "
             "group stays in the list; the clips nest under it (the files are kept).", ""]
    for i, g in enumerate(groups, 1):
        p = g["primary"]
        lines.append(f"## Group {i} - {p['channel']}")
        lines.append(f"- KEEP: **{p['title']}** ({p['dur'] // 60} min, {p['words']:,} words) {link(p['vid'])}")
        for m in g["members"]:
            lines.append(f"- clip: {m['title']} ({m['dur'] // 60} min, {m['words']:,} words) {link(m['vid'])}")
        lines.append("")
    (OUTPUT / "duplicates_report.md").write_text("\n".join(lines), encoding="utf-8")


def _refresh_app():
    try:
        import webapp
        webapp.build()
        ok("Archive app updated.")
    except Exception as e:
        err(f"Couldn't rebuild the app: {str(e)[:120]}")


def duplicates_menu(settings):
    head("Duplicate / excerpt videos")
    nests = read_obj(NESTS_PATH)
    cur = sum(len(v) for v in (nests.get("children") or {}).values())
    if cur:
        say(f"{cur} videos are currently nested under their main video.")
    say("This scans every transcript for near-verbatim clips or excerpts of a longer video. It ignores\n"
        "shared Quran, hadith and stock phrases, so two different videos on the same topic are not flagged.\n"
        "It runs on your PC and costs nothing.")
    opts = [(1, "Scan for duplicate / excerpt videos")]
    if cur:
        opts.append((2, "Remove all nesting (show every video on its own again)"))
    k = choose("Pick (Enter to go back)", opts, allow_blank=True)
    if not k:
        return
    if k == "2":
        if NESTS_PATH.exists():
            NESTS_PATH.unlink()
        ok("Nesting removed.")
        _refresh_app()
        return
    total = sum(len(list(cpaths(ch)["raw"].glob("*.json"))) for ch in settings["channels"] if cpaths(ch)["raw"].exists())
    prog = {"n": 0}

    def pg():
        prog["n"] += 1
        if prog["n"] % 50 == 0 or prog["n"] >= total:
            status(f"    scanning transcripts {bar(prog['n'], total, 18)}  {prog['n']:,}/{total:,}")

    say("")
    groups = find_duplicates(settings["channels"], progress=pg)
    status_done()
    flagged = sum(len(g["members"]) for g in groups)
    if not groups:
        ok("No duplicate or excerpt videos found.")
        return
    _write_dup_report(groups)
    say(f"\nFound {plural(flagged, 'clip')} that look like excerpts of {plural(len(groups), 'longer video')}:")
    for g in groups[:12]:
        p = g["primary"]
        say(f"  {G}keep{X} {p['title'][:62]} {D}({p['dur'] // 60} min){X}")
        for m in g["members"][:4]:
            say(f"       clip {m['title'][:62]} {D}({m['dur'] // 60} min){X}")
    if len(groups) > 12:
        say(f"  ...and {len(groups) - 12} more group(s).")
    say(f"{D}Full list saved to output\\duplicates_report.md{X}")
    # one scan, then decide - the results are applied right here, no second scan needed
    if yes("\nNest these clips under their main videos? (reversible; the clip files are kept)"):
        n = apply_nests(groups)
        ok(f"Nested {plural(n, 'clip')}. They now appear under their main video, not on their own.")
        _refresh_app()
    else:
        say(f"{D}Left as is - nothing changed. The full list is in output\\duplicates_report.md.{X}")


# ---------------------------------------------------------------- menu screens

def channel_stats(ch):
    p = cpaths(ch)
    raw = len(list(p["raw"].glob("*.json"))) if p["raw"].exists() else 0
    tagged = len(list(p["tags"].glob("*.json"))) if p["tags"].exists() else 0
    lives = 0
    if p["raw"].exists():
        _, listing = load_listing(ch)
        lv = {v["videoId"] for v in listing if v.get("type") == "live"}
        lives = sum(1 for f in p["raw"].glob("*.json") if f.stem in lv)
    nocaps = errors = 0
    for f in load_failed(ch).values():
        if _permanent_fail(f.get("reason")):
            nocaps += 1
        elif f.get("attempts", 0) >= MAX_FAIL_ATTEMPTS:
            errors += 1
    return raw, tagged, lives, nocaps, errors


def show_header(settings):
    stats = {k: v for k, v in read_obj(STATS_PATH).get("channels", {}).items() if isinstance(v, dict)}
    w = min(term_width(), 100)
    title = " YouTube Archive "
    say(f"\n{C}{'━' * 3}{X}{B}{title}{X}{C}{'━' * max(3, w - len(title) - 3)}{X}")
    if not settings["channels"]:
        say("  No channels yet. Add one with option 5.")
    else:
        say(f"  {D}{'Channel':<24} {'Vids':>6} {'Lives':>5} {'Hours':>7} {'Tagged':>8} {'Err':>5} {'No-cap':>7}  Includes{X}")
        tv = tl = tt = tnc = te = 0
        ts = 0.0
        for ch in settings["channels"]:
            raw, tagged, lives, nocaps, errors = channel_stats(ch)
            st = stats.get(ch["slug"], {})
            secs = st.get("seconds", 0)
            tv, tl, tt, ts, tnc, te = tv + raw, tl + lives, tt + tagged, ts + secs, tnc + nocaps, te + errors
            opts = ", ".join(k for k in ("videos", "lives", "shorts") if ch.get(k)) or "nothing"
            lang = "" if ch.get("language", "en") == "en" else f", {ch['language']}"
            extra = f" {Y}test:{ch['max_videos']}{X}" if ch.get("max_videos") else ""
            extra += f" {C}playlist{X}" if ch.get("playlist") else ""
            extra += f" {C}title-filtered{X}" if (ch.get("title_include") or ch.get("title_exclude")) else ""
            tag_col = f"{G}{tagged:>7,}✓{X}" if raw and tagged >= raw else f"{Y}{tagged:>8,}{X}"
            err_col = f"{R}{errors:>5,}{X}" if errors else f"{D}{'·':>5}{X}"
            nc_col = f"{D}{nocaps:>7,}{X}" if nocaps else f"{D}{'·':>7}{X}"
            say(f"  {channel_label(ch)[:24]:<24} {raw:>6,} {lives:>5,} {fmt_hours(secs) if secs else '–':>7} "
                f"{tag_col} {err_col} {nc_col}  {D}{opts}{lang}{X}{extra}")
        if len(settings["channels"]) > 1:
            say(f"  {D}{'─' * min(w - 2, 80)}{X}")
            tot_err = f"{R}{te:>5,}{X}" if te else f"{D}{'·':>5}{X}"
            tot_nc = f"{D}{tnc:>7,}{X}" if tnc else f"{D}{'·':>7}{X}"
            say(f"  {B}{'Total':<24} {tv:>6,} {tl:>5,} {fmt_hours(ts) if ts else '–':>7} {tt:>8,}{X} {tot_err} {tot_nc}")
    a, c, _ = balance_line()
    say(f"\n  {a}")
    say(f"  {c}")
    say(f"{C}{'━' * w}{X}")


def set_title_filter(ch):
    inc, exc = ch.get("title_include") or [], ch.get("title_exclude") or []
    say(f"\n{D}Now: " + (("keep titles with [" + ", ".join(inc) + "]") if inc else "no keep-filter")
        + "; " + (("skip titles with [" + ", ".join(exc) + "]") if exc else "no skip-filter") + f"{X}")
    say("Comma-separated words or phrases, case-insensitive. Enter keeps the current value; a single '-' clears it.")
    i = input("Only KEEP videos whose title contains: ").strip()
    e = input("SKIP videos whose title contains: ").strip()
    if i:
        ch["title_include"] = [] if i == "-" else [w.strip() for w in i.split(",") if w.strip()]
    if e:
        ch["title_exclude"] = [] if e == "-" else [w.strip() for w in e.split(",") if w.strip()]
    ok("Title filter updated. Applies to videos not downloaded yet.")


def add_channel(settings):
    head("Add a channel")
    src = choose("Add from", [(1, "A whole channel (@handle or link)"), (2, "A specific playlist (paste its URL)")])
    playlist = name = None
    if src == "2":
        key = need_key("YOUTUBE_API_KEY")
        if not key:
            err("Adding a playlist needs YOUTUBE_API_KEY in .env.")
            return
        playlist = _playlist_id(input("Playlist URL (…/playlist?list=PL…): "))
        if not playlist:
            warn("Couldn't read a playlist id from that (expected a ...list=PL... link).")
            return
        name = _playlist_meta(playlist, key) or ("Playlist " + playlist[:8])
        handle, slug = name, (slug_for(name) or ("pl_" + re.sub(r"[^A-Za-z0-9]", "", playlist)[:10]))
    else:
        say("Paste the channel's @handle or link (e.g. @MuslimLantern or https://www.youtube.com/@MuslimLantern).")
        handle = normalize_handle(input("Channel: "))
        if not handle:
            return
        slug = slug_for(handle)
    if any(c["slug"].lower() == slug.lower() for c in settings["channels"]):
        warn("That is already in the list.")
        return
    say("\nMain language spoken in the videos?")
    lang = choose("Pick", [(1, "English"), (2, "Arabic"), (3, "Other (type the 2-letter code next)")])
    language = {"1": "en", "2": "ar"}.get(lang) or (input("Language code, e.g. ur, fr, tr: ").strip().lower() or "en")
    lives = yes("\nInclude live streams? (Long, so more Claude tokens, but often the best content.)")
    shorts = yes("Include Shorts? (Usually clips of the longer videos, so mostly duplicates.)")
    ch = new_channel(handle, language, lives, shorts)
    ch["slug"], ch["name"], ch["playlist"] = slug, name, playlist
    say("\nOnly take videos longer than a certain length? Useful for channels full of short clips cut from\n"
        "longer lessons. Transcripts cost the same per video whatever the length.")
    v = input("Minimum length in minutes (Enter = no minimum, e.g. 15): ").strip()
    ch["min_minutes"] = int(v) if v.isdigit() else 0
    if yes("\nFilter by words in the title? (e.g. keep only lessons, or skip 'live'/'clip')"):
        set_title_filter(ch)
    if yes("\nStart with a small test (5 videos) before doing the whole thing?"):
        ch["max_videos"] = 5
    settings["channels"].append(ch)
    save_settings(settings)
    ok(f"Added {name or handle}.")
    if ch["search"] == "keyword":
        say(f"{D}Search for this channel uses keyword search with Arabic-aware matching: fast to build even for huge\n"
            f"channels. When you ask a question, Claude turns it into the Arabic terms a scholar would use.{X}")
    if yes("Run the update now?"):
        update(settings)


def channel_menu(settings):
    if not settings["channels"]:
        warn("No channels yet.")
        return
    head("Channel settings")
    k = choose("Which channel (Enter to go back)",
               [(i + 1, channel_label(c)) for i, c in enumerate(settings["channels"])], allow_blank=True)
    if not k:
        return
    ch = settings["channels"][int(k) - 1]
    while True:
        say(f"\n{B}{channel_label(ch)}{X} ({ch['handle']})")
        onoff = lambda b: f"{G}on{X}" if b else f"{D}off{X}"  # noqa: E731
        n_failed = len(load_failed(ch))
        k = choose("Pick (Enter to go back)", [
            (1, f"Videos: {onoff(ch.get('videos', True))}"),
            (2, f"Live streams: {onoff(ch.get('lives'))}"),
            (3, f"Shorts: {onoff(ch.get('shorts'))}"),
            (4, f"Language: {ch.get('language', 'en')}"),
            (5, f"Test mode: {('max ' + str(ch['max_videos']) + ' videos') if ch.get('max_videos') else 'off (whole channel)'}"),
            (6, "Full rescan next update (catches anything missed)"),
            (7, f"Minimum length: {str(ch.get('min_minutes')) + ' min' if ch.get('min_minutes') else 'none'}"),
            (8, f"Title filter: {'on' if (ch.get('title_include') or ch.get('title_exclude')) else 'none'}"),
            (9, f"Search type: {'keyword (Arabic-aware)' if ch.get('search') == 'keyword' else 'meaning-based (English)'}"),
            (10, f"Retry failed downloads{f' ({n_failed} waiting)' if n_failed else ' (none)'}"),
            (11, f"{R}Remove channel{X} (files stay in output)"),
            (12, "Rename (the display name shown on the website)"),
        ], allow_blank=True)
        if not k:
            break
        if k == "1":
            ch["videos"] = not ch.get("videos", True)
        elif k == "2":
            ch["lives"] = not ch.get("lives")
        elif k == "3":
            ch["shorts"] = not ch.get("shorts")
        elif k == "4":
            ch["language"] = input("2-letter language code (en, ar, ur, fr...): ").strip().lower() or "en"
            say(f"{D}Applies to transcripts downloaded from now on.{X}")
            if ch["language"] != "en" and ch.get("search") != "keyword":
                ch["search"] = "keyword"
                say(f"{D}Search type switched to keyword (Arabic-aware). Change it with option 8.{X}")
        elif k == "5":
            v = input("Max videos (0 = whole channel): ").strip()
            ch["max_videos"] = int(v) if v.isdigit() else 0
        elif k == "6":
            ch["full_refresh"] = True
            ok("Next update will rescan the whole channel.")
        elif k == "7":
            v = input("Minimum length in minutes (0 = no minimum): ").strip()
            ch["min_minutes"] = int(v) if v.isdigit() else 0
            say(f"{D}Applies to videos not downloaded yet. Already-downloaded ones stay.{X}")
        elif k == "8":
            set_title_filter(ch)
        elif k == "9":
            ch["search"] = "semantic" if ch.get("search") == "keyword" else "keyword"
            say("Keyword search suits Arabic and very big channels. Meaning-based search finds paraphrases but is\n"
                "slower to build and English-only with the default model.")
            ok(f"Search type is now {'keyword' if ch['search'] == 'keyword' else 'meaning-based'}. "
               f"The next Update builds it.")
        elif k == "10":
            fails = load_failed(ch)
            if not fails:
                ok("No failed downloads to retry.")
            else:
                write_json(cpaths(ch)["failed"], {})
                ok(f"Cleared {plural(len(fails), 'failed record')}. The next Update will try those videos again.")
        elif k == "11":
            if yes(f"Remove {channel_label(ch)} from the list?"):
                settings["channels"].remove(ch)
                save_settings(settings)
                ok(f"Removed. Its files are still in output\\{ch['slug']}.")
                return
        elif k == "12":
            say(f"\nCurrent name: {B}{channel_label(ch)}{X}")
            new = input("New display name (Enter to cancel): ").strip()
            if not new or new == full_name(ch):
                say("No change.")
            else:
                ch["name"] = new
                save_settings(settings)
                ok(f"Renamed to: {channel_label(ch)}")
                say(f"{D}The website shows it after you push settings.json and it redeploys (~2 min).{X}")
                if yes("Push this change to the website now?"):
                    try:
                        _git_push_paths(["settings.json"], f"data: rename {ch['slug']}")
                        ok("Pushed - the new name shows after the redeploy.")
                    except (subprocess.CalledProcessError, FileNotFoundError):
                        warn("Could not push automatically - open GitHub Desktop and push settings.json.")
        save_settings(settings)


def settings_menu(settings):
    while True:
        head("Settings")
        k = choose("Pick (Enter to go back)", [
            (1, f"Answer language: {settings['answer_language']}"),
            (2, f"Search model: {settings['search_model']}"),
            (3, f"Model for tagging: {settings['tag_model']}"),
            (4, f"Model for answers: {settings['answer_model']}"),
            (5, f"Parallel tagging: {settings.get('tag_workers', 4)} videos at a time"),
            (6, "Edit API keys (.env)"),
            (7, "Re-tag older videos with the latest tagging method"
                + (f" {Y}(queued for next update){X}" if settings.get("retag_old") else "")),
            (8, f"Fast indexing (all CPU cores): {'on' if settings.get('fast_indexing', True) else 'off'}"),
            (9, f"Tagging method: {settings.get('tag_mode', 'auto')}"),
        ], allow_blank=True)
        if not k:
            return
        if k == "1":
            v = choose("Answer in", [(1, "Same language as my question"), (2, "Always English"), (3, "Always Arabic")])
            settings["answer_language"] = {"1": "auto", "2": "english", "3": "arabic"}[v]
        elif k == "2":
            say("english: small and fast, best for English channels.\n"
                "multilingual: understands Arabic and ~100 languages, but a 2 GB download and slower indexing.")
            v = choose("Search model", [(1, "english"), (2, "multilingual")])
            new = {"1": "english", "2": "multilingual"}[v]
            if new != settings["search_model"]:
                settings["search_model"] = new
                warn("Run Update to re-index everything with the new model.")
        elif k == "3":
            v = choose("Tagging model", [(1, "claude-haiku-5-5 (cheap, recommended)"), (2, "claude-sonnet-5-5")])
            settings["tag_model"] = {"1": "claude-haiku-5-5", "2": "claude-sonnet-5-5"}[v]
        elif k == "4":
            v = choose("Answer model", [(1, "claude-sonnet-5-5 (recommended)"), (2, "claude-opus-5-5 (best, ~2.5x cost)"),
                                        (3, "claude-haiku-5-5 (cheapest)")])
            settings["answer_model"] = {"1": "claude-sonnet-5-5", "2": "claude-opus-5-5", "3": "claude-haiku-5-5"}[v]
        elif k == "5":
            set_tag_workers(settings)
        elif k == "6":
            open_path(ROOT / ".env", notepad=True)
            warn("Restart the app after saving .env so the new keys are loaded.")
        elif k == "7":
            set_retag(settings)
        elif k == "8":
            settings["fast_indexing"] = not settings.get("fast_indexing", True)
            say("Fast indexing spreads the search indexing over all CPU cores. Turn it off only if indexing "
                "errors out or makes your PC unusable while it runs.")
            ok(f"Fast indexing is now {'on' if settings['fast_indexing'] else 'off'}.")
        elif k == "9":
            say("How videos get tagged by Claude:\n"
                "  auto  - big runs use Claude's batch service (about half price); small runs tag live. Recommended.\n"
                "  live  - tag during download, results appear right away, full price.\n"
                "  batch - always use the batch service: about half price, not instant (usually within the hour).")
            v = choose("Tagging method", [(1, "auto"), (2, "live"), (3, "batch")])
            settings["tag_mode"] = {"1": "auto", "2": "live", "3": "batch"}[v]
            ok(f"Tagging method set to {settings['tag_mode']}.")
        save_settings(settings)


def set_retag(settings):
    old, words = 0, 0
    for ch in settings["channels"]:
        for v in load_videos(ch):
            if 0 < tag_version(ch, v["videoId"]) < TAG_VERSION:
                old += 1
                words += video_words(v)
    if not old:
        ok("Every video is already tagged with the latest method.")
        settings["retag_old"] = False
        return
    p = PRICES.get(settings["tag_model"], (1.0, 5.0))
    est = words * 1.4 / 1e6 * p[0] + old * 800 / 1e6 * p[1]
    say(f"\n{plural(old, 'video')} were tagged with the older method. Re-tagging them makes every summary, "
        f"topic and key claim consistent.\nEstimated cost: {money(est)} Claude. "
        f"Old tags stay in place until each new one is saved, so nothing goes missing midway.")
    if yes("Re-tag them on the next update?"):
        settings["retag_old"] = True
        ok("Queued. Run Update (1 or 2) to do it.")
    else:
        settings["retag_old"] = False


def set_tag_workers(settings):
    say("\nHow many videos Claude tags at the same time. More is faster and costs the same.\n"
        "The limit is your Anthropic account's rate limit, which grows as you spend more over time.\n"
        "If you set it too high, requests just wait and retry automatically, so nothing breaks.\n"
        "See your limits at console.anthropic.com/settings/limits.")
    say(f"Recommended: {B}4{X} for a new account, 8 to 12 once you've spent a bit more. Max 24.")
    while True:
        a = input("Parallel tagging (1-24, Enter = 4): ").strip()
        if not a:
            settings["tag_workers"] = 4
            break
        if a.isdigit() and 1 <= int(a) <= 24:
            settings["tag_workers"] = int(a)
            break
    ok(f"Set to {settings['tag_workers']} at a time.")


def spending(settings):
    head("Balances and spending")
    a, c, b = balance_line()
    say(a)
    tot, led = spend_totals()
    for svc in ("apify", "claude"):
        t = tot.get(svc, {"all": 0, "month": 0})
        say(f"  {svc.capitalize()} spent by this tool: {money(t['month'])} this month, {money(t['all'])} total")
    say("Claude balance can't be read by the API for personal accounts. Check: console.anthropic.com/settings/billing")
    if led:
        say(f"\n{D}Last 8 charges:{X}")
        for e in led[-8:]:
            say(f"  {e['when'][:16]}  {e['service']:<6} {money(e['usd']):>8}  {e['note']}"
                f"{' (' + e['channel'] + ')' if e.get('channel') else ''}")


def open_path(path, notepad=False):
    path = Path(path)
    try:
        if os.name == "nt":
            if notepad:
                os.system(f'notepad "{path}"')
            else:
                os.startfile(str(path))  # type: ignore[attr-defined]
        else:
            import webbrowser
            webbrowser.open(path.resolve().as_uri())
    except Exception:
        say(f"Open this yourself: {path}")


def open_url(url):
    try:
        if os.name == "nt":
            os.startfile(url)  # type: ignore[attr-defined]
        else:
            import webbrowser
            webbrowser.open(url)
    except Exception:
        say(f"Open this in your browser: {url}")


_SERVER = {}


def serve_app():
    """Serve the browsable archive (output/ALL/app) from a tiny local web server and open it."""
    app_dir = ALL / "app"
    if not (app_dir / "index.html").exists():
        warn("The archive isn't built yet. Run Update (1) first.")
        return
    import http.server
    import socketserver
    import threading
    import functools
    if not _SERVER.get("port"):
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass
        handler = functools.partial(Quiet, directory=str(app_dir))
        httpd = None
        for port in range(8137, 8190):
            try:
                httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
                break
            except OSError:
                continue
        if not httpd:
            warn("Couldn't start the local server (ports busy). Close other windows and try again.")
            return
        httpd.daemon_threads = True
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        _SERVER["port"] = port
    url = f"http://127.0.0.1:{_SERVER['port']}/"
    ok(f"Archive is live at {url}")
    say(f"{D}Leave this window open while you browse. Any browser on this PC can open that address too.{X}")
    open_url(url)


def first_run_checks(settings):
    missing = [k for k in ("APIFY_TOKEN", "ANTHROPIC_API_KEY") if not need_key(k)]
    if missing:
        warn(f"Missing in .env: {', '.join(missing)}. Opening it now; paste the keys, save, then restart.")
        open_path(ROOT / ".env", notepad=True)
        return False
    if "onedrive" in str(ROOT).lower() and not settings.get("onedrive_warned"):
        warn("Heads up: this folder is inside OneDrive. OneDrive tries to sync the thousands of setup files here, "
             "which slows things down. Better: move the whole yt-archive folder to e.g. C:\\yt-archive. "
             "(This message shows once.)")
        settings["onedrive_warned"] = True
        save_settings(settings)
    return True


# Where the website's data lives, so publish can upload it automatically.
GH_REPO = "abdelrahmanelramahi-debug/yt-archive-actual"
GH_DATA_TAG = "data-v1"
GH_ASSET = "archive-data.tar.gz"
GH_RELEASE_URL = f"https://github.com/{GH_REPO}/releases/tag/{GH_DATA_TAG}"


def _gh_api(method, url, token, data=None, content_type=None, length=None):
    """One GitHub API call via urllib. Returns parsed JSON ({} for an empty body)."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "la-tifti-publish"}
    if content_type:
        headers["Content-Type"] = content_type
    if length is not None:
        headers["Content-Length"] = str(length)
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=900) as r:
        body = r.read()
    return json.loads(body) if body else {}


class _ProgressReader:
    """Streams a file to the upload while printing a percentage, so a big upload does not look stuck."""
    def __init__(self, path):
        self.f = open(path, "rb")
        self.total = os.path.getsize(path)
        self.sent = 0
        self._shown = -1

    def read(self, n=-1):
        chunk = self.f.read(n)
        self.sent += len(chunk)
        pct = int(self.sent * 100 / self.total) if self.total else 100
        if pct != self._shown and pct % 5 == 0:
            self._shown = pct
            print(f"\r  uploading {pct}% ", end="", flush=True)
        return chunk

    def __len__(self):
        return self.total

    def close(self):
        self.f.close()


def _upload_release_asset(path, token):
    """Replace the data archive on the release: delete the old asset, upload the new one (same name)."""
    rel = _gh_api("GET", f"https://api.github.com/repos/{GH_REPO}/releases/tags/{GH_DATA_TAG}", token)
    rel_id = rel["id"]
    for a in rel.get("assets", []):
        if a.get("name") == GH_ASSET:
            _gh_api("DELETE", f"https://api.github.com/repos/{GH_REPO}/releases/assets/{a['id']}", token)
    up = _ProgressReader(path)
    try:
        url = f"https://uploads.github.com/repos/{GH_REPO}/releases/{rel_id}/assets?name={GH_ASSET}"
        _gh_api("POST", url, token, data=up, content_type="application/gzip", length=up.total)
    finally:
        up.close()
    print()  # finish the progress line


def _git_push_paths(paths, msg):
    """Stage the given paths, commit, and push, using the machine's existing git credentials."""
    subprocess.run(["git", "add", *paths], cwd=str(ROOT), check=True)
    subprocess.run(["git", "commit", "-m", msg], cwd=str(ROOT), check=True)
    subprocess.run(["git", "push"], cwd=str(ROOT), check=True)


def _git_push_settings():
    """Commit settings.json + a version bump and push, so Railway redeploys and the brain re-pulls.
    The version bump guarantees a redeploy even when only the data (not settings) changed."""
    (ROOT / "deploy").mkdir(exist_ok=True)
    (ROOT / "deploy" / "data.version").write_text(
        f"{datetime.now():%Y-%m-%d %H:%M:%S}\n", encoding="utf-8")
    _git_push_paths(["settings.json", "deploy/data.version"],
                    f"data: publish {datetime.now():%Y-%m-%d %H:%M}")


def publish_data(settings):
    """Package the search data and put it live on the website in one go.

    The website's brain does not see your computer - it loads one data archive at startup. This
    bundles only what the brain serves (each channel's search index + chunks), uploads it to the
    GitHub data release, and pushes so Railway redeploys and pulls it. With no GITHUB_TOKEN in .env
    it just builds the file and prints the manual upload steps instead."""
    import tarfile
    # Same file name as the live release asset, so replacing it keeps the download link valid.
    out = ROOT / "archive-data.tar.gz"
    added, missing = 0, []
    say("Packaging the website's search data ...")
    with tarfile.open(out, "w:gz") as tar:
        for ch in settings["channels"]:
            p = cpaths(ch)
            chunks = p["data"] / "chunks.jsonl"
            if not p["search"].exists() or not chunks.exists():
                missing.append(channel_label(ch))
                continue
            tar.add(chunks, arcname=f"{ch['slug']}/data/chunks.jsonl")
            tar.add(p["search"], arcname=f"{ch['slug']}/search")
            added += 1
            say(f"  + {channel_label(ch)}")
    if not added:
        warn("No channels have a search index yet - run Update first. Nothing to publish.")
        try:
            out.unlink()
        except OSError:
            pass
        return
    size_mb = out.stat().st_size / 1_000_000
    say("")
    ok(f"Built {out.name}: {added} channel(s), {size_mb:,.0f} MB")
    if missing:
        warn(f"Skipped (no search index yet): {', '.join(missing)}")

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        # No token: build only, show the manual steps.
        say(f"  {out}")
        say("")
        say("To put this live (add GITHUB_TOKEN to .env and I do this for you next time):")
        say("  1. Open the release, delete the old archive-data.tar.gz, upload this one (same name):")
        say(f"     {GH_RELEASE_URL}")
        say("  2. If you ADDED a channel, push settings.json too (GitHub Desktop: commit + push).")
        say("  3. On Railway, open the brain service and click Redeploy.")
        return

    # One-command path: upload to the release, then push so the brain redeploys and re-pulls.
    say("")
    try:
        say(f"Uploading {size_mb:,.0f} MB to GitHub (a few minutes) ...")
        _upload_release_asset(out, token)
        ok("Uploaded to the data release.")
    except Exception as e:
        err(f"Upload failed: {str(e)[:200]}")
        warn(f"The archive is built at {out} - you can still upload it by hand:")
        warn(f"  {GH_RELEASE_URL}")
        return
    try:
        _git_push_settings()
        ok("Pushed - Railway is redeploying the brain.")
        say("")
        ok("Done. Your new data is live a couple of minutes after the redeploy finishes.")
    except (subprocess.CalledProcessError, FileNotFoundError):
        warn("Data uploaded, but the automatic push did not run.")
        warn("Just open GitHub Desktop and push to finish (or the brain won't see new channels).")


def find_channel(settings, key):
    """Find a channel by slug, @handle, or current display name (case-insensitive)."""
    k = key.strip().lower().lstrip("@")
    for ch in settings["channels"]:
        names = {ch["slug"].strip().lower(),
                 ch.get("handle", "").strip().lower().lstrip("@"),
                 full_name(ch).strip().lower()}
        if k in names:
            return ch
    return None


def rename_channel_cli(settings, args):
    """`python app.py rename "<slug or name>" "<new display name>"` - rename a channel from the terminal.
    Updates the display name the website shows; push settings.json afterwards to make it live."""
    if len(args) < 2:
        say('Usage: python app.py rename "<slug or name>" "<new display name>"')
        say("")
        say("Channels (use the slug on the left):")
        for ch in settings["channels"]:
            say(f"  {ch['slug']}  (now: {channel_label(ch)})")
        return
    ch = find_channel(settings, args[0])
    if not ch:
        err(f"No channel matches '{args[0]}'. Run `python app.py rename` with no arguments to list them.")
        return
    old = channel_label(ch)
    new = args[1].strip()
    if not new or new == full_name(ch):
        say("No change.")
        return
    ch["name"] = new
    save_settings(settings)
    ok(f"Renamed '{old}' -> '{channel_label(ch)}'.")
    say("To show it on the website, push settings.json (GitHub Desktop, or `git push`); it redeploys automatically.")


def menu():
    settings = load_settings()
    if not first_run_checks(settings):
        pause()
        return
    while True:
        show_header(settings)
        say("")
        k = choose("Choose", [
            (1, "Update (asks before spending)"),
            (2, "Update overnight (set a budget once, then no questions)"),
            (3, "Ask a question"),
            (4, "Open the archive in your browser"),
            (5, "Add a channel"),
            (6, "Channel settings (lives, shorts, language, remove)"),
            (7, "Settings (speeds, answer language, search model, re-tag, keys)"),
            (8, "Balances and spending"),
            (9, "Open the output folder"),
            ("p", "Publish data for the website (after adding channels)"),
            ("d", "Find duplicate / excerpt videos"),
            (0, "Exit"),
        ])
        try:
            if k == "0":
                return
            if k == "1":
                update(settings)
            elif k == "2":
                update_overnight(settings)
            elif k == "3":
                ask(settings)
            elif k == "4":
                serve_app()
            elif k == "5":
                add_channel(settings)
            elif k == "6":
                channel_menu(settings)
            elif k == "7":
                settings_menu(settings)
            elif k == "8":
                spending(settings)
            elif k == "9":
                OUTPUT.mkdir(exist_ok=True)
                open_path(OUTPUT)
            elif k == "p":
                publish_data(settings)
            elif k == "d":
                duplicates_menu(settings)
            if k in ("1", "2", "3", "8", "p", "d"):
                pause()
        except KeyboardInterrupt:
            warn("\nStopped. Anything finished so far is saved.")
        except Exception as e:
            import traceback
            try:
                (OUTPUT / "last_error.txt").write_text(_redact(traceback.format_exc()), encoding="utf-8")
            except Exception:
                pass
            err(f"\nSomething went wrong: {e}")
            err(f"Full details saved to {OUTPUT / 'last_error.txt'} - send that (or a screenshot) to Claude. "
                f"Anything finished so far is saved.")
            pause()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "menu"
    try:
        if cmd == "menu":
            menu()
        else:
            s = load_settings()
            if cmd == "update":
                update(s)
            elif cmd == "overnight":
                update_overnight(s)
            elif cmd == "ask":
                ask(s)
            elif cmd == "balance":
                spending(s)
            elif cmd == "publish":
                publish_data(s)
            elif cmd == "rename":
                rename_channel_cli(s, sys.argv[2:])
            else:
                say(__doc__)
    except KeyboardInterrupt:
        warn("\nStopped. Anything finished so far is saved.")
