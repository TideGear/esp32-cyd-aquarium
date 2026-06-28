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
import { FramebufferLayer, blendPackedOver } from "./aquarium/framebuffer.js";
import { createAquariumEngine } from "./aquarium/engine.js";
import { Boid } from "./aquarium/boid.js";
import { BOIDS } from "./aquarium/constants.js";
import { SeededRandom } from "./aquarium/random.js";

/* One fresh random seed per app launch so the tank differs every time.
   (The upstream JS port hardcodes its seeds, which made every launch identical.) */
const LAUNCH_SEED = (Date.now() >>> 0) || 1;

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
const RENDER_W = 1920, RENDER_H = 1080;     // backing resolution (1080p)
const OVERSCAN = 96;                         // aquarium bleed for drift
const DOT_RADIUS_RATIO = 0.43;               // identical to aquarium/renderer.js
const TARGET_FPS = 30;
const LED_DIMS = { fine:[160,90], normal:[128,72], chunky:[96,54] };

/* clock colours, taken from the device's renderClockOverlay() */
const C_TIME="rgb(224,248,238)", C_TIME_GLOW="rgba(150,255,225,0.55)";
const C_SUB="rgb(132,222,190)",  C_SUB_GLOW="rgba(110,222,188,0.45)";
const C_SHADOW="rgb(0,6,8)";
const BASE = { TIME:42, AMPM:15, DATE:19, WEEK:16, OUT:15 };

/* ------------------------------- settings model --------------------------- */
const SKEY = "aquaclock.settings";
function defaults() {
  return {
    unit:"F", zip:"", country:"US", useLive:true,
    manualTempC:21, waterMinC:10, waterMaxC:35,
    humidityPercent:50, co2ppm:420, useLiveHumidity:true, useLiveAqi:true,
    showOutside:true, clockScale:1.0,
    fishCount:11, plantCount:5, boidsPerGroup:15, ledSize:"normal",
  };
}
let settings = loadSettings();
function loadSettings() {
  const d = defaults();
  try {
    const raw = localStorage.getItem(SKEY);
    if (raw) return Object.assign(d, JSON.parse(raw));
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
let SCALE_X, SCALE_Y, DOT_R;
const VP_X = -OVERSCAN, VP_Y = -OVERSCAN, VP_W = RENDER_W + OVERSCAN * 2, VP_H = RENDER_H + OVERSCAN * 2;

function recomputeViewport() {
  SCALE_X = VP_W / LW; SCALE_Y = VP_H / LH;
  DOT_R = Math.max(0.5, Math.min(SCALE_X, SCALE_Y) * DOT_RADIUS_RATIO);
}
function buildScene() {
  const dims = LED_DIMS[settings.ledSize] || LED_DIMS.normal;
  LW = dims[0]; LH = dims[1];
  background = new FramebufferLayer(LW, LH, { name:"background", transparent:false, clearColor:{ r:0,g:0,b:0,a:255 } });
  foreground = new FramebufferLayer(LW, LH, { name:"foreground", transparent:true });
  composite = new Uint32Array(LW * LH);
  framebuffer = { width:LW, height:LH, modeId:"cyd-landscape", background, foreground };
  const mode = { id:"cyd-landscape", logicalWidth:LW, logicalHeight:LH, physicalWidth:RENDER_W, physicalHeight:RENDER_H };
  engine = createAquariumEngine({ mode, disableStateLoad:true });
  // Per-launch food drop positions (else identical each launch, like the port's default).
  try { engine.food.rng = new SeededRandom((LAUNCH_SEED ^ 0x0f00d123) >>> 0); } catch (e) {}
  applyCounts();
  recomputeViewport();
}
function applyCounts() {
  // Re-seed every generator from this launch's seed so species/colors/positions,
  // plants and boids are randomized per launch instead of frozen to the port's
  // fixed default seeds (matching the original C++, which seeds from the clock).
  try { engine.fish.rng = new SeededRandom(LAUNCH_SEED); } catch (e) {}
  try { engine.fish.initializeFish(settings.fishCount); } catch (e) {}
  fishTarget = settings.fishCount;
  // Plants re-seed from rngSeed inside resize(), so set the seed (not the rng).
  try {
    engine.plants.rngSeed = (LAUNCH_SEED ^ 0x00a71a17) >>> 0;
    engine.plants.count = settings.plantCount; engine.plants.width = 0; engine.plants.resize(LW, LH);
  } catch (e) {}
  applyBoids(settings.boidsPerGroup);
}
function applyBoids(n) {
  const bm = engine.boidManager;
  const rng = new SeededRandom((LAUNCH_SEED ^ 0xb01d123) >>> 0);
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

/* ------------------------------- canvas setup ----------------------------- */
const canvas = document.getElementById("screen");
canvas.width = RENDER_W; canvas.height = RENDER_H;
const ctx = canvas.getContext("2d", { alpha:false });
ctx.imageSmoothingEnabled = false;

const colorCache = new Map();
function cssFor(rgb) {
  let s = colorCache.get(rgb);
  if (s === undefined) { s = "rgb(" + ((rgb >>> 16) & 255) + "," + ((rgb >>> 8) & 255) + "," + (rgb & 255) + ")"; colorCache.set(rgb, s); }
  return s;
}
function drawAquariumDots() {
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
function drawLed(text, startX, topY, cell, color, glowColor, glowBlur) {
  const r = cell * 0.42;
  ctx.fillStyle = color; ctx.shadowColor = glowColor; ctx.shadowBlur = glowBlur;
  let cx = startX;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], g = GLYPHS[ch] || GLYPHS[" "], gw = glyphWidth(ch);
    for (let row = 0; row < g.length; row++) { const line = g[row];
      for (let col = 0; col < line.length; col++) { if (line[col] !== "1") continue;
        ctx.beginPath(); ctx.arc(cx + col * cell + cell / 2, topY + row * cell + cell / 2, r, 0, 6.283185307179586); ctx.fill();
      } }
    cx += (gw + 1) * cell;
  }
  ctx.shadowBlur = 0;
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
function outsideText() {
  if (settings.showOutside && liveTempC != null) return dispTemp(liveTempC) + settings.unit;
  return "";
}
function drawClock() {
  const sc = settings.clockScale;
  const TIME = Math.round(BASE.TIME * sc), AMPM = Math.round(BASE.AMPM * sc),
        DATE = Math.round(BASE.DATE * sc), WEEK = Math.round(BASE.WEEK * sc), OUT = Math.round(BASE.OUT * sc);

  const d = new Date();
  let h = d.getHours(); const ampm = h >= 12 ? "PM" : "AM"; let h12 = h % 12; if (h12 === 0) h12 = 12;
  const colon = d.getSeconds() % 2 === 0 ? ":" : " ";   // blinking colon, as on the device
  const timeStr = h12 + colon + pad2(d.getMinutes());
  const secStr = pad2(d.getSeconds());
  const dateStr = pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) + "/" + d.getFullYear();
  const weekStr = WEEKDAYS[d.getDay()];
  const outStr = outsideText();

  const timeH = 5 * TIME, weekH = 5 * WEEK, dateH = 5 * DATE, outH = outStr ? 5 * OUT : 0;
  const g1 = Math.round(TIME * 1.0), g2 = Math.round(DATE * 0.95), g3 = Math.round(DATE * 0.9);
  let total = timeH + g1 + weekH + g2 + dateH + (outStr ? g3 + outH : 0);

  const cx = RENDER_W / 2;
  const timeTopY = Math.round((RENDER_H - total) / 2);
  const weekTopY = timeTopY + timeH + g1;
  const dateTopY = weekTopY + weekH + g2;
  const outTopY = dateTopY + dateH + g3;

  drawLedCenteredFx(timeStr, cx, timeTopY, TIME, C_TIME, C_TIME_GLOW, TIME * 0.85);

  const timeW = measure(timeStr, TIME);
  const rightX = Math.round(cx + timeW / 2 + TIME * 0.7);
  const ampmTopY = timeTopY + Math.round(TIME * 0.2);
  const secTopY = ampmTopY + 5 * AMPM + Math.round(AMPM * 1.1);
  drawLedFx(ampm, rightX, ampmTopY, AMPM, C_SUB, C_SUB_GLOW, AMPM * 0.8);
  drawLedFx(secStr, rightX, secTopY, AMPM, C_SUB, C_SUB_GLOW, AMPM * 0.8);

  drawLedCenteredFx(weekStr, cx, weekTopY, WEEK, C_SUB, C_SUB_GLOW, WEEK * 0.8);
  drawLedCenteredFx(dateStr, cx, dateTopY, DATE, C_SUB, C_SUB_GLOW, DATE * 0.85);
  if (outStr) drawLedCenteredFx(outStr, cx, outTopY, OUT, C_SUB, C_SUB_GLOW, OUT * 0.8);
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
  for (let i = 0; i < composite.length; i++) composite[i] = blendPackedOver(bg[i], fg[i]);

  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, RENDER_W, RENDER_H);
  const [dx, dy] = driftOffset(now);
  ctx.save(); ctx.translate(dx, dy);
  drawAquariumDots();
  drawClock();
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
  $("chkOutside").checked = settings.showOutside;
  $("inpClock").value = settings.clockScale; $("clockVal").textContent = settings.clockScale.toFixed(2) + "x";
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
}
function bindPanel() {
  $("selUnit").addEventListener("change", (e) => { settings.unit = e.target.value; saveSettings(); populatePanel(); });
  $("chkOutside").addEventListener("change", (e) => { settings.showOutside = e.target.checked; saveSettings(); });
  $("inpClock").addEventListener("input", (e) => { settings.clockScale = parseFloat(e.target.value); $("clockVal").textContent = settings.clockScale.toFixed(2) + "x"; });
  $("inpClock").addEventListener("change", saveSettings);

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

  $("btnReset").addEventListener("click", () => { settings = defaults(); saveSettings(); buildScene(); populatePanel(); fetchOutsideTemp(); });
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
requestWakeLock();
requestAnimationFrame(loop);
setTimeout(fetchOutsideTemp, 1200);                 // initial outside-temp pull
setInterval(fetchOutsideTemp, 10 * 60 * 1000);      // refresh every 10 min
