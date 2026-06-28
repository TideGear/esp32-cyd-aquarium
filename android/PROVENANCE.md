# Provenance check: OpenMatrix vs. what this app runs

Generated 2026-06-28 05:34 UTC. I downloaded both repos as source
tarballs and compared them directly:
  - livegrid/OpenMatrix            (the original; HUB75 RGB LED matrix firmware)
  - Lagerpun/esp32-cyd-aquarium    (the CYD fork this app's JS came from)

## The aquarium is OpenMatrix's

OpenMatrix ships the full aquarium in lib/Aquarium/ (Water, Plants, BoidManager,
Food, Body/ + BodyVariations for Fish/Snake/Turtle/Star/Octopus, Motion/ for each,
ColorPalette). Comparing that whole tree against the CYD fork:

  lib/Aquarium files compared : 28
  byte-identical              : 23
  differing                   : 5
  only-in-one                 : 0

### The only files the CYD fork changed
```
Files OpenMatrix/lib/Aquarium/Aquarium.h and esp32-cyd-aquarium/lib/Aquarium/Aquarium.h differ
Files OpenMatrix/lib/Aquarium/AquariumSettings.h and esp32-cyd-aquarium/lib/Aquarium/AquariumSettings.h differ
Files OpenMatrix/lib/Aquarium/AquariumStateManager.cpp and esp32-cyd-aquarium/lib/Aquarium/AquariumStateManager.cpp differ
Files OpenMatrix/lib/Aquarium/Fish.h and esp32-cyd-aquarium/lib/Aquarium/Fish.h differ
Files OpenMatrix/lib/Aquarium/Motion/Motion.h and esp32-cyd-aquarium/lib/Aquarium/Motion/Motion.h differ
```
Every creature body, every motion, the water, plants, boids, food and colour
palette are identical. The differences are confined to the orchestrator (Aquarium.h),
the settings counts (AquariumSettings.h), Fish.h, the motion base (Motion.h), and the
persistence path (AquariumStateManager.cpp).

### What AquariumSettings.h changed (OpenMatrix -> CYD)
```
26a27,30
> #if defined(PANEL_CYD_TFT)
> #define NUM_FISH_START 8
> #define NUM_FISH_IDEAL 12
> #else
28c32,33
< #define NUM_FISH_IDEAL 20
---
> #define NUM_FISH_IDEAL 10
> #endif
136c141
< #define BOID_MAX_FORCE 1, 2
\ No newline at end of file
---
> #define BOID_MAX_FORCE 1, 2
```

## What THIS app runs matches OpenMatrix's original numbers

The browser/JS port (ui/src/lib/aquarium) does not exist in OpenMatrix; the CYD author
wrote it as a faithful translation of the C++. Notably it kept OpenMatrix's ORIGINAL
parameters rather than the CYD device tweaks:

  creature odds : Fish .5 / Star .1 / Turtle .2 / Snake .1 / Octopus .1   (= OpenMatrix)
  water range   : 10..35 C, deep-blue(0,28,72) -> anchor(0,100,80) -> red(100,0,0)
  fish counts   : start 5, ideal 20      physics scale: 80

(The CYD *device* firmware instead uses start 8 / ideal 12 and a richer mix
Fish .62 / Star .18 / Turtle .08 / Snake .06; this app does NOT use those.)

## Method / limits
- Compared from source tarballs of each repo's main branch.
- GitHub blocked automated browsing of the file tree, so this is from the downloaded
  source, not the web UI.
- The C++ is the device implementation; the app runs the CYD JS port of it, which I
  verified mirrors the same constants and logic.
