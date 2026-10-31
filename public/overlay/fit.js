// Scales the 1920×1080 overlay to whatever size the browser source is
// (Streamlabs defaults to 800×600; phone apps use their own canvas size).
// Add &debug=1 to the URL to show the measured size on screen.
(function () {
  const W = 1920, H = 1080;
  const debug = new URLSearchParams(window.location.search).get('debug') === '1';
  let box;

  function size() {
    const vv = window.visualViewport;
    const w = window.innerWidth || document.documentElement.clientWidth || (vv && vv.width);
    const h = window.innerHeight || document.documentElement.clientHeight || (vv && vv.height);
    return { w, h };
  }

  function fit() {
    const { w, h } = size();
    // Some app web views report 0×0 before the layer is laid out; wait for a resize
    if (!w || !h) return;
    const s = Math.min(w / W, h / H);
    const x = (w - W * s) / 2;
    const y = (h - H * s) / 2;
    document.body.style.transformOrigin = '0 0';
    document.body.style.transform = `translate(${x}px, ${y}px) scale(${s})`;

    if (debug) {
      if (!box) {
        box = document.createElement('div');
        box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:bold 11px/1.3 Arial,sans-serif;'
          + 'color:#fff;background:rgba(200,0,0,0.85);padding:4px 6px;border-radius:4px;white-space:pre;';
        // Outside <body> so the readout isn't scaled with the overlay
        document.documentElement.appendChild(box);
      }
      const vv = window.visualViewport;
      box.textContent = [
        `inner ${window.innerWidth}×${window.innerHeight}`,
        `client ${document.documentElement.clientWidth}×${document.documentElement.clientHeight}`,
        `visual ${vv ? Math.round(vv.width) + '×' + Math.round(vv.height) + ' @' + vv.scale.toFixed(2) : 'n/a'}`,
        `screen ${screen.width}×${screen.height}  dpr ${window.devicePixelRatio}`,
        `scale ${s.toFixed(3)}`,
        navigator.userAgent.slice(0, 60),
      ].join('\n');
    }
  }

  window.addEventListener('resize', fit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
  window.addEventListener('load', fit);
  fit();
})();
