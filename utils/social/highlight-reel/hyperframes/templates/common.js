// Shared helpers for all HyperFrames cards (deterministic: no randomness, no network).
const C = window.CARD || {};
for (const [k, v] of Object.entries(C.colors || {})) {
  document.documentElement.style.setProperty("--" + k.replace(/_/g, "-"), v);
}
const $ = (id) => document.getElementById(id);
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
// shrink font-size until the element's natural width fits maxW
function fit(node, maxW, start, min) {
  let s = start;
  node.style.fontSize = s + "px";
  while (node.scrollWidth > maxW && s > min) { s -= 2; node.style.fontSize = s + "px"; }
  return s;
}
function crestImgs(list, h) {
  const wrap = el("div");
  wrap.style.cssText = "display:flex;justify-content:center;align-items:center;gap:44px;height:" + h + "px";
  list.forEach((src, i) => {
    if (i > 0) {
      const d = el("div");
      d.style.cssText = "width:2px;height:" + Math.round(h * 0.8) + "px;background:var(--gold-accent);opacity:.8";
      wrap.appendChild(d);
    }
    const im = el("img");
    im.src = src;
    im.style.cssText = "height:" + h + "px;width:auto;filter:drop-shadow(0 8px 24px rgba(0,0,0,.55))";
    wrap.appendChild(im);
  });
  return wrap;
}
// monogram badge for a team that has no crest
function monogram(text, size, fs) {
  const m = el("div", "ring", esc(text));
  m.style.cssText += "width:" + size + "px;height:" + size + "px;font-size:" + fs + "px;flex:none";
  return m;
}
const FADE_OUT = 0.18;
function finish(tl, D) {
  tl.to("#root", { opacity: 0, duration: FADE_OUT, ease: "none" }, D - FADE_OUT);
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
  tl.seek(0);
}
