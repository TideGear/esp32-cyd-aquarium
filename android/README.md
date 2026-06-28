# Aquarium Clock (Android)

Full-screen 1920x1080 app: a large 12-hour clock (AM/PM, seconds, blinking
colon), the date in mm/dd/yyyy, and the day of week, over a living "digital
aquarium" rendered as a dot-grid LED matrix. The screen is kept awake and the
whole scene drifts slowly to prevent burn-in.

## Settings (tap the screen)
Tap anywhere to open settings; tap outside the panel (or "Done") to close.
Settings persist on the device. You can change:
- Temperature units - Fahrenheit (default) or Celsius.
- Outside weather - enter a zip/postal code (+ country, default US). The app
  looks up the location and pulls the current outside temperature from the
  Internet, shows it on screen, and can use it to colour the water. No API key.
- Water color range - cold end (bluest) and hot end (reddest), plus a manual
  water temperature for when the live feed is off/unavailable.
- Aquarium life - number of fish, plants, schooling dots.
- LED grid (Fine/Normal/Chunky), clock size, show/hide outside temperature.

### Water temperature range
The upstream water palette sweeps 10C-35C (50F-95F), neutral teal-green around
21-22C (~70F); colder trends blue, hotter trends green->amber->red. Those ends
are adjustable and the live outside temperature is mapped onto that window.

### Network / privacy
Only when a zip is set, two public key-less endpoints are used: api.zippopotam.us
(zip -> lat/long) and api.open-meteo.com (current temperature). Nothing else is
sent; no analytics. Needs the INTERNET permission; with no zip it never uses the
network.

## The aquarium is the real thing
Not a re-creation: it runs the actual simulation modules from esp32-cyd-aquarium
(https://github.com/Lagerpun/esp32-cyd-aquarium) - the JS port from its browser
preview (ui/src/lib/aquarium): engine, framebuffer, water, fish/snake/turtle/
star/octopus bodies + motions, boids, plants, food, colour palette, FastLED
noise port and the 3x5 pixel font - bundled verbatim into assets/bundle.js. The
clock styling (blinking colon, AM/PM + seconds layout, (224,248,238)/(132,222,190)
colours, dot renderer radius ratio 0.43) mirrors the device renderClockOverlay.
The app drives the engine sub-steps directly (engine.update() force-resets the
environment to a fixed 22C) so the water can follow the configured/real temp.

## Install
Debug-signed; sideload it: copy AquariumClock.apk to the device, enable "install
unknown apps" for your file manager/browser, open and install, launch "Aquarium
Clock". Min Android 5.0 (API 21), targets Android 14. Best left in landscape.

## Rebuild
No Gradle. npm i esbuild; then
./node_modules/.bin/esbuild jsrc/app.js --bundle --format=iife --target=es2017 --minify --outfile=assets/bundle.js
then aapt2 compile/link -> javac -> d8 -> zipalign -> apksigner.

## License
Upstream esp32-cyd-aquarium is AGPL-3.0 (adapted from Livegrid OpenMatrix, also
AGPL-3.0). This app reuses that code, so it is a derivative under AGPL-3.0;
LICENSE/NOTICE included. Distributing it requires AGPL-3.0 compliance (including
offering source). Not affiliated with or endorsed by the upstream authors.
