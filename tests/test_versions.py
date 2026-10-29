"""The page, app.js and tools.js must carry the same release number, or every start reloads once."""
import re
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "docs" / "app"


def test_release_numbers_match():
    page = re.search(r'name="paradox-version" content="(\w+)"', (APP / "index.html").read_text()).group(1)
    app = re.search(r'const APP_VERSION = "(\w+)"', (APP / "app.js").read_text()).group(1)
    tools = re.search(r'export const VERSION = "(\w+)"', (APP / "tools.js").read_text()).group(1)
    assert page == app == tools, (page, app, tools)
