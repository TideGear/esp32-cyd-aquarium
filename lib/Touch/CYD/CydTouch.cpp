#ifdef PANEL_CYD_TFT

#include "CydTouch.h"

#ifndef CYD_TFT_ROTATION
#define CYD_TFT_ROTATION 0
#endif

#ifndef CYD_TOUCH_ROTATE_180
#define CYD_TOUCH_ROTATE_180 (CYD_TFT_ROTATION == 2)
#endif

CydTouch::CydTouch() {}

void CydTouch::init() {
  pinMode(CydMatrixSettings::TOUCH_CS_PIN, OUTPUT);
  pinMode(CydMatrixSettings::TOUCH_SCLK_PIN, OUTPUT);
  pinMode(CydMatrixSettings::TOUCH_MOSI_PIN, OUTPUT);
  pinMode(CydMatrixSettings::TOUCH_MISO_PIN, INPUT);
  pinMode(CydMatrixSettings::TOUCH_IRQ_PIN, INPUT_PULLUP);

  digitalWrite(CydMatrixSettings::TOUCH_CS_PIN, HIGH);
  digitalWrite(CydMatrixSettings::TOUCH_SCLK_PIN, LOW);
  digitalWrite(CydMatrixSettings::TOUCH_MOSI_PIN, LOW);
}

uint16_t CydTouch::readRawAxis(uint8_t command) const {
  uint16_t value = 0;

  digitalWrite(CydMatrixSettings::TOUCH_CS_PIN, LOW);
  delayMicroseconds(2);

  for (int bit = 7; bit >= 0; --bit) {
    digitalWrite(CydMatrixSettings::TOUCH_MOSI_PIN, (command >> bit) & 0x01);
    digitalWrite(CydMatrixSettings::TOUCH_SCLK_PIN, HIGH);
    delayMicroseconds(1);
    digitalWrite(CydMatrixSettings::TOUCH_SCLK_PIN, LOW);
    delayMicroseconds(1);
  }

  for (int bit = 15; bit >= 0; --bit) {
    digitalWrite(CydMatrixSettings::TOUCH_SCLK_PIN, HIGH);
    delayMicroseconds(1);
    value <<= 1;
    if (digitalRead(CydMatrixSettings::TOUCH_MISO_PIN)) {
      value |= 1;
    }
    digitalWrite(CydMatrixSettings::TOUCH_SCLK_PIN, LOW);
    delayMicroseconds(1);
  }

  digitalWrite(CydMatrixSettings::TOUCH_CS_PIN, HIGH);
  return (value >> 3) & 0x0FFF;
}

uint16_t CydTouch::mapRawAxis(int raw, int rawMin, int rawMax, uint16_t outMax,
                              bool invert) const {
  const int limited = constrain(raw, rawMin, rawMax);
  const long mapped =
      map(limited, rawMin, rawMax, 0, static_cast<long>(outMax));
  const uint16_t value = static_cast<uint16_t>(constrain(mapped, 0L, static_cast<long>(outMax)));
  return invert ? outMax - value : value;
}

const CydTouchPoint& CydTouch::update() {
  previousPressed = point.pressed;
  point.pressed = digitalRead(CydMatrixSettings::TOUCH_IRQ_PIN) == LOW;

  if (!point.pressed) {
    return point;
  }

  point.rawX = readRawAxis(0xD0);
  point.rawY = readRawAxis(0x90);

  const uint16_t mappedX =
      mapRawAxis(point.rawX, CydMatrixSettings::TOUCH_RAW_MIN_X,
                 CydMatrixSettings::TOUCH_RAW_MAX_X,
                 CydMatrixSettings::PHYSICAL_WIDTH - 1,
                 CydMatrixSettings::TOUCH_INVERT_X);
  const uint16_t mappedY =
      mapRawAxis(point.rawY, CydMatrixSettings::TOUCH_RAW_MIN_Y,
                 CydMatrixSettings::TOUCH_RAW_MAX_Y,
                 CydMatrixSettings::PHYSICAL_HEIGHT - 1,
                 CydMatrixSettings::TOUCH_INVERT_Y);

  uint16_t screenX = CydMatrixSettings::TOUCH_SWAP_XY ? mappedY : mappedX;
  uint16_t screenY = CydMatrixSettings::TOUCH_SWAP_XY ? mappedX : mappedY;
#if CYD_TOUCH_ROTATE_180
  screenX = CydMatrixSettings::PHYSICAL_WIDTH - 1 - screenX;
  screenY = CydMatrixSettings::PHYSICAL_HEIGHT - 1 - screenY;
#endif

  point.screenX = screenX;
  point.screenY = screenY;
  point.logicalX = CydMatrixSettings::logicalXFromScreen(point.screenX);
  point.logicalY = CydMatrixSettings::logicalYFromScreen(point.screenY);

  return point;
}

bool CydTouch::isPressed() const {
  return point.pressed;
}

bool CydTouch::pressedStarted() const {
  return point.pressed && !previousPressed;
}

bool CydTouch::pressedReleased() const {
  return !point.pressed && previousPressed;
}

const CydTouchPoint& CydTouch::currentPoint() const {
  return point;
}

#endif  // PANEL_CYD_TFT
