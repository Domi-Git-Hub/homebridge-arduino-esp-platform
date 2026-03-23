# ArduinoESPServer

Arduino IDE library for ESP8266 and ESP32 projects that communicate with a ESP JSON server.

## Features

- Wi-Fi connection
- Optional Arduino OTA
- Poll JSON from a VPin
- Update JSON to a VPin
- One device can use one VPin or many VPins
- English comments and standard project structure

## Server API format

- Read one VPin:
  - `GET http://YOUR_SERVER/TOKEN/get/V1`
- Update one VPin:
  - `POST http://YOUR_SERVER/TOKEN/update/V1`
  - body: `value={...json...}`

## Install in Arduino IDE

Copy the folder `ArduinoESPServer` into your Arduino libraries folder.

Then restart Arduino IDE.

## Basic standard

```cpp
#include <ArduinoESPServer.h>

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_BASE_URL = "http://192.168.2.47:8181";
const char* PROJECT_TOKEN = "YOUR_48_CHARACTER_PROJECT_TOKEN";
StaticJsonDocument<256> doc;
String json = "";

ESPServerClient server(WIFI_SSID, WIFI_PASSWORD, SERVER_BASE_URL, PROJECT_TOKEN);

void pollVpinFromServer(String Vpin) {
  if (server.pollVpin(Vpin, json)) {
    deserializeJson(doc, json);
  }
}

void updateVpinFromServer(String Vpin) {
  json = "";
  serializeJson(doc, json);
  server.updateVpin(Vpin, json);
}
```

## Multiple VPins

A device can read and update more than one VPin.

```cpp
pollVpinFromServer("V1");
pollVpinFromServer("V2");
updateVpinFromServer("V1");
updateVpinFromServer("V2");
```

## Included examples

- `00_ProjectTemplate`
- `01_Outlet`
- `02_Switch`
- `03_Valve`
- `04_Irrigation`
- `05_Leak_Sensor`
- `06_Light_RGB`
