# Attribution

ESP32 CYD Aquarium is based on
[Livegrid OpenMatrix](https://github.com/livegrid/OpenMatrix).

OpenMatrix is an AGPL-3.0 project originally designed for controlling HUB75 RGB
matrix panels with ESP32 boards. This repository is an independent adaptation
for the ESP32-2432S028R / Cheap Yellow Display style board. It keeps the spirit
of the original aquarium while adapting the rendering, hardware target, timing,
backlight behavior, and standalone scene tuning for a small ILI9341 TFT module.

## Original Project

- Project: Livegrid OpenMatrix
- URL: https://github.com/livegrid/OpenMatrix
- License: GNU Affero General Public License v3.0

## What This Adaptation Adds

- Standalone CYD aquarium firmware target.
- ILI9341 TFT output for the 240x320 display.
- XPT2046 touch mapping for optional touch-to-feed.
- Dot-grid renderer for an LED-matrix-like look on the TFT.
- Display calibration for the tested ESP32-2432S028R panel.
- 180 degree display rotation support.
- Autonomous aquarium behavior so the scene lives without touch input.
- 12-hour clock overlay with AM/PM and seconds.
- Wi-Fi/NTP time sync with compile-time fallback.
- Automatic backlight from the onboard GPIO34 light sensor.
- A default CYD-focused build that does not require external temperature,
  humidity, or CO2 sensors.
- Public hardware, build, and troubleshooting documentation for CYD users.

## License Note

Because this is derived from an AGPL-3.0 project, this repository is also
published under AGPL-3.0. Keep the license and attribution intact when sharing
modified versions.
