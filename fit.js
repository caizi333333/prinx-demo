/* Fit policy:
   - Bigger viewport: scale up to fill (cap at MAX_SCALE)
   - Smaller viewport: render at native 1:1, allow horizontal/vertical scroll
   This guarantees data/numbers are NEVER smaller than design intent.
*/
(function () {
  const DESIGN_W = 1280;
  const DESIGN_H = 720;
  const MIN_SCALE = 1.0;  // never shrink below native
  const MAX_SCALE = 1.5;  // upscale on 1920+ monitors (1.5× = perfect 1920×1080 fill)

  function fit() {
    const app = document.querySelector('.app');
    if (!app) return;
    const sx = window.innerWidth / DESIGN_W;
    const sy = window.innerHeight / DESIGN_H;
    const naturalFit = Math.min(sx, sy);
    const s = Math.min(Math.max(naturalFit, MIN_SCALE), MAX_SCALE);
    app.style.transform = `scale(${s})`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('has-app');
    fit();
  });
  window.addEventListener('resize', fit);
  fit();
})();
