// Small, safe Markdown renderer for Paradox answers (both apps share this file).
// Everything the model writes is HTML-escaped first; only the tags made here are produced.
// Supports: paragraphs, line breaks, # headings, - and 1. lists, **bold**, *italic*, `code`,
// ``` code blocks, --- separators, [1] citation buttons and math via KaTeX:
// (MathML output, so no inline styles are needed and the strict Content-Security-Policy stays.)
// $$...$$ or \[...\] (display) and \(...\) or $...$ (inline).
(function () {
  "use strict";
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function math(tex, display) {
    if (window.katex) {
      try {
        return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "mathml", trust: false, strict: "ignore" });
      } catch { /* fall through */ }
    }
    return `<code class="tex">${esc(tex)}</code>`;
  }

  function inline(s) { // s is already escaped
    return s
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![\w*])/g, "$1<em>$2</em>")
      .replace(/\[(\d{1,2})\]/g, '<button class="cite" type="button" data-cite="$1">$1</button>');
  }

  function render(src) {
    const stash = [];
    const put = (html) => `\u0000${stash.push(html) - 1}\u0000`;
    let s = String(src || "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
    // Code first (nothing inside it is Markdown or math), then display math, then inline math.
    // Block-level pieces stand alone between blank lines, so they never end up inside a <p>.
    s = s.replace(/```[^\n`]*\n?([\s\S]*?)(?:```|$)/g, (m, code) => `\n\n${put(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`)}\n\n`);
    s = s.replace(/`[^`\n]+`/g, (m) => put(`<code>${esc(m.slice(1, -1))}</code>`));
    s = s.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (m, a, b) => `\n\n${put(math((a ?? b).trim(), true))}\n\n`);
    // Inline $...$: tight like $x^2$, or spaced like "$ 3x = 22 - 7 $" (small models write that) when it
    // contains a math operator, or is a lone variable. "$5 and $10" stays text: no operator, and a digit follows the second $.
    s = s.replace(/\\\(([\s\S]+?)\\\)|(^|[^\\$\w])\$(?!\$)([^$\n]+?)\$(?![\w$])/g, (m, a, pre, b) => {
      if (a != null) return put(math(a.trim(), false));
      const tight = !/^\s|\s$/.test(b);
      // A lone variable such as "$ n $" or "$ x_i $" is maths too.
      const lone = /^[A-Za-z](?:_\{?\w+\}?)?$/.test(b.trim());
      return tight || lone || /[=<>^_\\+\-*/]/.test(b) ? pre + put(math(b.trim(), false)) : m;
    });
    s = esc(s)
      .replace(/(\S)[ \t]+-{3,}[ \t]*(?=\n|$)/g, "$1\n---") // "text. ---" means a separator too
      .replace(/\n[ \t]*-{3,}[ \t]*(?=\n|$)/g, "\n\n---\n\n")
      .replace(/(\n\s*-{3,}\s*)+$/, ""); // a separator with nothing after it

    const out = [];
    for (const block of s.split(/\n{2,}/)) {
      if (!block.trim()) continue;
      if (/^\s*-{3,}\s*$/.test(block)) { out.push('<hr class="sep">'); continue; }
      if (/^\s*\u0000\d+\u0000\s*$/.test(block) && /^<(pre|span class="katex-display)/.test(stash[+block.trim().slice(1, -1)])) {
        out.push(block.trim()); continue;
      }
      const lines = block.split("\n");
      let para = [], list = null;
      const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join("<br>"))}</p>`); para = []; };
      const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; };
      for (const line of lines) {
        const h = /^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
        const ul = /^\s*[-*•]\s+(.+)$/.exec(line);
        const ol = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(line);
        if (h) { flushPara(); flushList(); out.push(`<h${Math.min(h[1].length + 2, 6)} class="md-h">${inline(h[2])}</h${Math.min(h[1].length + 2, 6)}>`); }
        else if (ul || ol) {
          flushPara();
          const tag = ul ? "ul" : "ol";
          if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
          list.items.push((ul || ol)[1]);
        } else if (list && /^\s{2,}\S/.test(line)) {
          list.items[list.items.length - 1] += "<br>" + line.trim();
        } else { flushList(); para.push(line); }
      }
      flushPara();
      flushList();
    }
    return out.join("").replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
  }

  window.pdxMarkdown = { render };
})();
