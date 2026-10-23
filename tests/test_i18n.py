"""Every interface text has a German translation, in both apps."""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
I18N = ROOT / "docs" / "app" / "i18n.js"


def dictionary(name: str = "DE") -> dict:
    src = I18N.read_text()
    start = src.index(f"const {name} = {{") + len(f"const {name} = ")
    body = src[start:src.index("\n  };", start) + 4]
    # The dictionary is plain JSON apart from comments and trailing commas.
    body = re.sub(r"^\s*//.*$", "", body, flags=re.M)
    body = re.sub(r",(\s*})", r"\1", body)

    def no_duplicates(pairs):
        keys = [k for k, _ in pairs]
        dupes = {k for k in keys if keys.count(k) > 1}
        assert not dupes, f"duplicate keys: {dupes}"
        return dict(pairs)
    return json.loads(body, object_pairs_hook=no_duplicates)


def german_keys() -> dict:
    return dictionary("DE")


LANGS = ["DE", "FR", "AR"]


def squash(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def ui_keys() -> set:
    keys = set()
    for js in ["docs/app/app.js", "app/static/app.js"]:
        src = (ROOT / js).read_text()
        keys |= {json.loads(f'"{k}"') for k in re.findall(r'\b(?:tr|toast|loadLabel|openModal|showLogin|setStatus|new Error)\("((?:[^"\\]|\\.)*)"', src)}
        tasks = src[src.index("const TASKS = ["):src.index("];", src.index("const TASKS = ["))]
        keys |= {json.loads(f'"{k}"') for k in re.findall(r'"((?:[^"\\]|\\.)*)"', tasks)}
    for page in ["docs/app/index.html", "app/static/index.html", "docs/index.html"]:
        src = (ROOT / page).read_text()
        for tag, kind, inner in re.findall(r"<(\w+)[^>]*?\sdata-i18n(-html)?(?=[\s>])[^>]*>(.*?)</\1>", src, re.S):
            keys.add(squash(inner) if kind else html.unescape(squash(re.sub(r"<[^>]+>", "", inner))))
        for m in re.finditer(r'<[^>]*data-i18n-attr="([^"]+)"[^>]*>', src):
            for attr in m.group(1).split(","):
                keys.add(html.unescape(re.search(rf'\s{attr}="([^"]*)"', m.group(0)).group(1)))
    layout = (ROOT / "docs/app/layout.js").read_text()
    labels = layout[layout.index("PII_LABELS"):layout.index("};", layout.index("PII_LABELS"))]
    keys |= set(re.findall(r':\s*"([^"]+)"', labels))
    app = (ROOT / "docs/app/app.js").read_text()
    models = app[app.index("const MODELS"):app.index("];", app.index("const MODELS"))]
    keys |= set(re.findall(r'(?:label|note): "([^"]+)"', models))
    return keys


def test_both_apps_share_one_dictionary():
    assert (ROOT / "app/static/i18n.js").read_bytes() == I18N.read_bytes()


def test_every_interface_text_is_translated():
    internal = {"no adapter", "unauthorised"}  # error codes that are never shown
    for lang in LANGS:
        d = dictionary(lang)
        missing = sorted(k for k in ui_keys() - internal if k not in d)
        assert not missing, f"No {lang} for:\n" + "\n".join(missing)


def test_all_languages_have_the_same_keys():
    de = set(dictionary("DE"))
    for lang in LANGS[1:]:
        assert set(dictionary(lang)) == de, lang


def test_placeholders_and_plurals_match():
    for lang in LANGS:
        for en, tr in dictionary(lang).items():
            assert sorted(re.findall(r"\{\w+\}", en)) == sorted(re.findall(r"\{\w+\}", tr)), (lang, en)
            assert en.count("|") == tr.count("|"), (lang, en)
            assert sorted(re.findall(r"</?\w+", en)) == sorted(re.findall(r"</?\w+", tr)), (lang, en)
