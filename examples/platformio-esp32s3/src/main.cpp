#include <Arduino.h>
void setup() {
    Serial.begin(115200);
}
void loop() {
    Serial.println("Aether ESP32-S3 firmware");
    delay(1000);
}
