#pragma once

#ifdef PANEL_CYD_TFT

#include <Arduino.h>

#include "CYD/CydMatrixSettings.h"

struct CydTouchPoint {
  bool pressed = false;
  uint16_t rawX = 0;
  uint16_t rawY = 0;
  uint16_t screenX = 0;
  uint16_t screenY = 0;
  uint16_t logicalX = 0;
  uint16_t logicalY = 0;
};

class CydTouch {
 private:
  CydTouchPoint point;
  bool previousPressed = false;

  uint16_t readRawAxis(uint8_t command) const;
  uint16_t mapRawAxis(int raw, int rawMin, int rawMax, uint16_t outMax,
                      bool invert) const;

 public:
  CydTouch();

  void init();
  const CydTouchPoint& update();

  bool isPressed() const;
  bool pressedStarted() const;
  bool pressedReleased() const;
  const CydTouchPoint& currentPoint() const;
};

#endif  // PANEL_CYD_TFT
