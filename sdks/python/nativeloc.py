"""NativeLoc runtime SDK for Linux devices (Qt, GTK, kiosks, embedded panels).

Single file, standard library only, Python 3.8+.

    from nativeloc import NativeLoc
    loc = NativeLoc("https://loc.example.com", "pb_xxx", locale="es",
                    cache_dir="/var/cache/myapp/nativeloc")
    loc.t("cart_items", arg1=3)          # -> "3 artículos en tu carrito"
    loc.start_polling(300)               # re-check every 5 minutes (cheap: HTTP 304)

Lookup order for ``t(key)``: downloaded bundle for the locale -> bundled fallback for the
locale -> source-language bundle -> the key itself. ``t`` never raises.
"""
from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
import uuid
from typing import Callable, Dict, List, Optional

__all__ = ["NativeLoc", "format_message", "plural_category", "capture_context"]

Bundle = Dict[str, str]


# --------------------------------------------------------------------------- plurals

def _ivf(n: float):
    """CLDR operands: integer part, number of visible fraction digits."""
    s = repr(float(n)).rstrip("0").rstrip(".") if not float(n).is_integer() else str(int(n))
    i = int(abs(float(n)))
    v = len(s.split(".")[1]) if "." in s else 0
    return i, v


def plural_category(locale: str, n: float) -> str:
    """CLDR cardinal plural category for common languages."""
    lang = locale.replace("_", "-").split("-")[0].lower()
    i, v = _ivf(n)
    millions = v == 0 and i != 0 and i % 1_000_000 == 0
    if lang in ("ja", "zh", "ko", "th", "vi", "id", "ms", "lo", "my"):
        return "other"
    if lang == "fr" or (lang == "pt" and locale.replace("_", "-") != "pt-PT"):
        if i in (0, 1):
            return "one"
        return "many" if millions else "other"
    if lang in ("es", "it", "ca", "pt"):
        if n == 1 and v == 0:
            return "one"
        return "many" if millions else "other"
    if lang in ("ru", "uk", "be"):
        if v != 0:
            return "other"
        if i % 10 == 1 and i % 100 != 11:
            return "one"
        if 2 <= i % 10 <= 4 and not 12 <= i % 100 <= 14:
            return "few"
        return "many"
    if lang == "pl":
        if v != 0:
            return "other"
        if i == 1:
            return "one"
        if 2 <= i % 10 <= 4 and not 12 <= i % 100 <= 14:
            return "few"
        return "many"
    if lang in ("cs", "sk"):
        if v != 0:
            return "many"
        if i == 1:
            return "one"
        return "few" if 2 <= i <= 4 else "other"
    if lang == "ar":
        if n == 0:
            return "zero"
        if n == 1:
            return "one"
        if n == 2:
            return "two"
        if v == 0 and 3 <= i % 100 <= 10:
            return "few"
        if v == 0 and 11 <= i % 100 <= 99:
            return "many"
        return "other"
    if lang == "he":
        if (i == 1 and v == 0) or (i == 0 and v != 0):
            return "one"
        return "two" if i == 2 and v == 0 else "other"
    return "one" if i == 1 and v == 0 else "other"


# --------------------------------------------------------------------------- ICU formatter

class _Parser:
    """Minimal ICU MessageFormat: text, {arg}, {arg, number}, plural/selectordinal/select, #."""

    def __init__(self, src: str):
        self.s = src
        self.i = 0

    def parse(self, in_plural: bool = False, depth: int = 0) -> list:
        out: list = []
        buf = []
        while self.i < len(self.s):
            c = self.s[self.i]
            if c == "'":
                nxt = self.s[self.i + 1] if self.i + 1 < len(self.s) else ""
                if nxt == "'":
                    buf.append("'")
                    self.i += 2
                elif nxt in "{}" or (in_plural and nxt == "#"):
                    end = self.s.find("'", self.i + 1)
                    end = len(self.s) if end < 0 else end
                    buf.append(self.s[self.i + 1:end])
                    self.i = end + 1
                else:
                    buf.append("'")
                    self.i += 1
            elif c == "{":
                if buf:
                    out.append("".join(buf))
                    buf = []
                out.append(self._argument(depth))
            elif c == "}":
                if depth > 0:
                    break
                buf.append(c)
                self.i += 1
            elif c == "#" and in_plural:
                if buf:
                    out.append("".join(buf))
                    buf = []
                out.append(("#",))
                self.i += 1
            else:
                buf.append(c)
                self.i += 1
        if buf:
            out.append("".join(buf))
        return out

    def _word(self) -> str:
        self._ws()
        start = self.i
        while self.i < len(self.s) and self.s[self.i] not in ",}{ \t\n":
            self.i += 1
        return self.s[start:self.i]

    def _ws(self):
        while self.i < len(self.s) and self.s[self.i].isspace():
            self.i += 1

    def _expect(self, ch: str):
        self._ws()
        if self.i >= len(self.s) or self.s[self.i] != ch:
            raise ValueError("expected %r at %d" % (ch, self.i))
        self.i += 1

    def _argument(self, depth: int):
        self._expect("{")
        name = self._word()
        self._ws()
        if self.s[self.i] == "}":
            self.i += 1
            return ("arg", name)
        self._expect(",")
        kind = self._word()
        self._ws()
        if kind in ("plural", "selectordinal", "select"):
            self._expect(",")
            offset = 0
            options = {}
            while True:
                self._ws()
                if self.s[self.i] == "}":
                    self.i += 1
                    break
                sel = self._word()
                if sel.startswith("offset:"):
                    offset = int(sel[7:] or self._word())
                    continue
                self._expect("{")
                options[sel] = self.parse(in_plural=kind != "select", depth=depth + 1)
                self._expect("}")
            return (kind, name, options, offset)
        style = ""
        if self.s[self.i] == ",":
            self.i += 1
            start = self.i
            while self.s[self.i] != "}":
                self.i += 1
            style = self.s[start:self.i].strip()
        self._expect("}")
        return ("fmt", name, kind, style)


def _render(nodes: list, args: dict, locale: str, number=None) -> str:
    out = []
    for node in nodes:
        if isinstance(node, str):
            out.append(node)
        elif node[0] == "#":
            out.append(_num(number))
        elif node[0] == "arg":
            out.append(str(args.get(node[1], "{%s}" % node[1])))
        elif node[0] == "fmt":
            val = args.get(node[1], "{%s}" % node[1])
            out.append(_num(val) if node[2] == "number" and isinstance(val, (int, float)) else str(val))
        elif node[0] in ("plural", "selectordinal"):
            _, name, options, offset = node
            n = args.get(name, 0)
            try:
                n = float(n)
            except (TypeError, ValueError):
                n = 0
            exact = "=%s" % (int(n) if float(n).is_integer() else n)
            if exact in options:
                branch = options[exact]
            else:
                cat = plural_category(locale, n - offset) if node[0] == "plural" else "other"
                branch = options.get(cat, options.get("other", []))
            out.append(_render(branch, args, locale, n - offset))
        elif node[0] == "select":
            _, name, options, _ = node
            branch = options.get(str(args.get(name, "other")), options.get("other", []))
            out.append(_render(branch, args, locale, number))
    return "".join(out)


def _num(n) -> str:
    if isinstance(n, float) and n.is_integer():
        n = int(n)
    return str(n) if n is not None else "#"


def format_message(message: str, args: Optional[dict] = None, locale: str = "en") -> str:
    """Format an ICU message. Returns the raw message if it cannot be parsed."""
    try:
        return _render(_Parser(message).parse(), args or {}, locale)
    except (ValueError, IndexError):
        return message


# --------------------------------------------------------------------------- client

class NativeLoc:
    def __init__(self, base_url: str, bundle_token: str, locale: str,
                 cache_dir: Optional[str] = None, fallback: Optional[Dict[str, Bundle]] = None,
                 timeout: float = 5.0):
        self.base_url = base_url.rstrip("/")
        self.bundle_token = bundle_token
        self.locale = locale
        self.cache_dir = cache_dir
        self.fallback = fallback or {}
        self.timeout = timeout
        self.version = 0
        self.source_locale: Optional[str] = None
        self._bundles: Dict[str, Bundle] = {}
        self._shas: Dict[str, str] = {}
        self._etag: Optional[str] = None
        self._listeners: List[Callable[[], None]] = []
        self._lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None
        self._load_cache()
        try:
            self.refresh()
        except (OSError, ValueError):
            pass  # offline: cached or bundled text keeps the device working

    # -- cache ------------------------------------------------------------------
    def _path(self, name: str) -> Optional[str]:
        return os.path.join(self.cache_dir, name + ".json") if self.cache_dir else None

    def _read(self, name: str):
        p = self._path(name)
        if not p or not os.path.exists(p):
            return None
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _write(self, name: str, data) -> None:
        p = self._path(name)
        if not p:
            return
        os.makedirs(self.cache_dir, exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, p)  # atomic: never a half-written bundle after a power cut

    def _load_cache(self) -> None:
        meta = self._read("meta") or {}
        self.source_locale = meta.get("sourceLocale")
        self.version = meta.get("version", 0)
        self._etag = meta.get("etag")
        for loc in self._wanted():
            entry = self._read("bundle_" + loc)
            if entry:
                self._bundles[loc] = entry["bundle"]
                self._shas[loc] = entry["sha256"]

    def _wanted(self) -> List[str]:
        return [l for l in dict.fromkeys([self.locale, self.source_locale]) if l]

    # -- network ----------------------------------------------------------------
    def _get(self, url: str, etag: Optional[str] = None):
        req = urllib.request.Request(url, headers={"If-None-Match": etag} if etag else {})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                return res.status, res.headers.get("ETag"), res.read()
        except urllib.error.HTTPError as e:
            if e.code == 304:
                return 304, etag, b""
            raise

    def refresh(self) -> bool:
        """Check for a newer published version. Returns True when strings changed."""
        have_all = all(l in self._bundles for l in self._wanted())
        status, etag, body = self._get("%s/b/%s/manifest.json" % (self.base_url, self.bundle_token),
                                       self._etag if have_all else None)
        if status == 304:
            return False
        manifest = json.loads(body.decode("utf-8"))
        changed = False
        with self._lock:
            self.source_locale = manifest["sourceLocale"]
            for loc in self._wanted():
                info = manifest["locales"].get(loc)
                if not info or (self._shas.get(loc) == info["sha256"] and loc in self._bundles):
                    continue
                _, _, raw = self._get(self.base_url + info["url"])
                self._bundles[loc] = json.loads(raw.decode("utf-8"))
                self._shas[loc] = info["sha256"]
                self._write("bundle_" + loc, {"sha256": info["sha256"], "bundle": self._bundles[loc]})
                changed = True
            self._etag = etag
            self.version = manifest["version"]
            self._write("meta", {"sourceLocale": self.source_locale, "version": self.version, "etag": etag})
        if changed:
            for fn in list(self._listeners):
                fn()
        return changed

    def set_locale(self, locale: str) -> None:
        self.locale = locale
        entry = self._read("bundle_" + locale)
        if entry:
            self._bundles[locale] = entry["bundle"]
            self._shas[locale] = entry["sha256"]
        try:
            self.refresh()
        except (OSError, ValueError):
            pass
        for fn in list(self._listeners):
            fn()

    def on_change(self, fn: Callable[[], None]) -> None:
        """Called (from the polling thread) when new strings arrive; re-render your UI."""
        self._listeners.append(fn)

    def start_polling(self, seconds: float = 300) -> None:
        def tick():
            try:
                self.refresh()
            except (OSError, ValueError):
                pass
            self.start_polling(seconds)
        self.stop_polling()
        self._timer = threading.Timer(seconds, tick)
        self._timer.daemon = True
        self._timer.start()

    def stop_polling(self) -> None:
        if self._timer:
            self._timer.cancel()

    # -- lookup -----------------------------------------------------------------
    def t(self, key: str, **args) -> str:
        loc = self.locale
        src = self.source_locale or next((l for l in self.fallback if l != loc), loc)
        for bundle, lang in ((self._bundles.get(loc), loc), (self.fallback.get(loc), loc),
                             (self._bundles.get(src), src), (self.fallback.get(src), src)):
            if bundle and key in bundle:
                return format_message(bundle[key], args, lang)
        return key


def capture_context(base_url: str, project_id: int, push_token: str, image_path: str,
                    label: str, keys: List[dict]) -> dict:
    """Upload a screenshot with the keys on it ([{"key": ..., "x":, "y":, "w":, "h":}], pixels).

    Needs a project API token with the "push" scope; use from dev/test devices only.
    """
    boundary = uuid.uuid4().hex
    with open(image_path, "rb") as f:
        image = f.read()
    ctype = "image/png" if image_path.lower().endswith(".png") else "image/jpeg"
    parts = []
    for name, value in (("label", label), ("keys", json.dumps(keys))):
        parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, name, value)).encode("utf-8"))
    parts.append(('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\nContent-Type: %s\r\n\r\n'
                  % (boundary, os.path.basename(image_path), ctype)).encode("utf-8") + image + b"\r\n")
    parts.append(("--%s--\r\n" % boundary).encode("utf-8"))
    req = urllib.request.Request(
        "%s/api/v1/projects/%d/screenshots" % (base_url.rstrip("/"), project_id),
        data=b"".join(parts), method="POST",
        headers={"Authorization": "Bearer " + push_token,
                 "Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))
