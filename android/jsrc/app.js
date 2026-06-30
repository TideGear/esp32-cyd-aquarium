/*
 * Aquarium Clock - front-end entry.
 *
 * Drives the ACTUAL esp32-cyd-aquarium simulation modules (engine, water, fish,
 * plants, boids, motion, framebuffer, 3x5 pixel font) that the upstream project
 * ships for its browser preview (ui/src/lib/aquarium). Those are bundled
 * verbatim. This file is the glue: it runs the real engine on a 16:9 LED grid,
 * renders the dot-matrix look, draws a large LED clock, slowly drifts the whole
 * scene to avoid burn-in, and adds a tap-to-open settings panel including a
 * zip-code outside-temperature feed that colours the water.
 */
import { FramebufferLayer, blendPackedOver, writePackedPixelsToRGBAData } from "./aquarium/framebuffer.js";
import { createAquariumEngine } from "./aquarium/engine.js";
import { Boid } from "./aquarium/boid.js";
import { BOIDS } from "./aquarium/constants.js";
import { SeededRandom } from "./aquarium/random.js";

/* One fresh random seed per app launch so the tank differs every time.
   (The upstream JS port hardcodes its seeds, which made every launch identical.) */
const LAUNCH_SEED = (Date.now() >>> 0) || 1;
/* The seed that produced the current tank. Auto-reset bumps it to grow a new one. */
let sceneSeed = LAUNCH_SEED;

/* ---- exact 3x5 glyph atlas, copied verbatim from aquarium/pixel-text.js ---- */
const GLYPHS = {
  "0":["111","101","101","101","111"],"1":["010","110","010","010","111"],
  "2":["111","001","111","100","111"],"3":["111","001","111","001","111"],
  "4":["101","101","111","001","001"],"5":["111","100","111","001","111"],
  "6":["111","100","111","101","111"],"7":["111","001","010","010","010"],
  "8":["111","101","111","101","111"],"9":["111","101","111","001","111"],
  A:["010","101","111","101","101"],B:["110","101","110","101","110"],
  C:["111","100","100","100","111"],D:["110","101","101","101","110"],
  E:["111","100","111","100","111"],F:["111","100","111","100","100"],
  G:["111","100","101","101","111"],H:["101","101","111","101","101"],
  I:["111","010","010","010","111"],J:["001","001","001","101","111"],
  K:["101","101","110","101","101"],L:["100","100","100","100","111"],
  M:["101","111","111","101","101"],N:["101","111","111","111","101"],
  O:["111","101","101","101","111"],P:["111","101","111","100","100"],
  Q:["111","101","101","111","001"],R:["111","101","111","110","101"],
  S:["111","100","111","001","111"],T:["111","010","010","010","010"],
  U:["101","101","101","101","111"],V:["101","101","101","101","010"],
  W:["101","101","111","111","101"],X:["101","101","010","101","101"],
  Y:["101","101","010","010","010"],Z:["111","001","010","100","111"],
  ":":["0","1","0","1","0"],".":["0","0","0","0","1"],
  "/":["001","001","010","100","100"],"-":["000","000","111","000","000"]," ":["0","0","0","0","0"],
};

/* --------------------------------- fixed config --------------------------- */
const DOT_RADIUS_RATIO = 0.43;               // identical to aquarium/renderer.js
const TARGET_FPS = 30;
const RENDER_LONG_EDGE = 1920;               // backing px budget on the long edge
const OVERSCAN_RATIO = 0.05;                 // aquarium bleed for drift (~96px @ 1920)

/* LED-grid resolution presets, defined at their NATIVE orientation. The
   orientation setting swaps W/H for non-square panels so the grid is never
   sideways; square panels (the original C++ matrix) are orientation-agnostic. */
const PANELS = {
  fine:     { label:"Fine",         w:160, h:90  },
  normal:   { label:"Normal",       w:128, h:72  },
  chunky:   { label:"Chunky",       w:96,  h:54  },
  original: { label:"Original C++", w:64,  h:64  },   // OMatrixSettings.h 64x64
  cyd:      { label:"CYD",          w:240, h:320 },   // ESP32-2432S028R 240x320
};

/* clock colours, taken from the device's renderClockOverlay() */
const C_SHADOW="rgb(0,6,8)";
const BASE = { TIME:42, AMPM:15, DATE:19, WEEK:16, OUT:15 };

/* Per-element clock colors. Each is a user-editable #rrggbb hex; the neon glow
   is derived from it at draw time. This list also drives the settings UI order.
   Defaults reproduce the original two-tone look (bright time, teal everything else). */
const COLOR_ELEMENTS = [
  ["time","Time"], ["ampm","AM / PM"], ["seconds","Seconds"],
  ["day","Weekday"], ["date","Date"],
  ["temp","Temperature"], ["humidity","Humidity"], ["aqi","Air quality (AQI)"],
];
const COLOR_DEFAULTS = {
  time:"#e0f8ee", ampm:"#84debe", seconds:"#84debe",
  day:"#84debe", date:"#84debe",
  temp:"#84debe", humidity:"#84debe", aqi:"#84debe",
};

/* ------------------------------- settings model --------------------------- */
const SKEY = "aquaclock.settings";
function defaults() {
  return {
    unit:"F", zip:"", country:"US", useLive:true,
    manualTempC:21, waterMinC:10, waterMaxC:35,
    humidityPercent:50, co2ppm:420, useLiveHumidity:true, useLiveAqi:true,
    showTemp:true, showHumidity:true, showAqi:true, clockScale:1.0,
    fishCount:11, plantCount:5, boidsPerGroup:15,
    ledSize:"normal", orientation:"landscape",
    autoReset:false, resetH:0, resetM:30, resetS:0, glow:true,
    colors: Object.assign({}, COLOR_DEFAULTS),
  };
}
let settings = loadSettings();
function loadSettings() {
  const d = defaults();
  try {
    const raw = localStorage.getItem(SKEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // migrate the old single "showOutside" toggle to the temperature readout
      if (saved.showOutside !== undefined && saved.showTemp === undefined) saved.showTemp = saved.showOutside;
      const merged = Object.assign(d, saved);
      merged.colors = Object.assign({}, COLOR_DEFAULTS, saved.colors || {});  // keep new keys if added later
      return merged;
    }
  } catch (e) {}
  return d;
}
function saveSettings() { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch (e) {} }

/* temperature helpers (canonical storage is Celsius) */
const cToF = (c) => c * 9 / 5 + 32;
const fToC = (f) => (f - 32) * 5 / 9;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dispTemp = (c) => Math.round(settings.unit === "F" ? cToF(c) : c);
const tempToC = (v) => (settings.unit === "F" ? fToC(v) : v);

/* ------------------------------- weather feed ----------------------------- */
let liveTempC = null;
let liveHumidity = null;
let liveAqi = null;
let placeName = "";
let lastWeather = 0;
function setWx(msg, cls) {
  const el = document.getElementById("wxStatus");
  if (el) { el.textContent = msg; el.className = "wxstatus" + (cls ? " " + cls : ""); }
}
async function fetchOutsideTemp() {
  const zip = (settings.zip || "").trim();
  const cc = ((settings.country || "US").trim() || "US").toLowerCase();
  if (!zip) { liveTempC = null; liveHumidity = null; liveAqi = null; setWx("Enter a zip code to use outside temperature.", ""); return; }
  setWx("Looking up " + zip + "…", "");
  try {
    const g = await fetch("https://api.zippopotam.us/" + cc + "/" + encodeURIComponent(zip));
    if (!g.ok) throw 0;
    const gj = await g.json();
    const place = gj.places && gj.places[0];
    if (!place) throw 0;
    const lat = parseFloat(place.latitude), lon = parseFloat(place.longitude);
    placeName = place["place name"] || "";
    const w = await fetch("https://api.open-meteo.com/v1/forecast?latitude=" + lat +
      "&longitude=" + lon + "&current=temperature_2m,relative_humidity_2m&temperature_unit=celsius");
    if (!w.ok) throw 0;
    const wj = await w.json();
    const t = wj && wj.current && wj.current.temperature_2m;
    if (typeof t !== "number") throw 0;
    liveTempC = t; lastWeather = Date.now();
    const rh = wj.current.relative_humidity_2m;
    liveHumidity = typeof rh === "number" ? rh : null;
    // Air quality drives the CO2 stress mechanic (remapped). Keep it non-fatal:
    // a failed AQI lookup must not blank out the temperature/humidity we just got.
    try {
      const a = await fetch("https://air-quality-api.open-meteo.com/v1/air-quality?latitude=" + lat +
        "&longitude=" + lon + "&current=us_aqi");
      const aj = a.ok ? await a.json() : null;
      const aqi = aj && aj.current && aj.current.us_aqi;
      liveAqi = typeof aqi === "number" ? aqi : null;
    } catch (e2) { liveAqi = null; }
    const rhTxt = liveHumidity != null ? " · " + Math.round(liveHumidity) + "% RH" : "";
    const aqiTxt = liveAqi != null ? " · AQI " + Math.round(liveAqi) : "";
    setWx(placeName + ": " + dispTemp(t) + "°" + settings.unit + rhTxt + aqiTxt, "ok");
  } catch (e) {
    liveTempC = null; liveHumidity = null; liveAqi = null;
    setWx("Could not get weather — check the connection or zip code.", "err");
  }
}
function effectiveWaterTempC() {
  const src = (settings.useLive && liveTempC != null) ? liveTempC : settings.manualTempC;
  const lo = settings.waterMinC, hi = settings.waterMaxC;
  if (!(hi > lo)) return 22;
  // map the chosen cold..hot window onto the water module's native 10..35 sweep
  return 10 + clamp((src - lo) / (hi - lo), 0, 1) * 25;
}
function effectiveHumidity() {
  return (settings.useLiveHumidity && liveHumidity != null) ? liveHumidity : settings.humidityPercent;
}
/* Map US AQI onto the aquarium's CO2 stress scale, keyed to the AQI category
   breakpoints so bad-air days actually stress the tank:
     AQI   0 (clean)      -> 420 ppm  (ambient; fish thrive, CO2 < OK=600)
     AQI  50 (Good/Mod)    -> 600 ppm  (top of the healthy band)
     AQI 150 (Unhealthy)   -> 1000 ppm (CO2_BAD: slow + losing health)
     AQI 300 (Hazardous)   -> 2000 ppm (CO2_REALBAD: frozen, dying)
   AQI above 300 clamps to 2000. */
function aqiToCo2(aqi) {
  const pts = [[0, 420], [50, 600], [150, 1000], [300, 2000]];
  if (aqi <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (aqi <= pts[i][0]) {
      const x0 = pts[i - 1][0], y0 = pts[i - 1][1], x1 = pts[i][0], y1 = pts[i][1];
      return y0 + (y1 - y0) * (aqi - x0) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}
function effectiveCO2() {
  return (settings.useLiveAqi && liveAqi != null) ? aqiToCo2(liveAqi) : settings.co2ppm;
}

/* ------------------------------ scene / engine ---------------------------- */
let LW, LH, background, foreground, composite, framebuffer, engine, fishTarget;
let SCALE_X, SCALE_Y, DOT_R, USE_RECT;
let RENDER_W, RENDER_H, OVERSCAN, VP_X, VP_Y, VP_W, VP_H;

/* Selected panel resolution, re-oriented: square panels ignore orientation;
   others are swapped so their long edge follows the chosen orientation. */
function panelDims() {
  const p = PANELS[settings.ledSize] || PANELS.normal;
  let w = p.w, h = p.h;
  const portrait = settings.orientation === "portrait";
  if (portrait && w > h) { const t = w; w = h; h = t; }
  if (!portrait && h > w) { const t = w; w = h; h = t; }
  return [w, h];
}
/* Backing resolution that yields square dots: equal px pitch on both axes,
   long edge ~= RENDER_LONG_EDGE. */
function renderDims(lw, lh) {
  const pitch = Math.max(1, Math.round(RENDER_LONG_EDGE / Math.max(lw, lh)));
  return [lw * pitch, lh * pitch];
}

function recomputeViewport() {
  VP_X = -OVERSCAN; VP_Y = -OVERSCAN; VP_W = RENDER_W + OVERSCAN * 2; VP_H = RENDER_H + OVERSCAN * 2;
  SCALE_X = VP_W / LW; SCALE_Y = VP_H / LH;
  DOT_R = Math.max(0.5, Math.min(SCALE_X, SCALE_Y) * DOT_RADIUS_RATIO);
  // Dense panels (e.g. CYD 240x320 ~ 77k cells) have tiny dots: draw solid cells
  // instead, which both reads better at that pitch and is far cheaper than
  // tens of thousands of per-cell arc fills every frame.
  USE_RECT = DOT_R < 3 || LW * LH > 30000;
}
/* Drive the display orientation. Preferred path: ask Android to actually rotate
   the activity, so the OS detects which way is up and the window becomes truly
   portrait (no CSS rotation needed). Browser fallback: rotate the canvas 90deg. */
function applyDisplayOrientation() {
  const portrait = settings.orientation === "portrait";
  let native = false;
  try { if (window.AndroidClip && AndroidClip.setOrientation) { AndroidClip.setOrientation(portrait ? "portrait" : "landscape"); native = true; } } catch (e) {}
  const st = canvas.style;
  if (!native && portrait) {
    st.position = "fixed"; st.inset = "auto"; st.left = "50%"; st.top = "50%";
    st.width = window.innerHeight + "px"; st.height = window.innerWidth + "px";
    st.transform = "translate(-50%,-50%) rotate(90deg)";
  } else {
    st.position = ""; st.inset = ""; st.left = ""; st.top = ""; st.width = ""; st.height = ""; st.transform = "";
  }
}

function buildScene() {
  const dims = panelDims();
  LW = dims[0]; LH = dims[1];
  [RENDER_W, RENDER_H] = renderDims(LW, LH);
  OVERSCAN = Math.round(Math.max(RENDER_W, RENDER_H) * OVERSCAN_RATIO);
  canvas.width = RENDER_W; canvas.height = RENDER_H;
  ctx.imageSmoothingEnabled = false;
  applyDisplayOrientation();
  background = new FramebufferLayer(LW, LH, { name:"background", transparent:false, clearColor:{ r:0,g:0,b:0,a:255 } });
  foreground = new FramebufferLayer(LW, LH, { name:"foreground", transparent:true });
  composite = new Uint32Array(LW * LH);
  framebuffer = { width:LW, height:LH, modeId:"cyd-panel", background, foreground };
  const mode = { id:"cyd-panel", logicalWidth:LW, logicalHeight:LH, physicalWidth:RENDER_W, physicalHeight:RENDER_H };
  engine = createAquariumEngine({ mode, disableStateLoad:true });
  // Per-launch food drop positions (else identical each launch, like the port's default).
  try { engine.food.rng = new SeededRandom((sceneSeed ^ 0x0f00d123) >>> 0); } catch (e) {}
  applyCounts();
  recomputeViewport();
}
function applyCounts() {
  // Re-seed every generator from this launch's seed so species/colors/positions,
  // plants and boids are randomized per launch instead of frozen to the port's
  // fixed default seeds (matching the original C++, which seeds from the clock).
  try { engine.fish.rng = new SeededRandom(sceneSeed); } catch (e) {}
  try { engine.fish.initializeFish(settings.fishCount); } catch (e) {}
  fishTarget = settings.fishCount;
  // Plants re-seed from rngSeed inside resize(), so set the seed (not the rng).
  try {
    engine.plants.rngSeed = (sceneSeed ^ 0x00a71a17) >>> 0;
    engine.plants.count = settings.plantCount; engine.plants.width = 0; engine.plants.resize(LW, LH);
  } catch (e) {}
  applyBoids(settings.boidsPerGroup);
}
function applyBoids(n) {
  const bm = engine.boidManager;
  const rng = new SeededRandom((sceneSeed ^ 0xb01d123) >>> 0);
  bm.boidGroups = [];
  for (let g = 0; g < BOIDS.GROUPS; g++) {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const b = new Boid({ x: rng.int(0, Math.max(1, bm.width)), y: rng.int(0, Math.max(1, bm.height)), limits: bm.limits, rng });
      b.maxspeed = rng.int(BOIDS.MAX_SPEED.min, BOIDS.MAX_SPEED.maxExclusive) / 10.0;
      b.maxforce = rng.int(BOIDS.MAX_FORCE.min, BOIDS.MAX_FORCE.maxExclusive) / 10.0;
      arr.push(b);
    }
    bm.boidGroups.push(arr);
  }
}

/* Grow a brand-new tank in place: pick a fresh seed and re-seed every generator
   (fish, plants, boids, food). Keeps the current panel/orientation and canvas. */
function regenerateAquarium() {
  sceneSeed = ((Date.now() >>> 0) ^ Math.imul(sceneSeed, 2654435761)) >>> 0 || 1;
  try { engine.food.rng = new SeededRandom((sceneSeed ^ 0x0f00d123) >>> 0); } catch (e) {}
  applyCounts();
}

/* --------------------------- auto-reset + fade ---------------------------- */
/* Periodically dissolve the tank and grow a new one. The fade dips the AQUARIUM
   layer's opacity to 0 and back (the clock keeps drawing at full opacity), and
   the swap happens at the dark midpoint so it is never visible. */
const FADE_HALF_MS = 2500;                 // 2.5s out + 2.5s in = 5s total
let fadePhase = "idle";                    // "out" | "in" | "idle"
let fadeStart = 0;
let nextResetAt = 0;                        // 0 => (re)initialize from current time

function resetIntervalMs() {
  const h = settings.resetH | 0, m = settings.resetM | 0, s = settings.resetS | 0;
  return Math.max(0, (h * 3600 + m * 60 + s) * 1000);
}
/* Force the countdown to restart relative to "now" on the next frame. */
function rescheduleReset() { nextResetAt = 0; }

function maybeStartReset(now) {
  if (fadePhase !== "idle") return;
  const interval = resetIntervalMs();
  if (!settings.autoReset || interval <= 0) { nextResetAt = 0; return; }
  if (nextResetAt === 0) { nextResetAt = now + interval; return; }
  if (now >= nextResetAt) { fadePhase = "out"; fadeStart = now; nextResetAt = now + interval; }
}

/* Returns the aquarium-layer opacity for this frame and advances the fade. */
function aquariumOpacity(now) {
  if (fadePhase === "out") {
    const t = (now - fadeStart) / FADE_HALF_MS;
    if (t >= 1) { regenerateAquarium(); fadePhase = "in"; fadeStart = now; return 0; }
    return 1 - t;
  }
  if (fadePhase === "in") {
    const t = (now - fadeStart) / FADE_HALF_MS;
    if (t >= 1) { fadePhase = "idle"; return 1; }
    return t;
  }
  return 1;
}

/* ------------------------------- canvas setup ----------------------------- */
const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d", { alpha:false });
ctx.imageSmoothingEnabled = false;  // backing size is set in buildScene()

let CTX = ctx;                                 // active draw target for LED glyphs
// Clock is cached in two layers: slow (digits/date/week/air, ~once a minute) and
// fast (blinking colon + seconds, each second). Both blitted every frame.
let clockSlowCanvas = null, clockSlowCtx = null, clockSlowKey = "";
let clockFastCanvas = null, clockFastCtx = null, clockFastKey = "";
let gridCanvas = null, gridCtx = null, gridImage = null;  // LWxLH scratch for dense-panel blit
function ensureClockCanvases() {
  if (!clockSlowCanvas) {
    clockSlowCanvas = document.createElement("canvas"); clockSlowCtx = clockSlowCanvas.getContext("2d");
    clockFastCanvas = document.createElement("canvas"); clockFastCtx = clockFastCanvas.getContext("2d");
  }
  if (clockSlowCanvas.width !== RENDER_W || clockSlowCanvas.height !== RENDER_H) {
    clockSlowCanvas.width = RENDER_W; clockSlowCanvas.height = RENDER_H;
    clockFastCanvas.width = RENDER_W; clockFastCanvas.height = RENDER_H;
    clockSlowKey = ""; clockFastKey = "";   // resized canvases are cleared; force a re-render
  }
}

const colorCache = new Map();
function cssFor(rgb) {
  let s = colorCache.get(rgb);
  if (s === undefined) { s = "rgb(" + ((rgb >>> 16) & 255) + "," + ((rgb >>> 8) & 255) + "," + (rgb & 255) + ")"; colorCache.set(rgb, s); }
  return s;
}
function drawAquariumDots() {
  if (USE_RECT) {
    // Dense panels: one ImageData upload + one scaled blit instead of tens of
    // thousands of per-cell fills. Nearest-neighbour scaling keeps the crisp
    // square-pixel look the per-cell path produced.
    if (!gridCanvas) { gridCanvas = document.createElement("canvas"); gridCtx = gridCanvas.getContext("2d"); }
    if (gridCanvas.width !== LW || gridCanvas.height !== LH) {
      gridCanvas.width = LW; gridCanvas.height = LH; gridImage = gridCtx.createImageData(LW, LH);
    }
    writePackedPixelsToRGBAData(composite, gridImage.data);
    gridCtx.putImageData(gridImage, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(gridCanvas, 0, 0, LW, LH, VP_X, VP_Y, VP_W, VP_H);
    return;
  }
  for (let y = 0; y < LH; y++) {
    const cy = VP_Y + (y + 0.5) * SCALE_Y, rowBase = y * LW;
    for (let x = 0; x < LW; x++) {
      const packed = composite[rowBase + x] >>> 0;
      if (((packed >>> 24) & 255) === 0) continue;
      const rgb = packed & 0x00ffffff;
      if (rgb === 0) continue;
      ctx.fillStyle = cssFor(rgb);
      ctx.beginPath();
      ctx.arc(VP_X + (x + 0.5) * SCALE_X, cy, DOT_R, 0, 6.283185307179586);
      ctx.fill();
    }
  }
}

/* ------------------------------ clock drawing ----------------------------- */
function glyphWidth(ch) { const g = GLYPHS[ch] || GLYPHS[" "]; let w = 0; for (let i = 0; i < g.length; i++) if (g[i].length > w) w = g[i].length; return w; }
function measure(text, cell) { let w = 0; for (let i = 0; i < text.length; i++) { w += glyphWidth(text[i]) * cell; if (i < text.length - 1) w += cell; } return w; }
/* drawLed advances the pen by (glyphWidth+1)*cell per char; this is that advance
   so consecutive segments line up exactly with a single combined draw. */
function advanceWidth(text, cell) { let w = 0; for (let i = 0; i < text.length; i++) w += (glyphWidth(text[i]) + 1) * cell; return w; }

/* ---- per-element clock colors ---- */
const clamp255 = (v) => { v = v | 0; return v < 0 ? 0 : v > 255 ? 255 : v; };
function hexToRgb(hex) {
  let h = (hex || "").replace("#", "");
  if (h.length === 3) h = h.replace(/(.)/g, "$1$1");
  const n = parseInt(h, 16);
  if (!isFinite(n) || h.length !== 6) return { r:255, g:255, b:255 };
  return { r:(n >> 16) & 255, g:(n >> 8) & 255, b:n & 255 };
}
const rgbToHex = (r, g, b) => "#" + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("");
const colorHex = (key) => (settings.colors && settings.colors[key]) || COLOR_DEFAULTS[key];
function clockColor(key) { const c = hexToRgb(colorHex(key)); return "rgb(" + c.r + "," + c.g + "," + c.b + ")"; }
function clockGlow(key) { const c = hexToRgb(colorHex(key)); return "rgba(" + c.r + "," + c.g + "," + c.b + ",0.5)"; }
/* Accepts "#rrggbb", "rrggbb", "#rgb", or "rgb(r,g,b)"; returns a #rrggbb or null. */
function parseColor(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^#?([0-9a-fA-F]{6})$/); if (m) return "#" + m[1].toLowerCase();
  m = s.match(/^#?([0-9a-fA-F]{3})$/); if (m) return "#" + m[1].toLowerCase().replace(/(.)/g, "$1$1");
  m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i); if (m) return rgbToHex(+m[1], +m[2], +m[3]);
  return null;
}
/* Clipboard via the native bridge when present (reliable on file://), else the
   Web Clipboard API. Both return a Promise so callers are uniform. */
function clipboardCopy(text) {
  try { if (window.AndroidClip && AndroidClip.copy) { AndroidClip.copy(text); return Promise.resolve(true); } } catch (e) {}
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
  return Promise.resolve(false);
}
function clipboardPaste() {
  try { if (window.AndroidClip && AndroidClip.paste) return Promise.resolve(AndroidClip.paste() || ""); } catch (e) {}
  if (navigator.clipboard && navigator.clipboard.readText) return navigator.clipboard.readText().then((t) => t, () => "");
  return Promise.resolve("");
}
function drawLed(text, startX, topY, cell, color, glowColor, glowBlur) {
  const r = cell * 0.42;
  CTX.fillStyle = color; CTX.shadowColor = glowColor; CTX.shadowBlur = settings.glow ? glowBlur : 0;
  let cx = startX;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], g = GLYPHS[ch] || GLYPHS[" "], gw = glyphWidth(ch);
    for (let row = 0; row < g.length; row++) { const line = g[row];
      for (let col = 0; col < line.length; col++) { if (line[col] !== "1") continue;
        CTX.beginPath(); CTX.arc(cx + col * cell + cell / 2, topY + row * cell + cell / 2, r, 0, 6.283185307179586); CTX.fill();
      } }
    cx += (gw + 1) * cell;
  }
  CTX.shadowBlur = 0;
}
function drawLedFx(text, startX, topY, cell, color, glowColor, glowBlur) {
  const off = Math.max(2, Math.round(cell * 0.14));
  drawLed(text, startX + off, topY + off, cell, C_SHADOW, C_SHADOW, 0);
  drawLed(text, startX, topY, cell, color, glowColor, glowBlur);
}
function drawLedCenteredFx(text, cx, topY, cell, color, glowColor, glowBlur) {
  drawLedFx(text, Math.round(cx - measure(text, cell) / 2), topY, cell, color, glowColor, glowBlur);
}
const WEEKDAYS = ["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"];
const pad2 = (n) => (n < 10 ? "0" + n : "" + n);
/* Outside readout under the clock: temperature / humidity / AQI, each gated by
   its toggle and shown only when the live value is available. The 3x5 LED font
   has no % or degree glyph, so humidity is suffixed "RH" (relative humidity). */
function outsideSegments() {
  const segs = [];
  if (settings.showTemp && liveTempC != null) segs.push({ text: dispTemp(liveTempC) + settings.unit, key:"temp" });
  if (settings.showHumidity && liveHumidity != null) segs.push({ text: Math.round(liveHumidity) + "RH", key:"humidity" });
  if (settings.showAqi && liveAqi != null) segs.push({ text: "AQI " + Math.round(liveAqi), key:"aqi" });
  return segs;
}
function clockStrings() {
  const d = new Date();
  let h = d.getHours(); const ampm = h >= 12 ? "PM" : "AM"; let h12 = h % 12; if (h12 === 0) h12 = 12;
  const colon = d.getSeconds() % 2 === 0 ? ":" : " ";   // blinking colon, as on the device
  const hStr = "" + h12, minStr = pad2(d.getMinutes());
  return {
    hStr, minStr, ampm, colon,
    timeStrSlow: hStr + " " + minStr,   // colon slot blank (space and ":" are the same width, so layout is stable)
    secStr: pad2(d.getSeconds()),
    dateStr: pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) + "/" + d.getFullYear(),
    weekStr: WEEKDAYS[d.getDay()],
    outSegs: outsideSegments(),
  };
}
function clockMetrics() {
  const sc = settings.clockScale;
  return {
    TIME: Math.round(BASE.TIME * sc), AMPM: Math.round(BASE.AMPM * sc),
    DATE: Math.round(BASE.DATE * sc), WEEK: Math.round(BASE.WEEK * sc), OUT: Math.round(BASE.OUT * sc),
  };
}
function clockLayout(c, m) {
  const { TIME, AMPM, DATE, WEEK, OUT } = m;
  const hasOut = c.outSegs.length > 0;
  const timeH = 5 * TIME, weekH = 5 * WEEK, dateH = 5 * DATE, outH = hasOut ? 5 * OUT : 0;
  const g1 = Math.round(TIME * 1.0), g2 = Math.round(DATE * 0.95), g3 = Math.round(DATE * 0.9);
  const total = timeH + g1 + weekH + g2 + dateH + (hasOut ? g3 + outH : 0);
  const cx = RENDER_W / 2;
  const timeTopY = Math.round((RENDER_H - total) / 2);
  const timeStartX = Math.round(cx - measure(c.timeStrSlow, TIME) / 2);
  const timeW = measure(c.timeStrSlow, TIME);
  return {
    cx, hasOut,
    timeTopY,
    weekTopY: timeTopY + timeH + g1,
    dateTopY: timeTopY + timeH + g1 + weekH + g2,
    outTopY: timeTopY + timeH + g1 + weekH + g2 + dateH + g3,
    timeStartX,
    colonX: timeStartX + advanceWidth(c.hStr, TIME),   // colon sits right after the hour digits
    rightX: Math.round(cx + timeW / 2 + TIME * 0.7),
    ampmTopY: timeTopY + Math.round(TIME * 0.2),
    secTopY: timeTopY + Math.round(TIME * 0.2) + 5 * AMPM + Math.round(AMPM * 1.1),
  };
}
/* Slow layer: everything that changes at most once a minute. */
function renderClockSlow(c) {
  const m = clockMetrics(), L = clockLayout(c, m), { TIME, AMPM, DATE, WEEK, OUT } = m;
  drawLedFx(c.timeStrSlow, L.timeStartX, L.timeTopY, TIME, clockColor("time"), clockGlow("time"), TIME * 0.85);
  drawLedFx(c.ampm, L.rightX, L.ampmTopY, AMPM, clockColor("ampm"), clockGlow("ampm"), AMPM * 0.8);
  drawLedCenteredFx(c.weekStr, L.cx, L.weekTopY, WEEK, clockColor("day"), clockGlow("day"), WEEK * 0.8);
  drawLedCenteredFx(c.dateStr, L.cx, L.dateTopY, DATE, clockColor("date"), clockGlow("date"), DATE * 0.85);
  if (L.hasOut) {
    const SEP = "  ", sepAdv = advanceWidth(SEP, OUT);
    let totalAdv = 0;
    for (let i = 0; i < c.outSegs.length; i++) { totalAdv += advanceWidth(c.outSegs[i].text, OUT); if (i < c.outSegs.length - 1) totalAdv += sepAdv; }
    let x = Math.round(L.cx - (totalAdv - OUT) / 2);   // each air value in its own color
    for (let i = 0; i < c.outSegs.length; i++) {
      const s = c.outSegs[i];
      drawLedFx(s.text, x, L.outTopY, OUT, clockColor(s.key), clockGlow(s.key), OUT * 0.8);
      x += advanceWidth(s.text, OUT);
      if (i < c.outSegs.length - 1) x += sepAdv;
    }
  }
}
/* Fast layer: only the blinking colon and the seconds (cheap to redraw each second). */
function renderClockFast(c) {
  const m = clockMetrics(), L = clockLayout(c, m), { TIME, AMPM } = m;
  drawLedFx(c.colon, L.colonX, L.timeTopY, TIME, clockColor("time"), clockGlow("time"), TIME * 0.85);
  drawLedFx(c.secStr, L.rightX, L.secTopY, AMPM, clockColor("seconds"), clockGlow("seconds"), AMPM * 0.8);
}
function slowKeyString(c) {
  let k = c.timeStrSlow + "|" + c.ampm + "|" + c.dateStr + "|" + c.weekStr + "|" + settings.clockScale + "|" + settings.glow + "|" + RENDER_W + "x" + RENDER_H;
  for (let i = 0; i < COLOR_ELEMENTS.length; i++) k += "|" + colorHex(COLOR_ELEMENTS[i][0]);
  for (let i = 0; i < c.outSegs.length; i++) k += "|" + c.outSegs[i].text + c.outSegs[i].key;
  return k;
}
function fastKeyString(c) {
  return c.colon + "|" + c.secStr + "|" + c.timeStrSlow + "|" + settings.clockScale + "|" + settings.glow + "|" + RENDER_W + "x" + RENDER_H + "|" + colorHex("time") + "|" + colorHex("seconds");
}
/* Re-render each layer only when its pixels would change. The slow layer (the
   heavy shadow-blur glyphs) rebuilds ~once a minute; the tiny fast layer rebuilds
   each second. This keeps the per-second work small so it never drops a frame. */
function updateClockCache() {
  const c = clockStrings();
  ensureClockCanvases();
  const sk = slowKeyString(c);
  if (sk !== clockSlowKey) {
    clockSlowCtx.clearRect(0, 0, RENDER_W, RENDER_H);
    const prev = CTX; CTX = clockSlowCtx; renderClockSlow(c); CTX = prev;
    clockSlowKey = sk;
  }
  const fk = fastKeyString(c);
  if (fk !== clockFastKey) {
    clockFastCtx.clearRect(0, 0, RENDER_W, RENDER_H);
    const prev = CTX; CTX = clockFastCtx; renderClockFast(c); CTX = prev;
    clockFastKey = fk;
  }
}

/* ----------------------------- burn-in drift ------------------------------ */
function driftOffset(now) {
  const t = now / 1000;
  return [OVERSCAN * 0.72 * Math.sin((t * 2 * Math.PI) / 97),
          OVERSCAN * 0.62 * Math.sin((t * 2 * Math.PI) / 131 + 1.3)];
}

/* ------------------------------- main loop -------------------------------- */
const frameInterval = 1000 / TARGET_FPS;
let lastFrame = 0;
function loop(now) {
  requestAnimationFrame(loop);
  if (now - lastFrame < frameInterval) return;
  lastFrame = now;

  // run the real simulation sub-steps in the upstream engine order, but feed our
  // own water temperature (engine.update() would force a fixed 22C environment).
  const tC = effectiveWaterTempC();
  const co2 = effectiveCO2();
  const hum = effectiveHumidity();
  engine.food.handleTouchInput(now);
  engine.fish.assignFood(engine.food.takeUnassignedFood());
  engine.water.update({ framebuffer, temperatureC: tC, now });
  engine.boidManager.updateBoids(co2);
  engine.boidManager.renderBoids(framebuffer);
  engine.fish.update({ framebuffer, co2, now });
  engine.food.update({ framebuffer });
  engine.plants.update({ framebuffer, humidityPercent: hum, now });
  while (engine.fish.fish.length > fishTarget) engine.fish.fish.pop();

  const bg = background.pixels, fg = foreground.pixels;
  for (let i = 0; i < composite.length; i++) { const f = fg[i]; composite[i] = (f >>> 24) === 0 ? bg[i] : blendPackedOver(bg[i], f); }

  maybeStartReset(now);
  const tankAlpha = aquariumOpacity(now);
  updateClockCache();   // only re-renders the glyphs when the displayed values change

  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, RENDER_W, RENDER_H);
  const [dx, dy] = driftOffset(now);
  ctx.save(); ctx.translate(dx, dy);
  ctx.globalAlpha = tankAlpha;   // fade the tank only; clock stays at full opacity
  drawAquariumDots();
  ctx.globalAlpha = 1;
  ctx.drawImage(clockSlowCanvas, 0, 0);   // cheap blits of the cached clock layers
  ctx.drawImage(clockFastCanvas, 0, 0);
  ctx.restore();

  foreground.clear();
}

/* ------------------------------ settings panel ---------------------------- */
const $ = (id) => document.getElementById(id);
function setTempUnitLabels() {
  const u = "°" + settings.unit;
  ["coldUnit","hotUnit","manualUnit"].forEach((id) => { const e = $(id); if (e) e.textContent = u; });
}
function populatePanel() {
  $("selUnit").value = settings.unit;
  $("chkShowTemp").checked = settings.showTemp;
  $("chkShowHum").checked = settings.showHumidity;
  $("chkShowAqi").checked = settings.showAqi;
  $("inpClock").value = settings.clockScale; $("clockVal").textContent = settings.clockScale.toFixed(2) + "x";
  $("chkGlow").checked = settings.glow;
  $("inpZip").value = settings.zip;
  $("inpCountry").value = settings.country;
  $("chkLive").checked = settings.useLive;
  $("chkLiveHum").checked = settings.useLiveHumidity;
  $("chkLiveAqi").checked = settings.useLiveAqi;
  $("inpCold").value = dispTemp(settings.waterMinC);
  $("inpHot").value = dispTemp(settings.waterMaxC);
  $("inpManual").value = dispTemp(settings.manualTempC);
  setTempUnitLabels();
  $("inpHum").value = settings.humidityPercent; $("humVal").textContent = settings.humidityPercent + "%";
  $("inpCo2").value = settings.co2ppm; $("co2Val").textContent = settings.co2ppm;
  $("inpFish").value = settings.fishCount; $("fishVal").textContent = settings.fishCount;
  $("inpPlants").value = settings.plantCount; $("plantsVal").textContent = settings.plantCount;
  $("inpBoids").value = settings.boidsPerGroup; $("boidsVal").textContent = settings.boidsPerGroup;
  $("selLed").value = settings.ledSize;
  $("selOrient").value = settings.orientation;
  $("chkAutoReset").checked = settings.autoReset;
  $("inpResetH").value = settings.resetH;
  $("inpResetM").value = settings.resetM;
  $("inpResetS").value = settings.resetS;
  syncColorRows();
}

/* ---- clock color rows (color picker + hex + R/G/B, all kept in sync) ---- */
function buildColorRows() {
  const host = $("colorRows");
  if (!host || host.childElementCount) return;   // build once
  for (const [key, label] of COLOR_ELEMENTS) {
    const row = document.createElement("div");
    row.className = "row colorrow";
    row.innerHTML =
      '<label>' + label + '</label>' +
      '<div class="colorctl">' +
        '<input type="color" id="col_' + key + '">' +
        '<input type="text" class="hexin" id="hex_' + key + '" maxlength="7" spellcheck="false">' +
        '<input type="number" class="rgbin" id="r_' + key + '" min="0" max="255">' +
        '<input type="number" class="rgbin" id="g_' + key + '" min="0" max="255">' +
        '<input type="number" class="rgbin" id="b_' + key + '" min="0" max="255">' +
        '<button type="button" class="cpbtn" id="copy_' + key + '">Copy</button>' +
        '<button type="button" class="cpbtn" id="paste_' + key + '">Paste</button>' +
      '</div>';
    host.appendChild(row);
    bindColorRow(key);
  }
}
/* Single source of truth: normalize, store, sync all inputs, persist (live clock). */
function setColor(key, hexStr) {
  const c = hexToRgb(hexStr);
  settings.colors[key] = rgbToHex(c.r, c.g, c.b);
  syncColorRow(key);
  saveSettings();
}
function bindColorRow(key) {
  const col = $("col_" + key), hex = $("hex_" + key), rI = $("r_" + key), gI = $("g_" + key), bI = $("b_" + key);
  col.addEventListener("input", () => setColor(key, col.value));   // fires live while dragging the picker
  hex.addEventListener("change", () => {
    let v = hex.value.trim(); if (v[0] !== "#") v = "#" + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(key, v); else syncColorRow(key);  // revert bad input
  });
  const fromRgb = () => setColor(key, rgbToHex(parseInt(rI.value, 10) || 0, parseInt(gI.value, 10) || 0, parseInt(bI.value, 10) || 0));
  rI.addEventListener("change", fromRgb);
  gI.addEventListener("change", fromRgb);
  bI.addEventListener("change", fromRgb);

  const flash = (btn, msg) => { const prev = btn.dataset.label; btn.textContent = msg; setTimeout(() => { btn.textContent = prev; }, 900); };
  const copyBtn = $("copy_" + key), pasteBtn = $("paste_" + key);
  copyBtn.dataset.label = "Copy"; pasteBtn.dataset.label = "Paste";
  copyBtn.addEventListener("click", () => clipboardCopy(colorHex(key)).then((ok) => flash(copyBtn, ok ? "Copied" : "Failed")));
  pasteBtn.addEventListener("click", () => clipboardPaste().then((text) => {
    const h = parseColor(text);
    if (h) setColor(key, h); else flash(pasteBtn, "?");
  }));
}
function syncColorRow(key) {
  const c = hexToRgb(colorHex(key)), norm = rgbToHex(c.r, c.g, c.b);
  const col = $("col_" + key), hex = $("hex_" + key), rI = $("r_" + key), gI = $("g_" + key), bI = $("b_" + key);
  if (!col) return;
  col.value = norm; hex.value = norm; rI.value = c.r; gI.value = c.g; bI.value = c.b;
}
function syncColorRows() { for (const [key] of COLOR_ELEMENTS) syncColorRow(key); }
function bindPanel() {
  buildColorRows();
  $("selUnit").addEventListener("change", (e) => { settings.unit = e.target.value; saveSettings(); populatePanel(); });
  $("chkShowTemp").addEventListener("change", (e) => { settings.showTemp = e.target.checked; saveSettings(); });
  $("chkShowHum").addEventListener("change", (e) => { settings.showHumidity = e.target.checked; saveSettings(); });
  $("chkShowAqi").addEventListener("change", (e) => { settings.showAqi = e.target.checked; saveSettings(); });
  $("inpClock").addEventListener("input", (e) => { settings.clockScale = parseFloat(e.target.value); $("clockVal").textContent = settings.clockScale.toFixed(2) + "x"; });
  $("inpClock").addEventListener("change", saveSettings);
  $("chkGlow").addEventListener("change", (e) => { settings.glow = e.target.checked; saveSettings(); });  // clock cache auto-invalidates via key

  $("inpZip").addEventListener("change", (e) => { settings.zip = e.target.value.trim(); saveSettings(); fetchOutsideTemp(); });
  $("inpCountry").addEventListener("change", (e) => { settings.country = (e.target.value.trim() || "US"); saveSettings(); fetchOutsideTemp(); });
  $("chkLive").addEventListener("change", (e) => { settings.useLive = e.target.checked; saveSettings(); });
  $("chkLiveHum").addEventListener("change", (e) => { settings.useLiveHumidity = e.target.checked; saveSettings(); });
  $("chkLiveAqi").addEventListener("change", (e) => { settings.useLiveAqi = e.target.checked; saveSettings(); });
  $("btnRefresh").addEventListener("click", fetchOutsideTemp);

  $("inpCold").addEventListener("change", (e) => { settings.waterMinC = tempToC(parseFloat(e.target.value)); saveSettings(); });
  $("inpHot").addEventListener("change", (e) => { settings.waterMaxC = tempToC(parseFloat(e.target.value)); saveSettings(); });
  $("inpManual").addEventListener("change", (e) => { settings.manualTempC = tempToC(parseFloat(e.target.value)); saveSettings(); });

  $("inpHum").addEventListener("input", (e) => { $("humVal").textContent = e.target.value + "%"; });
  $("inpHum").addEventListener("change", (e) => { settings.humidityPercent = parseInt(e.target.value, 10); saveSettings(); });
  $("inpCo2").addEventListener("input", (e) => { $("co2Val").textContent = e.target.value; });
  $("inpCo2").addEventListener("change", (e) => { settings.co2ppm = parseInt(e.target.value, 10); saveSettings(); });

  $("inpFish").addEventListener("input", (e) => { $("fishVal").textContent = e.target.value; });
  $("inpFish").addEventListener("change", (e) => { settings.fishCount = parseInt(e.target.value, 10); saveSettings(); try { engine.fish.initializeFish(settings.fishCount); } catch (x) {} fishTarget = settings.fishCount; });
  $("inpPlants").addEventListener("input", (e) => { $("plantsVal").textContent = e.target.value; });
  $("inpPlants").addEventListener("change", (e) => { settings.plantCount = parseInt(e.target.value, 10); saveSettings(); try { engine.plants.count = settings.plantCount; engine.plants.width = 0; engine.plants.resize(LW, LH); } catch (x) {} });
  $("inpBoids").addEventListener("input", (e) => { $("boidsVal").textContent = e.target.value; });
  $("inpBoids").addEventListener("change", (e) => { settings.boidsPerGroup = parseInt(e.target.value, 10); saveSettings(); applyBoids(settings.boidsPerGroup); });
  $("selLed").addEventListener("change", (e) => { settings.ledSize = e.target.value; saveSettings(); buildScene(); });
  $("selOrient").addEventListener("change", (e) => { settings.orientation = e.target.value; saveSettings(); buildScene(); });

  $("chkAutoReset").addEventListener("change", (e) => { settings.autoReset = e.target.checked; saveSettings(); rescheduleReset(); });
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, parseInt(v, 10) || 0));
  $("inpResetH").addEventListener("change", (e) => { settings.resetH = clampInt(e.target.value, 0, 999); e.target.value = settings.resetH; saveSettings(); rescheduleReset(); });
  $("inpResetM").addEventListener("change", (e) => { settings.resetM = clampInt(e.target.value, 0, 59); e.target.value = settings.resetM; saveSettings(); rescheduleReset(); });
  $("inpResetS").addEventListener("change", (e) => { settings.resetS = clampInt(e.target.value, 0, 59); e.target.value = settings.resetS; saveSettings(); rescheduleReset(); });

  $("btnReset").addEventListener("click", () => { settings = defaults(); saveSettings(); buildScene(); rescheduleReset(); populatePanel(); fetchOutsideTemp(); });
  $("btnClose").addEventListener("click", closePanel);
  $("settings").addEventListener("click", (e) => { if (e.target === $("settings")) closePanel(); });
  canvas.addEventListener("click", openPanel);
}
function openPanel() { populatePanel(); $("settings").classList.add("open"); }
function closePanel() { $("settings").classList.remove("open"); saveSettings(); }

/* keep awake via JS too (native FLAG_KEEP_SCREEN_ON is the primary mechanism) */
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      let lock = await navigator.wakeLock.request("screen");
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible") { try { lock = await navigator.wakeLock.request("screen"); } catch (e) {} }
      });
    }
  } catch (e) {}
}

/* --------------------------------- start ---------------------------------- */
buildScene();
bindPanel();
// Re-fit the canvas when the OS rotates/resizes the window so portrait corrects itself instantly.
window.addEventListener("resize", applyDisplayOrientation);
window.addEventListener("orientationchange", applyDisplayOrientation);
requestWakeLock();
requestAnimationFrame(loop);
setTimeout(fetchOutsideTemp, 1200);                 // initial outside-temp pull
setInterval(fetchOutsideTemp, 10 * 60 * 1000);      // refresh every 10 min
