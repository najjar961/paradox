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
    assert "<math" in render("where $ n $ is the number of values")
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


def test_best_model_is_default_and_falls_back_when_the_card_is_too_small(browser, site):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest-oom")
    assert pg.input_value("#model-select") == "best"
    pg.click("#load-model")
    pg.locator("#model-ready").wait_for()
    assert pg.input_value("#model-select") == "fast"
    assert "1.7B" in pg.inner_text("#model-ready")
    assert not pg.errors, pg.errors


def test_phones_default_to_the_small_model(browser, site):
    ctx = browser.new_context(viewport={"width": 390, "height": 800},
                              user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")
    pg = ctx.new_page()
    pg.goto(f"{site}/app/#selftest")
    assert pg.input_value("#model-select") == "fast"


def test_slow_answers_suggest_a_smaller_model_once(browser, site):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest-slow")
    pg.click("#load-model")
    pg.locator("#model-ready").wait_for()
    for n in range(2):
        pg.fill("#chat-input", "Hello")
        pg.keyboard.press("Enter")
        pg.locator(".msg.assistant .actions").nth(n).wait_for()
        pg.wait_for_function("() => document.querySelector('#send').textContent === 'Send'")
    assert pg.locator(".speed-hint").count() == 1  # asked once, not after every answer
    pg.get_by_role("button", name="Switch to Balanced · Qwen3 4B").click()
    pg.locator("#model-ready", has_text="4B").wait_for()
    assert pg.input_value("#model-select") == "balanced"
    assert not pg.errors, pg.errors


def test_privacy_meter_shows_zero_bytes_and_every_site(browser, site, files):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest")
    pg.set_input_files("#file-input", files)
    pg.locator("#doc-list .doc-tools").nth(1).wait_for()
    pg.locator("#meter-hosts", has_text="this app").wait_for()  # the meter refreshes a moment later
    assert pg.inner_text("#meter-sent") == "0 bytes"
    pg.click("#meter-details")
    assert "This app's own files" in pg.inner_text("#modal-body")
    assert not pg.errors, pg.errors


def test_privacy_meter_catches_data_sent_from_page_and_workers(browser, site):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest")
    pg.evaluate("navigator.serviceWorker.ready.then(() => true)")
    pg.reload()
    pg.wait_for_function("() => !!navigator.serviceWorker.controller")
    # From the page itself: 6 bytes.
    pg.evaluate("fetch('index.html', { method: 'POST', body: 'secret' }).catch(() => {})")
    pg.locator("#meter-sent", has_text="6 bytes").wait_for()
    # From a background worker: 4 more bytes, seen by the offline helper.
    pg.evaluate("""new Worker(URL.createObjectURL(new Blob(
        ["fetch('" + new URL('index.html', location.href) + "', { method: 'POST', body: 'data' }).catch(() => {})"],
        { type: 'text/javascript' })))""")
    pg.locator("#meter-sent", has_text="10 bytes").wait_for()
    assert "alert" in pg.get_attribute("#meter", "class")


def test_sample_notes_start_a_quiz(browser, site):
    pg = page_for(browser, locale="de-DE")
    pg.goto(f"{site}/app/#selftest")
    pg.click("#load-model")
    pg.locator("#model-ready").wait_for()
    pg.locator("#empty .try-sample").click()
    pg.locator("#doc-list .name", has_text="beispiel-statistik-vorlesung.md").wait_for()
    pg.locator(".quiz-card").first.wait_for()
    assert "Vorlesung 3" in pg.inner_text(".quiz-card")
    assert not pg.errors, pg.errors


def test_first_visit_starts_small_and_switches_to_best_in_the_background(browser, site):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest-bg")
    assert pg.input_value("#model-select") == "best"
    pg.click("#load-model")
    pg.locator("#model-ready", has_text="Fast · Qwen3 1.7B is ready.").wait_for()
    pg.locator("#bg-model", has_text="in the background").wait_for()
    pg.locator("#model-ready", has_text="Best · Qwen3 8B is ready.").wait_for()
    assert pg.input_value("#model-select") == "best"
    assert pg.locator("#bg-model").is_hidden()
    assert not pg.errors, pg.errors


def test_background_download_can_be_stopped(browser, site):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest-bg")
    pg.click("#load-model")
    pg.locator("#bg-model", has_text="in the background").wait_for()
    pg.click("#bg-stop")
    assert pg.locator("#bg-model").is_hidden()
    pg.wait_for_timeout(1500)
    assert "1.7B" in pg.inner_text("#model-ready")
    assert not pg.errors, pg.errors


def test_best_model_that_does_not_fit_keeps_the_small_one(browser, site):
    pg = page_for(browser)
    pg.goto(f"{site}/app/#selftest-oom")
    pg.click("#load-model")
    pg.locator("#toast", has_text="doesn't fit").wait_for()
    pg.locator("#model-ready", has_text="Fast · Qwen3 1.7B is ready.").wait_for()
    assert pg.input_value("#model-select") == "fast"
    assert not pg.errors, pg.errors


def test_start_and_security_pages_contact_no_other_site(browser, site):
    for path in ["/", "/security.html"]:
        pg = page_for(browser)
        hosts = set()
        pg.on("request", lambda r: hosts.add(r.url.split("/")[2]))
        pg.goto(site + path)
        pg.wait_for_load_state("networkidle")
        own = site.split("/")[2]
        assert hosts == {own}, (path, hosts)
        # the fonts really come from this site
        if path == "/":
            assert pg.evaluate("document.fonts.check('800 20px \"Bricolage Grotesque\"')")
        pg.context.close()
