"""
osu! Mapper Bulk Downloader — Flask Backend v3
Now with: first-run setup wizard, config stored in %APPDATA%, PyInstaller-ready.
"""

import os
import re
import sys
import time
import json
import base64
import ctypes
import threading
import secrets
import requests
from pathlib import Path
from urllib.parse import urlparse
from flask import Flask, abort, jsonify, request, Response, stream_with_context, redirect
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ─── PyInstaller / Dev Path Resolution ──────────────────────────────────────────
def resource_path(relative):
    """Resolve paths for both dev environment and PyInstaller frozen exe."""
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), relative)

STATIC_PATH = resource_path('static')

# ─── Config Storage ──────────────────────────────────────────────────────────────
CONFIG_DIR  = os.path.join(os.environ.get('APPDATA', os.path.expanduser('~')), 'OsuMapperDownloader')
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.json')

OSU_API_BASE  = "https://osu.ppy.sh/api/v2"
OSU_TOKEN_URL = "https://osu.ppy.sh/oauth/token"

MIRRORS = [
    {"name": "Nerinyan",   "url": "https://api.nerinyan.moe/d/{id}"},
    {"name": "osu.direct", "url": "https://osu.direct/api/d/{id}"},
    {"name": "catboy.best","url": "https://catboy.best/d/{id}"},
]

_ID_RE     = re.compile(r'^(\d+)')


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _dpapi_protect(value: str) -> str:
    """Encrypt a secret for the current Windows user with DPAPI."""
    if os.name != "nt":
        return value
    raw = value.encode("utf-8")
    buffer = ctypes.create_string_buffer(raw)
    source = _DataBlob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    protected = _DataBlob()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(source), None, None, None, None, 1, ctypes.byref(protected)
    ):
        raise ctypes.WinError()
    try:
        return base64.b64encode(ctypes.string_at(protected.pbData, protected.cbData)).decode("ascii")
    finally:
        ctypes.windll.kernel32.LocalFree(protected.pbData)


def _dpapi_unprotect(value: str) -> str:
    if os.name != "nt":
        return value
    raw = base64.b64decode(value)
    buffer = ctypes.create_string_buffer(raw)
    source = _DataBlob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    plain = _DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 1, ctypes.byref(plain)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(plain.pbData, plain.cbData).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(plain.pbData)


def default_songs_path():
    """Try to auto-detect the osu! Songs folder on Windows."""
    candidates = [
        os.path.join(os.environ.get('LOCALAPPDATA', ''), 'osu!', 'Songs'),
        os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'osu!', 'Songs'),
        r'C:\Program Files\osu!\Songs',
    ]
    for p in candidates:
        if os.path.isdir(p):
            return p
    return os.path.join(os.environ.get('LOCALAPPDATA', ''), 'osu!', 'Songs')


def load_config() -> dict:
    """Load config from %APPDATA%, falling back to empty defaults."""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, encoding='utf-8') as f:
                data = json.load(f)
            if "client_secret_protected" in data:
                data["client_secret"] = _dpapi_unprotect(data.pop("client_secret_protected"))
            return data
        except Exception:
            pass
    return {"client_id": "", "client_secret": "", "songs_path": default_songs_path()}


def save_config(data: dict):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    stored = dict(data)
    secret = stored.pop("client_secret", "")
    stored["client_secret_protected"] = _dpapi_protect(secret)
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(stored, f, indent=2)
    # Invalidate token cache when credentials change
    _token_cache["access_token"] = None
    _token_cache["expires_at"]   = 0


def is_configured() -> bool:
    cfg = load_config()
    return bool(cfg.get("client_id") and cfg.get("client_secret") and cfg.get("songs_path"))


# ─── Flask App ───────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder=STATIC_PATH, static_url_path="")

# A single session reuses HTTP connections and retries transient upstream errors.
_http = requests.Session()
_http.mount("https://", HTTPAdapter(max_retries=Retry(
    total=3, connect=3, read=3, backoff_factor=0.5,
    status_forcelist=(429, 500, 502, 503, 504),
    allowed_methods=frozenset(("GET", "POST")),
)))

# ─── OAuth Token Cache ───────────────────────────────────────────────────────────
_token_cache = {"access_token": None, "expires_at": 0}
_token_lock  = threading.Lock()
_download_locks = {}
_download_locks_lock = threading.Lock()
_download_index = {"path": None, "loaded_at": 0, "items": {}}
_download_index_lock = threading.Lock()


def get_osu_token():
    cfg = load_config()
    with _token_lock:
        if _token_cache["access_token"] and time.time() < _token_cache["expires_at"] - 60:
            return _token_cache["access_token"]
        resp = _http.post(OSU_TOKEN_URL, json={
            "client_id":     int(cfg["client_id"]),
            "client_secret": cfg["client_secret"],
            "grant_type":    "client_credentials",
            "scope":         "public",
        }, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        _token_cache["access_token"] = data["access_token"]
        _token_cache["expires_at"]   = time.time() + data.get("expires_in", 86400)
        return _token_cache["access_token"]


def osu_api_get(endpoint, params=None):
    token   = get_osu_token()
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    resp    = _http.get(f"{OSU_API_BASE}{endpoint}", headers=headers, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()


# ─── First-Run Guard ─────────────────────────────────────────────────────────────
_SETUP_ALLOWED = {
    'setup_page', 'do_setup', 'test_credentials',
    'browse_folder', 'get_current_config', 'static',
}

@app.before_request
def check_configured():
    """Redirect to /setup if the app hasn't been configured yet."""
    # Reject cross-site requests to the local control server. pywebview uses a
    # loopback origin; direct navigation has no Origin header and remains valid.
    origin = request.headers.get("Origin")
    if origin and urlparse(origin).hostname not in {"localhost", "127.0.0.1", "::1"}:
        abort(403)
    if request.endpoint in _SETUP_ALLOWED:
        return None
    if request.path.startswith('/setup') or request.path.startswith('/static'):
        return None
    if not is_configured():
        return redirect('/setup')


# ─── Setup Routes ────────────────────────────────────────────────────────────────

@app.route('/setup')
def setup_page():
    return app.send_static_file('setup.html')


@app.route('/api/config/current')
def get_current_config():
    """Return current config — secret is masked for display."""
    cfg = load_config()
    secret = cfg.get('client_secret', '')
    return jsonify({
        "client_id":    cfg.get('client_id', ''),
        "client_secret_masked": ('*' * (len(secret) - 4) + secret[-4:]) if len(secret) > 4 else '*' * len(secret),
        "songs_path":   cfg.get('songs_path', default_songs_path()),
        "configured":   is_configured(),
    })


@app.route('/api/test-credentials', methods=['POST'])
def test_credentials():
    """Test an osu! Client ID + Secret pair without saving them."""
    data      = request.get_json(silent=True) or {}
    client_id = data.get('client_id', '').strip()
    secret    = data.get('client_secret', '').strip()
    if not client_id or not secret:
        return jsonify({"ok": False, "error": "Client ID and Secret are required"}), 400
    try:
        resp = _http.post(OSU_TOKEN_URL, json={
            "client_id":     int(client_id),
            "client_secret": secret,
            "grant_type":    "client_credentials",
            "scope":         "public",
        }, timeout=10)
        if resp.status_code == 401:
            return jsonify({"ok": False, "error": "Invalid credentials — check your Client ID and Secret."})
        resp.raise_for_status()
        return jsonify({"ok": True})
    except ValueError:
        return jsonify({"ok": False, "error": "Client ID must be a number."})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:200]})


@app.route('/api/setup', methods=['POST'])
def do_setup():
    """Save configuration and signal the app is ready."""
    data      = request.get_json(silent=True) or {}
    client_id = str(data.get('client_id', '')).strip()
    secret    = data.get('client_secret', '').strip()
    songs     = data.get('songs_path', '').strip()

    if not client_id or not secret:
        return jsonify({"ok": False, "error": "Client ID and Secret are required."}), 400
    if not songs:
        return jsonify({"ok": False, "error": "Songs folder path is required."}), 400
    songs_path = Path(songs).expanduser()
    if not songs_path.is_dir():
        return jsonify({"ok": False, "error": "Songs folder does not exist or is not a directory."}), 400

    # If secret is all-masked, keep the existing one
    if all(c == '*' for c in secret):
        existing = load_config().get('client_secret', '')
        if not existing:
            return jsonify({"ok": False, "error": "Please enter your Client Secret."}), 400
        secret = existing

    save_config({"client_id": client_id, "client_secret": secret, "songs_path": str(songs_path)})

    return jsonify({"ok": True})


@app.route('/api/browse-folder')
def browse_folder():
    """Open a native Windows folder-picker dialog and return the chosen path."""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.wm_attributes('-topmost', 1)
        folder = filedialog.askdirectory(title="Select your osu! Songs folder")
        root.destroy()
        if folder:
            # Convert forward slashes to backslashes on Windows
            folder = os.path.normpath(folder)
            return jsonify({"path": folder})
        return jsonify({"path": None})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Main App Routes ─────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return app.send_static_file('index.html')


@app.route('/api/config')
def get_config_route():
    cfg = load_config()
    return jsonify({
        "songs_path": cfg.get('songs_path', ''),
        "mirrors":    [m["name"] for m in MIRRORS],
    })


@app.route('/api/downloaded')
def get_downloaded():
    cfg        = load_config()
    songs_path = Path(cfg.get('songs_path', ''))
    now = time.monotonic()
    with _download_index_lock:
        if (_download_index["path"] == str(songs_path) and
                now - _download_index["loaded_at"] < 20):
            return jsonify({"downloads": _download_index["items"]})
        dl_map = {}
        try:
            with os.scandir(songs_path) as entries:
                for item in entries:
                    m = _ID_RE.match(item.name)
                    if m:
                        try:
                            dl_map[int(m.group(1))] = item.stat().st_mtime
                        except OSError:
                            continue
        except (FileNotFoundError, PermissionError, OSError):
            pass
        _download_index.update({"path": str(songs_path), "loaded_at": now, "items": dl_map})
    return jsonify({"downloads": dl_map})


@app.route('/api/user/<username>')
def lookup_user(username):
    try:
        mode = request.args.get('mode', '').strip()
        endpoint = f"/users/{username}/{mode}" if mode else f"/users/{username}"
        data = osu_api_get(endpoint, params={"key": "username"})
        return jsonify({
            "id":           data["id"],
            "username":     data["username"],
            "avatar_url":   data["avatar_url"],
            "country_code": data.get("country_code", ""),
            "cover_url":    data.get("cover", {}).get("url", ""),
            "statistics": {
                "ranked_score": data.get("statistics", {}).get("ranked_score", 0),
                "play_count":   data.get("statistics", {}).get("play_count", 0),
                "global_rank":  data.get("statistics", {}).get("global_rank"),
            },
        })
    except requests.exceptions.HTTPError as e:
        code = e.response.status_code if e.response is not None else 500
        if code == 404:
            return jsonify({"error": "User not found"}), 404
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/beatmapsets/<int:user_id>')
def get_user_beatmapsets(user_id):
    types    = ["ranked", "loved", "pending", "graveyard"]
    all_sets = []
    for btype in types:
        offset = 0
        limit  = 50
        while True:
            try:
                data = osu_api_get(f"/users/{user_id}/beatmapsets/{btype}", {
                    "limit":  limit,
                    "offset": offset,
                })
            except Exception as e:
                print(f"[beatmapsets] {btype} offset {offset}: {e}")
                break
            if not data:
                break
            for s in data:
                s["_type"] = btype
            all_sets.extend(data)
            if len(data) < limit:
                break
            offset += limit
            time.sleep(0.25)
    all_sets.sort(
        key=lambda s: s.get("ranked_date") or s.get("submitted_date") or "",
        reverse=True,
    )
    return jsonify({"total": len(all_sets), "beatmapsets": [_beatmapset_for_client(s) for s in all_sets]})

@app.route('/api/search')
def global_search():
    query = request.args.get('q', '').strip()[:200]
    sort = request.args.get('sort', '')
    cursor = request.args.get('cursor_string', '')
    genre = request.args.get('g', '')
    language = request.args.get('l', '')

    import re
    mode_match = re.search(r'\b(?:mode|m)=(osu|o|taiko|t|catch|c|fruits|mania|m)\b', query, re.IGNORECASE)
    status_match = re.search(r'\b(?:status|s)=(ranked|r|approved|a|qualified|q|loved|l|pending|p|wip|w|graveyard|g)\b', query, re.IGNORECASE)
    
    mode_map = {'osu': 0, 'o': 0, 'taiko': 1, 't': 1, 'catch': 2, 'c': 2, 'fruits': 2, 'mania': 3, 'm': 3}
    status_map = {
        'ranked': 'ranked', 'r': 'ranked', 'approved': 'ranked', 'a': 'ranked',
        'qualified': 'qualified', 'q': 'qualified', 'loved': 'loved', 'l': 'loved',
        'pending': 'pending', 'p': 'pending', 'wip': 'wip', 'w': 'wip',
        'graveyard': 'graveyard', 'g': 'graveyard'
    }

    params = {}
    if mode_match:
        params['m'] = mode_map.get(mode_match.group(1).lower())
        query = query.replace(mode_match.group(0), '')
        
    if status_match:
        params['s'] = status_map.get(status_match.group(1).lower())
        query = query.replace(status_match.group(0), '')

    query = re.sub(r'\s+', ' ', query).strip()
    if query: params['q'] = query

    allowed_sorts = {'title', 'artist', 'difficulty', 'ranked', 'rating', 'plays', 'favourites'}
    if sort in allowed_sorts: params['sort'] = sort
    if genre.isdigit(): params['g'] = genre
    if language.isdigit(): params['l'] = language
    if cursor: params['cursor_string'] = cursor
    
    try:
        data = osu_api_get("/beatmapsets/search", params=params)
        data["beatmapsets"] = [_beatmapset_for_client(s) for s in data.get("beatmapsets", [])]
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/users/<int:user_id>/top-plays')
def top_plays(user_id):
    """Return a player's best scores as unique, downloadable beatmapsets."""
    mode = request.args.get('mode', '')
    try:
        limit = min(max(int(request.args.get('limit', 50)), 1), 100)
        offset = max(int(request.args.get('offset', 0)), 0)
    except ValueError:
        return jsonify({"error": "Invalid pagination"}), 400
    params = {'limit': limit, 'offset': offset, 'legacy_only': 0}
    if mode in {'osu', 'taiko', 'fruits', 'mania'}:
        params['mode'] = mode
    try:
        scores = osu_api_get(f"/users/{user_id}/scores/best", params)
        seen_sets, plays = set(), []
        for score in scores:
            beatmapset = score.get('beatmapset') or {}
            set_id = beatmapset.get('id')
            if not set_id or set_id in seen_sets:
                continue
            seen_sets.add(set_id)
            item = _beatmapset_for_client(beatmapset)
            beatmap = score.get('beatmap') or {}
            item['_top_play'] = {
                'rank': len(plays) + 1,  # Sequential rank after dedup
                'pp': score.get('pp'), 'weighted_pp': (score.get('weight') or {}).get('pp'),
                'mods': score.get('mods') or [], 'accuracy': score.get('accuracy'),
                'grade': score.get('rank', '-'), 'max_combo': score.get('max_combo', 0),
                'misses': (score.get('statistics') or {}).get('count_miss', 0),
                'date': score.get('ended_at') or score.get('created_at'),
                'difficulty': beatmap.get('version', ''), 'beatmap_id': beatmap.get('id'),
                'mode': score.get('ruleset_id', score.get('mode', '')),
            }
            # Ensure beatmaps array has at least the played difficulty for mode detection
            if not item.get('beatmaps') and beatmap:
                item['beatmaps'] = [{'mode': beatmap.get('mode', ''), 'difficulty_rating': beatmap.get('difficulty_rating', 0),
                                     'bpm': beatmap.get('bpm', 0), 'cs': beatmap.get('cs', 0)}]
            plays.append(item)
        return jsonify({'top_plays': plays, 'has_more': len(scores) == limit})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── Download Helpers ────────────────────────────────────────────────────────────
def _sse(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


def _beatmapset_for_client(data: dict) -> dict:
    """Return only UI fields, avoiding large unused osu API payloads."""
    return {
        "id": data.get("id"), "title": data.get("title", ""),
        "artist": data.get("artist", ""), "tags": data.get("tags", ""),
        "favourite_count": data.get("favourite_count", 0),
        "submitted_date": data.get("submitted_date"), "ranked_date": data.get("ranked_date"),
        "_type": data.get("_type", data.get("status", "")),
        "beatmaps": [{"mode": b.get("mode"), "difficulty_rating": b.get("difficulty_rating", 0),
                      "bpm": b.get("bpm", 0), "cs": b.get("cs", 0)}
                     for b in data.get("beatmaps", [])],
    }


def _get_download_lock(beatmapset_id: int) -> threading.Lock:
    with _download_locks_lock:
        return _download_locks.setdefault(beatmapset_id, threading.Lock())


def _classify_error(exc=None, resp=None) -> str:
    if resp is not None:
        return {404: "Not found (404)", 429: "Rate limited (429)", 403: "Forbidden (403)",
                503: "Mirror down (503)", 502: "Bad gateway (502)"}.get(resp.status_code, f"HTTP {resp.status_code}")
    if exc is None:
        return "Unknown error"
    if isinstance(exc, requests.exceptions.Timeout):
        return "Timed out after 120s"
    if isinstance(exc, requests.exceptions.ConnectionError):
        return "Connection refused / DNS failure"
    return str(exc)[:140]


@app.route('/api/download-progress/<int:beatmapset_id>')
def download_with_progress(beatmapset_id):
    def generate():
        cfg = load_config()
        songs_path = Path(cfg.get('songs_path', ''))
        if not songs_path.is_dir():
            yield _sse({"type": "failed", "message": "Configured Songs folder is unavailable", "errors": []})
            return
        errors = []
        final_path = songs_path / f"{beatmapset_id}.osz"
        part_path = songs_path / f".{beatmapset_id}.{secrets.token_hex(8)}.osz.part"

        with _get_download_lock(beatmapset_id):
            if final_path.exists():
                yield _sse({"type": "done", "mirror": "local cache", "filename": final_path.name,
                            "size": final_path.stat().st_size, "path": str(final_path)})
                return
            for mirror in MIRRORS:
                url = mirror["url"].format(id=beatmapset_id)
                yield _sse({"type": "trying", "mirror": mirror["name"]})
                try:
                    with _http.get(url, stream=True, timeout=(15, 120), allow_redirects=True) as resp:
                        if not resp.ok:
                            reason = _classify_error(resp=resp)
                            errors.append({"mirror": mirror["name"], "reason": reason})
                            yield _sse({"type": "mirror_fail", "mirror": mirror["name"], "reason": reason})
                            continue
                        content_type = resp.headers.get("Content-Type", "").lower()
                        if "text/html" in content_type or "application/json" in content_type:
                            raise ValueError("Mirror returned a non-map response")
                        try:
                            total_size = int(resp.headers.get("Content-Length", 0))
                        except ValueError:
                            total_size = 0
                        downloaded = 0
                        yield _sse({"type": "start", "mirror": mirror["name"], "total": total_size, "filename": final_path.name})
                        speed_bytes = 0
                        last_time = time.time()
                        last_bytes = 0
                        with open(part_path, "wb") as f:
                            for chunk in resp.iter_content(chunk_size=32768):
                                if chunk:
                                    f.write(chunk)
                                    downloaded += len(chunk)
                                    now     = time.time()
                                    elapsed = now - last_time
                                    if elapsed >= 0.4:
                                        speed_bytes = int((downloaded - last_bytes) / elapsed)
                                        last_time   = now
                                        last_bytes  = downloaded
                                        pct = round(downloaded / total_size * 100, 1) if total_size else 0
                                        yield _sse({"type": "progress", "downloaded": downloaded,
                                                    "total": total_size, "percent": pct, "speed": speed_bytes})
                        if total_size and downloaded != total_size:
                            raise ValueError("Download ended before the advertised content length")
                        if downloaded < 1024:
                            raise ValueError("Downloaded file is too small to be a beatmap archive")
                    os.replace(part_path, final_path)
                    with _download_index_lock:
                        _download_index["loaded_at"] = 0
                    yield _sse({"type": "done", "mirror": mirror["name"], "filename": final_path.name,
                                "size": downloaded, "path": str(final_path).replace("\\", "/")})
                
                    # Append to history only after the final file exists.
                    try:
                        import datetime
                        os.makedirs(CONFIG_DIR, exist_ok=True)
                        log_path = os.path.join(CONFIG_DIR, 'download_history.txt')
                        with open(log_path, 'a', encoding='utf-8') as hf:
                            ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                            hf.write(f"[{ts}] ID: {beatmapset_id} | Mirror: {mirror['name']} | File: {final_path.name}\n")
                    except OSError:
                        pass
                    return

                except Exception as e:
                    try:
                        part_path.unlink(missing_ok=True)
                    except OSError:
                        pass
                    reason = _classify_error(e)
                    errors.append({"mirror": mirror["name"], "reason": reason})
                    yield _sse({"type": "mirror_fail", "mirror": mirror["name"], "reason": reason})
                    continue

        yield _sse({"type": "failed", "message": "All mirrors failed", "errors": errors})

    return Response(stream_with_context(generate()), content_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route('/api/open-folder', methods=['POST'])
def open_songs_folder():
    cfg = load_config()
    songs_path = cfg.get('songs_path', '')
    if os.path.exists(songs_path):
        try:
            os.startfile(songs_path)
            return jsonify({"ok": True})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": False, "error": "Folder not found"}), 404

@app.route('/api/open-history', methods=['POST'])
def open_history_file():
    log_path = os.path.join(CONFIG_DIR, 'download_history.txt')
    os.makedirs(CONFIG_DIR, exist_ok=True)
    if not os.path.exists(log_path):
        open(log_path, 'w').close()
    try:
        os.startfile(log_path)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route('/api/history')
def get_history_json():
    log_path = os.path.join(CONFIG_DIR, 'download_history.txt')
    history = []
    if os.path.exists(log_path):
        try:
            with open(log_path, 'r', encoding='utf-8') as hf:
                lines = hf.readlines()
                # Parse: [YYYY-MM-DD HH:MM:SS] ID: 1234 | Mirror: XYZ | File: filename.osz
                for line in reversed(lines):
                    line = line.strip()
                    if not line: continue
                    parts = line.split('] ID: ')
                    if len(parts) == 2:
                        ts = parts[0][1:]
                        rest = parts[1].split(' | ')
                        if len(rest) == 3:
                            b_id = rest[0]
                            mirror = rest[1].replace('Mirror: ', '')
                            filename = rest[2].replace('File: ', '')
                            history.append({
                                'date': ts,
                                'id': b_id,
                                'mirror': mirror,
                                'filename': filename
                            })
        except Exception:
            pass
    return jsonify({"history": history})


# ─── Entry Point ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("[*] osu! Mapper Bulk Downloader v3")
    print(f"[>] Config: {CONFIG_FILE}")
    try:
        import webview
        webview.create_window("osu! Mapper Downloader", app, width=1200, height=800,
                              min_size=(900, 600))
        webview.start()
    except ImportError:
        # Development fallback only; production builds include pywebview.
        app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False, threaded=True)
