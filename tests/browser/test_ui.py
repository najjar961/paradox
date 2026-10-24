"""Browser tests: both apps driven in a real Chromium, with stand-in AI models.

Run with:  pip install playwright && python -m playwright install chromium
           python -m pytest tests/browser -q
They are skipped when Playwright or its browser is missing.
"""
from __future__ import annotations

import functools
import http.server
import socket
import threading
import time
from dataclasses import replace
from pathlib import Path

import bcrypt
import pytest

pw = pytest.importorskip("playwright.sync_api")

ROOT = Path(__file__).resolve().parents[2]
OLD = """Mietvertrag

Die Miete beträgt 1.200 EUR pro Monat und ist am 1. jedes Monats fällig.

Die Kündigungsfrist beträgt drei Monate.

Haustiere sind nicht erlaubt.

Der Vertrag beginnt am 1. Januar 2026."""
NEW = OLD.replace("1.200", "1.350").replace("drei Monate", "sechs Monate").replace(
    "Haustiere sind nicht erlaubt.\n\n", "") + "\n\nEine Kaution von zwei Monatsmieten ist zu leisten."


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def browser():
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as exc:  # browser not installed
            pytest.skip(f"Chromium not available: {exc}")
        yield b
        b.close()


@pytest.fixture(scope="module")
def site():
    """Serves docs/ like GitHub Pages does."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    handler = functools.partial(Quiet, directory=str(ROOT / "docs"))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", _free_port()), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    """The self-hosted app with offline stand-in models."""
    import uvicorn
    from app.config import Settings
    from app.main import create_app
    users = tmp_path_factory.mktemp("cfg") / "users.yaml"
    users.write_text(f'users:\n  alice: "{bcrypt.hashpw(b"alice-password", bcrypt.gensalt(4)).decode()}"\n')
    s = replace(Settings(), users_file=str(users), llm_provider="echo", embed_provider="hash", cookie_secure=False)
    port = _free_port()
    srv = uvicorn.Server(uvicorn.Config(create_app(s), host="127.0.0.1", port=port, log_level="warning", access_log=False))
    threading.Thread(target=srv.run, daemon=True).start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True


@pytest.fixture()
def files(tmp_path):
    a, b = tmp_path / "vertrag_v1.txt", tmp_path / "vertrag_v2.txt"
    a.write_text(OLD)
    b.write_text(NEW)
    return [str(a), str(b)]


def page_for(browser, locale="en-US", width=1280):
    ctx = browser.new_context(viewport={"width": width, "height": 860}, locale=locale, accept_downloads=True)
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    # Downloads from other sites (search model, web fonts) may be blocked where tests run;
    # everything else must log no errors.
    noise = ("Failed to fetch", "401", "ERR_TUNNEL_CONNECTION_FAILED", "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION")
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error"
            and not any(n in m.text for n in noise) else None)
    return page


# ---------------------------------------------------------------- Paradox Lite

def test_lite_compare_edit_and_export(browser, site, files):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest")
    pg.click("#load-model")
    pg.locator("#model-ready").wait_for()
    pg.set_input_files("#file-input", files)
    pg.locator("#doc-list .doc-tools").nth(1).wait_for()

    pg.fill("#chat-input", "What changed between the two versions?")
    pg.keyboard.press("Enter")
    pg.locator(".msg.assistant .actions").first.wait_for()
    assert "4 passages" in pg.inner_text(".msg.assistant .text")
    pg.locator(".source-chip", has_text="show differences").click()
    assert pg.inner_text(".cmp-stats").startswith("4 changed passages")
    assert pg.locator(".cmp-view del").all_inner_texts()[:1] == ["1.200"]
    assert pg.locator(".cmp-view ins").all_inner_texts()[:1] == ["1.350"]
    pg.click("#modal-close")

    if pg.is_visible("#keep-layout"):
        pg.uncheck("#keep-layout")
    pg.fill("#chat-input", "Rewrite the contract more formally")
    pg.keyboard.press("Enter")
    pg.locator(".msg.assistant .actions").nth(1).wait_for()
    with pg.expect_download() as dl:
        pg.locator(".msg.assistant").nth(1).locator(".actions button", has_text="PDF").click()
    assert dl.value.suggested_filename.endswith(".pdf")
    assert not pg.errors, pg.errors


def test_lite_stop_button(browser, site):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest")
    pg.click("#load-model")
    pg.locator("#model-ready").wait_for()
    pg.fill("#chat-input", "Hello")
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(120)
    assert pg.inner_text("#send") == "Stop"
    pg.click("#send")
    pg.locator(".stopped").wait_for()
    assert pg.inner_text("#send") == "Send"


def test_lite_german_and_switch_keeps_documents(browser, site, files):
    pg = page_for(browser, locale="de-DE")
    pg.goto(f"{site}/app/#selftest")
    assert pg.get_attribute("html", "lang") == "de"
    assert pg.inner_text("#load-model") == "Herunterladen & starten"
    pg.set_input_files("#file-input", files)
    pg.locator("#doc-list .doc-tools").nth(1).wait_for()
    assert pg.locator(".doc-tools button").first.inner_text() == "Vergleichen"
    pg.select_option("#lang", "en")
    assert pg.inner_text("#load-model") == "Download & start"
    assert "lang=en" in pg.url
    assert pg.locator("#doc-list .name").all_inner_texts() == ["vertrag_v1.txt", "vertrag_v2.txt"]
    assert not pg.errors, pg.errors


def test_lite_arabic_is_right_to_left_and_french_translates(browser, site):
    pg = page_for(browser, locale="ar-LB")
    pg.goto(f"{site}/app/#selftest")
    assert pg.get_attribute("html", "lang") == "ar"
    assert pg.get_attribute("html", "dir") == "rtl"
    pg.select_option("#lang", "fr")
    assert pg.get_attribute("html", "dir") == "ltr"
    assert "lang=fr" in pg.url
    assert pg.inner_text("#load-model") != "Download & start"
    assert not pg.errors, pg.errors


def test_task_chip_fills_the_question(browser, site):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest")
    pg.click("#load-model")
    pg.locator("#model-ready").wait_for()
    pg.locator("#tasks button:not(.quiz-chip)").first.click()
    assert pg.input_value("#chat-input").strip() != ""
    assert not pg.errors, pg.errors


def test_lite_works_offline_after_first_visit(browser, site, files):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest")
    pg.evaluate("navigator.serviceWorker.ready.then(() => true)")  # wait until the offline cache is installed
    pg.click("#load-model")
    pg.locator("#model-ready").wait_for()
    pg.locator("#toast", has_text="offline").wait_for(timeout=60000)
    pg.context.set_offline(True)
    pg.reload()
    pg.locator("#offline").wait_for()
    pg.click("#load-model")
    pg.locator("#model-ready").wait_for()
    pg.set_input_files("#file-input", files)
    pg.locator("#doc-list .doc-tools").nth(1).wait_for()
    pg.fill("#chat-input", "what changed?")
    pg.keyboard.press("Enter")
    pg.locator(".msg.assistant .actions").first.wait_for()
    pg.context.set_offline(False)


def test_static_pages_load_cleanly_on_phones(browser, site):
    for path in ["/", "/security.html", "/app/"]:
        for locale in ["en-US", "de-DE", "fr-FR", "ar-LB"]:
            pg = page_for(browser, locale=locale, width=390)
            pg.goto(site + path)
            pg.wait_for_timeout(300)
            assert pg.evaluate("document.documentElement.scrollWidth") <= 390, (path, locale)
            assert not pg.errors, (path, pg.errors)
            pg.context.close()


# ---------------------------------------------------------------- self-hosted app

def test_server_login_fits_phones_in_every_language(browser, server):
    for locale in ["en-US", "de-DE", "fr-FR", "ar-LB"]:
        pg = page_for(browser, locale=locale, width=390)
        pg.goto(server)
        pg.wait_for_timeout(200)
        assert pg.evaluate("document.documentElement.scrollWidth") <= 390, locale
        assert not pg.errors, (locale, pg.errors)
        pg.context.close()

def test_server_app_login_chat_compare_in_german(browser, server, files):
    pg = page_for(browser, locale="de-DE")
    pg.goto(server)
    assert pg.inner_text("#login-form button[type=submit]") == "Anmelden"
    pg.fill("input[name=username]", "alice")
    pg.fill("input[name=password]", "wrong")
    pg.keyboard.press("Enter")
    pg.locator("#login-error", has_text="falsch").wait_for()
    pg.fill("input[name=password]", "alice-password")
    pg.keyboard.press("Enter")
    pg.locator("#ws-title", has_text="Mein Arbeitsbereich").wait_for()

    pg.set_input_files("#file-input", files)
    pg.locator("#doc-count", has_text="2").wait_for()
    pg.fill("#chat-input", "Was hat sich geändert?")
    pg.keyboard.press("Enter")
    pg.locator(".msg.assistant .actions").first.wait_for()
    assert "4 change(s)" in pg.inner_text(".msg.assistant .text")
    pg.locator(".source-chip", has_text="Unterschiede zeigen").click()
    pg.locator(".cmp-stats", has_text="4 geänderte Stellen").wait_for()
    pg.click("#modal-close")

    pg.click("#logout")
    pg.locator("#login-error", has_text="gelöscht").wait_for()
    assert not pg.errors, pg.errors


def test_markdown_renders_spaced_math_but_not_prices(browser, site):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest")
    render = lambda s: pg.evaluate("s => window.pdxMarkdown.render(s)", s)
    assert "<math" in render("Subtrahiere 7: $ 3x = 22 - 7 $.")
    assert "<math" not in render("It costs $5 and $10.")
    assert "<math" not in render("From $5 - $10.")
    assert "---" not in render("Die Lösung ist $ x = 5 $. ---")
    assert '<hr class="sep">' in render("New text\n---\nChanged the tone")


def test_quiz_me_makes_practice_questions_from_notes(browser, site, files):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest")
    pg.click("#load-model")
    pg.locator("#model-ready").wait_for()
    pg.locator(".quiz-chip").click()
    pg.locator("#toast", has_text="notes").wait_for()  # nothing to quiz on yet
    pg.set_input_files("#file-input", files)
    pg.locator("#doc-list .doc-tools").nth(1).wait_for()
    pg.locator(".quiz-chip").click()
    pg.locator(".quiz-card").nth(2).wait_for()
    assert pg.locator(".quiz-card").count() == 3
    assert pg.locator(".quiz-answer:visible").count() == 0
    card = pg.locator(".quiz-card").first
    card.get_by_role("button", name="Show answer").click()
    assert card.locator(".quiz-answer").is_visible()
    card.get_by_role("button", name="I knew it").click()
    assert pg.inner_text(".quiz-score") == "1 of 3 known"
    for i in (1, 2):
        c = pg.locator(".quiz-card").nth(i)
        c.get_by_role("button", name="Show answer").click()
        c.get_by_role("button", name="Not yet").click()
    pg.get_by_role("button", name="Practise the ones I missed").click()
    pg.locator(".msg.quiz").nth(1).locator(".quiz-card").first.wait_for()
    assert not pg.errors, pg.errors
