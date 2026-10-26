// Shows the German (legally binding) or English version. Follows ?lang= or the browser; nothing is stored.
(() => {
  const wanted = new URLSearchParams(location.search).get("lang");
  const browser = (navigator.languages || [navigator.language]).map((l) => String(l).slice(0, 2).toLowerCase());
  let lang = wanted === "de" || wanted === "en" ? wanted : (browser.find((l) => l === "de" || l === "en") || (browser[0] === "de" ? "de" : "en"));
  const select = document.getElementById("lang");
  function show() {
    document.documentElement.lang = lang;
    document.getElementById("de").hidden = lang !== "de";
    document.getElementById("en").hidden = lang !== "en";
    document.title = lang === "de" ? "Paradox · Impressum & Datenschutz" : "Paradox · Legal notice & privacy";
    document.querySelectorAll("[data-de]").forEach((el) => { el.textContent = el.dataset[lang]; });
    select.value = lang;
    document.querySelectorAll('a[href^="app/"], a[href="./"]').forEach((a) => {
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
