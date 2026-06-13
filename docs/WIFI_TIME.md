# Wi-Fi and NTP Time

Wi-Fi is optional.

Without Wi-Fi credentials, the firmware boots normally and uses the firmware
compile time as a fallback clock. With Wi-Fi credentials, it connects briefly,
syncs time from NTP, then disconnects Wi-Fi by default.

## Configure Wi-Fi

Copy the example file:

```powershell
Copy-Item include/WifiSecrets.example.h include/WifiSecrets.h
```

Edit `include/WifiSecrets.h`:

```cpp
#pragma once

#define CYD_WIFI_SSID "Your WiFi name"
#define CYD_WIFI_PASSWORD "Your WiFi password"
#define CYD_TIMEZONE "CST6CDT,M3.2.0/2,M11.1.0/2"
```

`include/WifiSecrets.h` is ignored by git. Keep it private.

## Timezone

The default timezone is US Central with daylight saving time:

```cpp
#define CYD_TIMEZONE "CST6CDT,M3.2.0/2,M11.1.0/2"
```

You can replace it with another POSIX timezone string if you live elsewhere.

Examples:

```cpp
#define CYD_TIMEZONE "EST5EDT,M3.2.0/2,M11.1.0/2"
#define CYD_TIMEZONE "MST7MDT,M3.2.0/2,M11.1.0/2"
#define CYD_TIMEZONE "PST8PDT,M3.2.0/2,M11.1.0/2"
```

## Sync Behavior

Default behavior:

- connect to Wi-Fi on boot if credentials exist;
- request NTP time from public NTP servers;
- update the local clock base;
- disconnect Wi-Fi after a successful sync;
- retry later if connection or NTP fails;
- resync every 6 hours after success.

This keeps the aquarium display simple and avoids keeping Wi-Fi active all the
time.
