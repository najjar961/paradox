// Shows the page in English, German, French or Arabic. Follows the browser language
// or ?lang=fr; nothing is stored.
(() => {
  const LANGS = ["en", "de", "fr", "ar"];
  const TITLES = { en: "Paradox · Security", de: "Paradox · Sicherheit", fr: "Paradox · Sécurité", ar: "Paradox · الأمان" };
  const LABELS = { en: "Language", de: "Sprache", fr: "Langue", ar: "اللغة" };
  const wanted = new URLSearchParams(location.search).get("lang");
  const browser = (navigator.languages || [navigator.language]).map((l) => String(l).slice(0, 2).toLowerCase());
  let lang = LANGS.includes(wanted) ? wanted : (browser.find((l) => LANGS.includes(l)) || "en");
  const select = document.getElementById("lang");
  function show() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    LANGS.forEach((l) => { document.getElementById(l).hidden = l !== lang; });
    document.title = TITLES[lang];
    document.querySelectorAll("[data-en]").forEach((el) => { el.textContent = el.dataset[lang] || el.dataset.en; });
    select.value = lang;
    select.setAttribute("aria-label", LABELS[lang]);
    // Links to the app carry the language along.
    document.querySelectorAll('a[href^="app/"], a[href="./"], a[data-href]').forEach((a) => {
      if (!a.dataset.href) a.dataset.href = a.getAttribute("href");
      const u = new URL(a.dataset.href, location.href);
      u.searchParams.set("lang", lang);
      a.href = u.href;
    });
  }
  select.addEventListener("change", () => {
    lang = select.value;
    const u = new URL(location.href);
    u.searchParams.set("lang", lang);
    history.replaceState(null, "", u);
    show();
  });
  show();
})();
