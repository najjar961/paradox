"""Checks on Paradox Lite's static files: offline cache lists and page security headers."""
import json
import re
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "docs" / "app"


def _list(src: str, name: str) -> list[str]:
    block = src[src.index(f"const {name} = ["):]
    block = block[:block.index("];")]
    return re.findall(r'"([^"]+)"', block)


def test_offline_cache_lists_every_app_file():
    sw = (APP / "sw.js").read_text()
    vendor = sorted(p.relative_to(APP).as_posix() for p in (APP / "vendor").rglob("*")
                    if p.is_file() and p.suffix not in (".md", ".txt"))
    assert sorted(_list(sw, "VENDOR")) == vendor, "update VENDOR in sw.js and bump VENDOR_CACHE"
    for f in _list(sw, "SHELL"):
        assert f == "./" or (APP / f).is_file(), f
    for js in APP.glob("*.js"):
        if js.name != "sw.js":
            assert js.name in _list(sw, "SHELL"), f"{js.name} is not available offline"


def test_service_worker_never_touches_other_sites_or_uploads():
    sw = (APP / "sw.js").read_text()
    assert 'req.method !== "GET" || url.origin !== self.location.origin' in sw
    assert "localStorage" not in sw and "indexedDB" not in sw


def test_manifest_and_icons():
    m = json.loads((APP / "manifest.webmanifest").read_text())
    assert m["display"] == "standalone" and m["start_url"] == "./"
    for icon in m["icons"]:
        assert (APP / icon["src"]).is_file()
    assert any(i.get("purpose") == "maskable" for i in m["icons"])


def test_lite_page_keeps_its_content_security_policy():
    html = (APP / "index.html").read_text()
    csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', html).group(1)
    connect = re.search(r"connect-src ([^;]+)", csp).group(1).split()
    assert connect == ["'self'", "https://huggingface.co", "https://*.huggingface.co", "https://*.hf.co",
                       "https://raw.githubusercontent.com"]
    assert "'unsafe-inline'" not in csp and "form-action 'none'" in csp
