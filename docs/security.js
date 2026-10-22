// Shows the English or German version. Follows the browser language or ?lang=de;
// nothing is stored.
(() => {
  const wanted = new URLSearchParams(location.search).get("lang");
  const browser = (navigator.languages || [navigator.language]).map((l) => String(l).slice(0, 2).toLowerCase());
  let lang = ["de", "en"].includes(wanted) ? wanted : (browser.find((l) => l === "de" || l === "en") || "en");
  const btn = document.getElementById("lang");
  function show() {
    document.documentElement.lang = lang;
    document.getElementById("en").hidden = lang !== "en";
    document.getElementById("de").hidden = lang !== "de";
    document.title = lang === "de" ? "Paradox · Sicherheit" : "Paradox · Security";
    document.querySelectorAll("[data-en]").forEach((el) => { el.textContent = el.dataset[lang]; });
    btn.textContent = lang === "de" ? "EN" : "DE";
    btn.setAttribute("aria-label", lang === "de" ? "Language: English" : "Sprache: Deutsch");
    // Links to the app carry the language along.
    document.querySelectorAll('a[href^="app/"], a[href="./"], a[data-href]').forEach((a) => {
      if (!a.dataset.href) a.dataset.href = a.getAttribute("href");
      const u = new URL(a.dataset.href, location.href);
      u.searchParams.set("lang", lang);
      a.href = u.href;
    });
  }
  btn.addEventListener("click", () => {
    lang = lang === "de" ? "en" : "de";
    const u = new URL(location.href);
    u.searchParams.set("lang", lang);
    history.replaceState(null, "", u);
    show();
  });
  show();
})();
