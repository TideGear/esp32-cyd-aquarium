<script>
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import {
    DEFAULT_PANEL_MODE_ID,
    ENVIRONMENT,
    PANEL_MODE_IDS,
    PANEL_MODES,
    PRESENTATION_ORDER,
    UPDATE_ORDER,
  } from "@/lib/aquarium/constants.js";
  import { createAquariumEngine } from "@/lib/aquarium/engine.js";
  import { createFixedEnvironment } from "@/lib/aquarium/environment.js";
  import { createAquariumFramebuffer } from "@/lib/aquarium/framebuffer.js";
  import { drawCenteredPixelText, measurePixelText } from "@/lib/aquarium/pixel-text.js";
  import { CanvasAquariumRenderer, RENDER_STYLES, SCALE_MODES } from "@/lib/aquarium/renderer.js";

  export let modeId = DEFAULT_PANEL_MODE_ID;
  export let scaleMode = SCALE_MODES.FIT;
  export let renderStyle = RENDER_STYLES.DOTS;
  export let running = true;
  export let debug = false;
  export let clockOverlay = true;
  export let engine = null;

  const dispatch = createEventDispatcher();
  const environment = createFixedEnvironment();

  let canvas;
  let renderer;
  let framebuffer;
  let ownedEngine = null;
  let activeEngine = null;
  let externalEngine = null;
  let frameId = null;
  let mounted = false;
  let activeModeId = null;
  let lastFrameTime = 0;
  let lastDebugTime = 0;
  let touchPoint = null;
  let debugSnapshotJson = "{}";
  let lastClockOverlay = null;

  const getMode = (id) => PANEL_MODES[id] ?? PANEL_MODES[DEFAULT_PANEL_MODE_ID];
  const arraysEqual = (left = [], right = []) =>
    left.length === right.length && left.every((item, index) => item === right[index]);
  const pad2 = (value) => String(value).padStart(2, "0");
  const dayLabels = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const monthLabels = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

  const resetPanel = () => {
    const mode = getMode(modeId);
    activeModeId = mode.id;
    framebuffer = createAquariumFramebuffer(mode.id);

    if (!renderer) {
      renderer = new CanvasAquariumRenderer(canvas, {
        modeId: mode.id,
        scaleMode,
        renderStyle,
      });
    }

    renderer.modeId = mode.id;
    renderer.scaleMode = scaleMode;
    renderer.renderStyle = renderStyle;
    renderer.targetWidth = mode.physicalWidth ?? mode.logicalWidth;
    renderer.targetHeight = mode.physicalHeight ?? mode.logicalHeight;
    touchPoint = null;

    if (engine) {
      ownedEngine?.destroy?.();
      ownedEngine = null;
      activeEngine = engine;
    } else {
      if (!ownedEngine) {
        ownedEngine = createAquariumEngine({ mode, environment });
      }
      activeEngine = ownedEngine;
    }

    externalEngine = engine;
    activeEngine?.resize?.({ mode, framebuffer, environment });
  };

  const drawDiagnosticFrame = (now) => {
    const { width, height, background, foreground } = framebuffer;
    const shimmerA = now * 0.002;
    const shimmerB = now * 0.0012;

    for (let y = 0; y < height; y += 1) {
      const depth = y / Math.max(1, height - 1);
      for (let x = 0; x < width; x += 1) {
        const wave = Math.sin(x * 0.35 + shimmerA) + Math.sin((x + y) * 0.18 + shimmerB);
        background.setPixel(x, y, {
          r: Math.max(0, Math.round(1 + wave * 2)),
          g: Math.round(38 + wave * 8 - depth * 8),
          b: Math.round(82 + wave * 6 - depth * 18),
        });
      }
    }

    foreground.clear();
    foreground.drawLine(0, 0, width - 1, 0, { r: 20, g: 150, b: 160, a: 170 });
    foreground.drawLine(0, height - 1, width - 1, height - 1, { r: 0, g: 62, b: 64, a: 180 });
    foreground.drawLine(0, 0, 0, height - 1, { r: 14, g: 112, b: 128, a: 150 });
    foreground.drawLine(width - 1, 0, width - 1, height - 1, { r: 14, g: 112, b: 128, a: 150 });

    for (let x = 8; x < width; x += 8) {
      foreground.drawPixel(x, 1, { r: 54, g: 180, b: 174, a: 160 });
      foreground.drawPixel(x, height - 2, { r: 16, g: 116, b: 120, a: 150 });
    }

    const sweepX = Math.round(((Math.sin(now * 0.001) + 1) / 2) * (width - 1));
    const sweepY = Math.round(height * 0.28 + Math.sin(now * 0.0016) * height * 0.08);
    foreground.drawPixel(sweepX, sweepY, { r: 245, g: 224, b: 96 });
    foreground.drawPixel(Math.max(0, sweepX - 1), sweepY, { r: 42, g: 210, b: 164, a: 220 });

    if (touchPoint) {
      foreground.fillCircle(touchPoint.x, touchPoint.y, 2, { r: 255, g: 228, b: 80, a: 230 });
      foreground.drawLine(touchPoint.x - 3, touchPoint.y, touchPoint.x + 3, touchPoint.y, { r: 255, g: 255, b: 255, a: 190 });
      foreground.drawLine(touchPoint.x, touchPoint.y - 3, touchPoint.x, touchPoint.y + 3, { r: 255, g: 255, b: 255, a: 190 });
    }
  };

  const getClockOverlayText = (date = new Date()) => ({
    time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
    date: `${dayLabels[date.getDay()]} ${pad2(date.getDate())} ${monthLabels[date.getMonth()]}`,
  });

  const drawClockOverlay = (now) => {
    if (!clockOverlay || !framebuffer?.foreground) return null;

    const { width, height, foreground } = framebuffer;
    const overlay = getClockOverlayText();
    const centerX = Math.round(width / 2);
    const timeScale = width >= 74 ? 2 : 1;
    const timeSize = measurePixelText(overlay.time, { scale: timeScale, letterSpacing: timeScale });
    const dateSize = measurePixelText(overlay.date, { scale: 1, letterSpacing: 1 });
    const topY = 3;
    const bottomY = Math.max(topY + timeSize.height + 3, height - dateSize.height - 3);

    const pulse = Math.round(((Math.sin(now * 0.004) + 1) / 2) * 24);
    const timeColor = { r: 208 + pulse, g: 248, b: 234 + Math.floor(pulse / 2), a: 236 };
    const dateColor = { r: 132, g: 222, b: 190, a: 220 };

    drawCenteredPixelText(foreground, overlay.time, centerX, topY, {
      scale: timeScale,
      letterSpacing: timeScale,
      color: timeColor,
    });
    drawCenteredPixelText(foreground, overlay.date, centerX, bottomY, {
      scale: 1,
      letterSpacing: 1,
      color: dateColor,
    });

    lastClockOverlay = {
      enabled: true,
      time: overlay.time,
      date: overlay.date,
      timeScale,
      backdrop: false,
      topY,
      bottomY,
    };
    return lastClockOverlay;
  };

  const updateEngineFrame = (now, delta) => {
    if (!activeEngine) {
      drawDiagnosticFrame(now);
      return;
    }

    const frameContext = {
      now,
      delta,
      framebuffer,
      environment,
      touchPoint,
      mode: getMode(activeModeId),
    };

    if (typeof activeEngine.update === "function") {
      activeEngine.update(frameContext);
    }

    if (typeof activeEngine.display === "function") {
      activeEngine.display(frameContext);
    } else if (typeof activeEngine.render === "function") {
      activeEngine.render(frameContext);
    }

    drawClockOverlay(now);
  };

  const refreshDebugSnapshot = (now, rendererSnapshot) => {
    if (now - lastDebugTime < 250) return;
    lastDebugTime = now;
    const engineSnapshot = activeEngine?.getDebugSnapshot?.() ?? {};
    const framebufferSnapshot = framebuffer.getDebugSnapshot();
    const presentationOrder = [...PRESENTATION_ORDER];
    const observedOrder = [...(engineSnapshot.updateOrder?.engine ?? []), ...presentationOrder];
    const expectedOrder = [...UPDATE_ORDER];
    const activeMode = getMode(activeModeId);
    const debugChecks = {
      modeOk: framebufferSnapshot.mode === activeModeId && rendererSnapshot.mode === activeModeId,
      physicalSizeOk:
        rendererSnapshot.physicalWidth === (activeMode.physicalWidth ?? activeMode.logicalWidth) &&
        rendererSnapshot.physicalHeight === (activeMode.physicalHeight ?? activeMode.logicalHeight),
      fixedEnvironmentOk:
        environment.temperatureC === ENVIRONMENT.NORMAL_TEMPERATURE_C && environment.co2Ppm === ENVIRONMENT.NORMAL_CO2_PPM,
      updateOrderOk: arraysEqual(observedOrder, expectedOrder),
      stateShapeOk: "state" in engineSnapshot && Boolean(engineSnapshot.state?.filename),
      fishPresent: (engineSnapshot.fish?.count ?? 0) > 0,
    };

    debugSnapshotJson = JSON.stringify({
      ...framebufferSnapshot,
      ...rendererSnapshot,
      environment,
      touchPoint,
      clockOverlay: lastClockOverlay ?? { enabled: Boolean(clockOverlay) },
      engine: Boolean(activeEngine),
      externalEngine: Boolean(engine),
      ...engineSnapshot,
      updateOrder: {
        ...(engineSnapshot.updateOrder ?? {}),
        presentation: presentationOrder,
        observedFrame: observedOrder,
        expectedFrame: expectedOrder,
        frameMatchesExpected: arraysEqual(observedOrder, expectedOrder),
      },
      debugChecks,
    });
  };

  const renderFrame = (now) => {
    if (!mounted || !framebuffer || !renderer) return;

    const delta = lastFrameTime ? Math.min(80, now - lastFrameTime) : 0;
    lastFrameTime = now;

    if (running) {
      updateEngineFrame(now, delta);
      const rendererSnapshot = renderer.presentFramebuffer(framebuffer, {
        scaleMode,
        renderStyle,
        clearForeground: true,
      });
      refreshDebugSnapshot(now, rendererSnapshot);
    }

    frameId = requestAnimationFrame(renderFrame);
  };

  const dispatchPointer = (phase, event) => {
    if (!renderer) return;
    event.preventDefault();

    if (phase === "down") {
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    }

    const point = renderer.pointerToLogical(event);
    if (point) {
      touchPoint = point;
    }

    if (phase === "down") {
      activeEngine?.onTouchStarted?.({ point, now: performance.now() });
    } else if (phase === "up" || phase === "cancel") {
      activeEngine?.onTouchReleased?.();
    }

    dispatch("panelpointer", {
      phase,
      point,
      modeId: activeModeId,
      environment,
    });
  };

  $: if (mounted && modeId !== activeModeId) {
    resetPanel();
  }

  $: if (mounted && engine !== externalEngine) {
    resetPanel();
  }

  $: if (renderer) {
    renderer.scaleMode = scaleMode;
    renderer.renderStyle = renderStyle;
  }

  onMount(() => {
    mounted = true;
    resetPanel();
    frameId = requestAnimationFrame(renderFrame);
  });

  onDestroy(() => {
    mounted = false;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
    }
    ownedEngine?.destroy?.();
  });
</script>

<div class:original-mode={modeId === PANEL_MODE_IDS.ORIGINAL_64} class="device-preview">
  <canvas
    bind:this={canvas}
    aria-label="Aquarium device panel preview"
    class="device-canvas"
    data-debug={debugSnapshotJson}
    on:pointerdown={(event) => dispatchPointer("down", event)}
    on:pointermove={(event) => dispatchPointer("move", event)}
    on:pointerup={(event) => dispatchPointer("up", event)}
    on:pointercancel={(event) => dispatchPointer("cancel", event)}
  ></canvas>

  {#if debug}
    <pre class="debug-readout">{debugSnapshotJson}</pre>
  {/if}
</div>

<style>
  .device-preview {
    box-sizing: border-box;
    width: min(100%, 260px);
    margin: 0 auto;
    padding: 10px;
    border-radius: 8px;
    background:
      linear-gradient(145deg, rgba(255, 255, 255, 0.08), transparent 34%),
      #05080a;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      inset 0 0 28px rgba(0, 0, 0, 0.82),
      0 18px 48px rgba(0, 0, 0, 0.28);
  }

  .device-preview.original-mode {
    width: min(100%, 260px);
  }

  .device-canvas {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 3 / 4;
    border-radius: 4px;
    background: #00161a;
    cursor: crosshair;
    image-rendering: pixelated;
    touch-action: none;
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.07),
      0 0 22px rgba(20, 184, 166, 0.16);
  }

  .original-mode .device-canvas {
    aspect-ratio: 1 / 1;
  }

  .debug-readout {
    margin: 8px 0 0;
    max-height: 140px;
    overflow: auto;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.72);
    padding: 8px;
    color: #c8f7ec;
    font-size: 10px;
    line-height: 1.4;
    white-space: pre-wrap;
  }
</style>
