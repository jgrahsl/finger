const PAD = { top: 12, right: 20, bottom: 24, left: 44 };

function niceStep(range, targetTicks) {
  const raw = range / targetTicks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const frac = raw / pow;
  return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * pow;
}

// First index whose time is >= t (times are ascending).
function lowerBound(times, t) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Chart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onresize = null;
    new ResizeObserver(() => {
      this.resize();
      this.onresize?.();
    }).observe(canvas);
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return; // hidden tab: keep the last size
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  #readColors() {
    const style = getComputedStyle(this.canvas);
    return {
      grid: style.getPropertyValue('--grid').trim(),
      text: style.getPropertyValue('--muted').trim(),
      line: style.getPropertyValue('--accent').trim(),
    };
  }

  /** Call after the theme changes; colours are otherwise read only once. */
  refreshColors() {
    this.colors = null;
  }

  /**
   * @param times   seconds, ascending
   * @param values  kg
   * @param opts    { tMin, tMax, scale (kg -> display unit), minYMax }
   */
  draw(times, values, { tMin, tMax, scale, minYMax }) {
    const { ctx, width, height } = this;
    if (this.canvas.offsetParent === null) return; // hidden tab
    const colors = (this.colors ??= this.#readColors());
    const plotW = width - PAD.left - PAD.right;
    const plotH = height - PAD.top - PAD.bottom;
    ctx.clearRect(0, 0, width, height);
    if (plotW <= 0 || plotH <= 0) return;

    const start = lowerBound(times, tMin);
    const end = lowerBound(times, tMax + 1e-9);

    let vMin = 0;
    let vMax = minYMax;
    for (let i = start; i < end; i++) {
      const v = values[i] * scale;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    // Noise around zero should not add a whole negative gridline.
    if (vMin > -0.05 * vMax) vMin = 0;
    const yStep = niceStep(vMax - vMin, 5);
    const yMin = Math.floor(vMin / yStep) * yStep;
    const yMax = Math.ceil((vMax > minYMax ? vMax * 1.05 : vMax) / yStep) * yStep;

    const x = (t) => PAD.left + ((t - tMin) / (tMax - tMin)) * plotW;
    const y = (v) => PAD.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = colors.text;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = yMin; v <= yMax + yStep / 2; v += yStep) {
      const py = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(width - PAD.right, py);
      ctx.stroke();
      ctx.fillText(String(Math.round(v * 100) / 100), PAD.left - 6, py);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tStep = niceStep(tMax - tMin, Math.max(2, Math.floor(plotW / 80)));
    for (let t = Math.ceil(tMin / tStep) * tStep; t <= tMax + 1e-9; t += tStep) {
      ctx.fillText(`${Math.round(t * 10) / 10}s`, x(t), height - PAD.bottom + 6);
    }

    if (end - start < 2) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, plotW, plotH);
    ctx.clip();
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();

    if (end - start <= plotW * 2) {
      for (let i = start; i < end; i++) {
        const px = x(times[i]);
        const py = y(values[i] * scale);
        if (i === start) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
    } else {
      // More samples than pixels: draw the min/max envelope per pixel column.
      let i = start;
      for (let col = 0; col < plotW && i < end; col++) {
        const tEnd = tMin + ((col + 1) / plotW) * (tMax - tMin);
        let lo = Infinity;
        let hi = -Infinity;
        for (; i < end && times[i] <= tEnd; i++) {
          const v = values[i] * scale;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi === -Infinity) continue;
        const px = PAD.left + col + 0.5;
        ctx.lineTo(px, y(lo));
        ctx.lineTo(px, y(hi));
      }
    }
    ctx.stroke();
    ctx.restore();
  }
}
