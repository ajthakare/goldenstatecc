// Scales the 1920×1080 overlay to whatever size the browser source is
// (Streamlabs defaults to 800×600; phone apps use their own canvas size).
(function () {
  const W = 1920, H = 1080;
  function fit() {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    const x = (window.innerWidth - W * s) / 2;
    const y = (window.innerHeight - H * s) / 2;
    document.body.style.transformOrigin = '0 0';
    document.body.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  }
  window.addEventListener('resize', fit);
  fit();
})();
