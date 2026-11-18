#include <Arduino.h>
// ESP32-C3 native USB: with ARDUINO_USB_CDC_ON_BOOT=1 this reaches the USB-Serial/JTAG port.
void setup() {
    Serial.begin(115200);
    delay(1500);
}
void loop() {
    Serial.println("Aether ESP32-C3 firmware");
    delay(1000);
}
