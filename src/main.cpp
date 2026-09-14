#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>

// ============================================================
//                      PARKING CONFIG
// ============================================================

const int NUM_SPOTS = 16;
const int ZONE_ID = 1;


// Shared ultrasonic interface
const int TRIG_PIN = 2;
const int ECHO_PIN = 3;


// Multiplexer address pins
const int MUX_S0 = 4;
const int MUX_S1 = 5;
const int MUX_S2 = 6;
const int MUX_S3 = 7;


// ============================================================
//                     HIL CONTROL BUS
// ============================================================

const int CTRL_CS   = 8;
const int CTRL_CLK  = 9;
const int CTRL_DATA = 10;
char hilCommandBuffer[64];
size_t hilCommandIndex = 0;


// ============================================================
//                         STATES
// ============================================================

enum SpotState {
    UNKNOWN,
    FREE,
    OCCUPIED
};

SpotState lastStates[NUM_SPOTS] = {};
SpotState physicalStates[NUM_SPOTS] = {};
SpotState candidateStates[NUM_SPOTS] = {};

int candidateCounts[NUM_SPOTS] = {};

const int REQUIRED_CONFIRMATIONS = 3;

const float OCCUPIED_THRESHOLD = 80.0;
const float FREE_THRESHOLD = 100.0;


int sensorTimeoutCounts[NUM_SPOTS] = {};
bool sensorFaults[NUM_SPOTS] = {};

const int SENSOR_FAILURE_THRESHOLD = 3;


// ============================================================
//                      SENSOR TIMING
// ============================================================

int currentSensor = 0;

unsigned long lastSensorRead = 0;
const unsigned long SENSOR_READ_INTERVAL = 60;

unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL = 5000;


// ============================================================
//                      WIFI / MQTT CONFIG
// ============================================================

const char* WIFI_SSID = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";

const char* MQTT_SERVER = "broker.hivemq.com";
const int MQTT_PORT = 1883;

unsigned long lastWifiReconnectAttempt = 0;
const unsigned long WIFI_RECONNECT_INTERVAL = 5000;

unsigned long lastMqttReconnectAttempt = 0;
const unsigned long MQTT_RECONNECT_INTERVAL = 5000;

WiFiClient espClient;
PubSubClient mqttClient(espClient);


// ============================================================
//                    HIL SEND DISTANCE
// ============================================================

void hilSendDistance(
    uint8_t channel,
    float distance
) {

    uint16_t distance100 =
        (uint16_t)(distance * 100.0f);

    uint32_t packet =
        ((uint32_t)channel << 16) |
        distance100;


    // Start transaction
    digitalWrite(CTRL_CS, LOW);

    delayMicroseconds(10);


    // Send 24 bits MSB first
    for (int bit = 23; bit >= 0; bit--) {

        int value =
            (packet >> bit) & 0x01;

        digitalWrite(
            CTRL_DATA,
            value
        );

        delayMicroseconds(5);


        // Rising edge = HIL reads DATA
        digitalWrite(
            CTRL_CLK,
            HIGH
        );

        delayMicroseconds(10);


        digitalWrite(
            CTRL_CLK,
            LOW
        );

        delayMicroseconds(10);
    }


    // Finish transaction
    digitalWrite(
        CTRL_CS,
        HIGH
    );

}


// ============================================================
//                      MQTT CONNECTION
// ============================================================

void connectMQTT() {

    String clientID =
        "parking-sensor in zone " +
        String(ZONE_ID);

    Serial.print("[MQTT] Connecting as ");
    Serial.print(clientID);
    Serial.print("...");

    if (mqttClient.connect(clientID.c_str())) {

        Serial.println("connected");

        for (int i = 0; i < NUM_SPOTS; i++) {
            lastStates[i] = UNKNOWN;
        }
    }
    else {

        Serial.print("failed, state: ");
        Serial.println(mqttClient.state());
    }
}


// ============================================================
//                      CONNECTIVITY
// ============================================================

void handleConnectivity(
    unsigned long now
) {

    if (WiFi.status() != WL_CONNECTED) {

        if (
            now - lastWifiReconnectAttempt >=
            WIFI_RECONNECT_INTERVAL
        ) {

            lastWifiReconnectAttempt = now;

            Serial.println(
                "[WiFi] Reconnecting..."
            );

            WiFi.disconnect();

            WiFi.begin(
                WIFI_SSID,
                WIFI_PASSWORD,
                6
            );
        }

        return;
    }


    if (!mqttClient.connected()) {

        if (
            now - lastMqttReconnectAttempt >=
            MQTT_RECONNECT_INTERVAL
        ) {

            lastMqttReconnectAttempt = now;

            connectMQTT();
        }

        return;
    }


    mqttClient.loop();
}


// ============================================================
//                      DISTANCE SENSOR
// ============================================================

float readDistance() {

    digitalWrite(
        TRIG_PIN,
        LOW
    );

    delayMicroseconds(2);


    digitalWrite(
        TRIG_PIN,
        HIGH
    );

    delayMicroseconds(10);


    digitalWrite(
        TRIG_PIN,
        LOW
    );


    long duration =
        pulseIn(
            ECHO_PIN,
            HIGH,
            30000
        );


    if (duration == 0) {
        return -1;
    }


    return duration * 0.0343 / 2.0;
}


// ============================================================
//                     SELECT SENSOR
// ============================================================

void selectSensor(int channel) {

    digitalWrite(
        MUX_S0,
        (channel >> 0) & 0x01
    );

    digitalWrite(
        MUX_S1,
        (channel >> 1) & 0x01
    );

    digitalWrite(
        MUX_S2,
        (channel >> 2) & 0x01
    );

    digitalWrite(
        MUX_S3,
        (channel >> 3) & 0x01
    );


    delayMicroseconds(10);
}


// ============================================================
//                      STATE LOGIC
// ============================================================

SpotState updatePhysicalState(
    int i,
    float distance
) {

    SpotState proposedState =
        physicalStates[i];


    if (physicalStates[i] == UNKNOWN) {

    proposedState =
        (distance < OCCUPIED_THRESHOLD)
        ? OCCUPIED
        : FREE;
    }


    else if (
        physicalStates[i] == FREE &&
        distance < OCCUPIED_THRESHOLD
    ) {

        proposedState = OCCUPIED;
    }


    else if (
        physicalStates[i] == OCCUPIED &&
        distance > FREE_THRESHOLD
    ) {

        proposedState = FREE;
    }


    if (
        proposedState ==
        physicalStates[i]
    ) {

        candidateStates[i] =
            UNKNOWN;

        candidateCounts[i] = 0;

        return physicalStates[i];
    }


    if (
        candidateStates[i] ==
        proposedState
    ) {

        candidateCounts[i]++;
    }
    else {

        candidateStates[i] =
            proposedState;

        candidateCounts[i] = 1;
    }


    if (
        candidateCounts[i] >=
        REQUIRED_CONFIRMATIONS
    ) {

        physicalStates[i] =
            proposedState;

        candidateStates[i] =
            UNKNOWN;

        candidateCounts[i] = 0;
    }


    return physicalStates[i];
}


// ============================================================
//                      MQTT PUBLISH
// ============================================================

void publishState(
    int i,
    float distance,
    SpotState state
) {

    if (!mqttClient.connected()) {
        return;
    }


    if (state == UNKNOWN) {
        return;
    }


    if (state == lastStates[i]) {
        return;
    }


    String zoneId =
        "zone-" +
        String(ZONE_ID);

    String spotId =
        "spot-" +
        String(i + 1);


    String topic =
        "raslene/parking/" +
        zoneId +
        "/" +
        spotId;


    const char* status =
        (state == OCCUPIED)
        ? "OCCUPIED"
        : "FREE";


    char payload[150];


    snprintf(
        payload,
        sizeof(payload),

        "{\"zone_id\":%d,"
        "\"spot_id\":\"%s\","
        "\"distance\":%.2f,"
        "\"status\":\"%s\"}",

        ZONE_ID,
        spotId.c_str(),
        distance,
        status
    );


    bool published =
        mqttClient.publish(
            topic.c_str(),
            payload,
            true
        );


    if (published) {

        lastStates[i] = state;

        Serial.print(
            "[MQTT] State changed: "
        );

        Serial.print(spotId);

        Serial.print(" -> ");

        Serial.println(status);
    }
}


// ============================================================
//                       HEARTBEAT
// ============================================================

void publishHeartbeat(
    unsigned long now
) {

    if (!mqttClient.connected()) {
        return;
    }


    if (
        now - lastHeartbeat <
        HEARTBEAT_INTERVAL
    ) {
        return;
    }


    lastHeartbeat = now;


    String topic =
        "raslene/parking" +
        String(ZONE_ID) +
        "/heartbeat";


    char payload[100];


    snprintf(
        payload,
        sizeof(payload),

        "{\"zone_id\":%d,"
        "\"status\":\"ONLINE\","
        "\"uptime\":%lu}",

        ZONE_ID,
        millis()
    );


    mqttClient.publish(
        topic.c_str(),
        payload,
        false
    );


    Serial.println(
        "[MQTT] Heartbeat sent"
    );
}


// ============================================================
//                      SENSOR HEALTH
// ============================================================

void publishSensorHealth(
    int i,
    bool healthy
) {

    if (!mqttClient.connected()) {
        return;
    }


    String zoneId =
        "zone-" +
        String(ZONE_ID);

    String spotId =
        "spot-" +
        String(i + 1);


    String topic =
        "raslene/parking/" +
        zoneId +
        "/" +
        spotId +
        "/health";


    const char* health =
        healthy
        ? "OK"
        : "FAULT";


    char payload[100];


    snprintf(
        payload,
        sizeof(payload),

        "{\"zone_id\":%d,"
        "\"spot_id\":\"%s\","
        "\"sensor_health\":\"%s\"}",

        ZONE_ID,
        spotId.c_str(),
        health
    );


    mqttClient.publish(
        topic.c_str(),
        payload,
        true
    );
}


// ============================================================
//                      SENSOR SCANNING
// ============================================================

void scanSensor(
    unsigned long now
) {

    if (
        now - lastSensorRead <
        SENSOR_READ_INTERVAL
    ) {
        return;
    }


    lastSensorRead = now;


    int i = currentSensor;


    selectSensor(i);


    float distance =
        readDistance();


    if (distance < 0) {

        sensorTimeoutCounts[i]++;


        Serial.print("spot-");
        Serial.print(i + 1);

        Serial.println(
            " | Sensor timeout"
        );


        if (
            sensorTimeoutCounts[i] >=
            SENSOR_FAILURE_THRESHOLD &&
            !sensorFaults[i]
        ) {

            sensorFaults[i] = true;


            Serial.print(
                "[SENSOR] FAULT: spot-"
            );

            Serial.println(i + 1);


            publishSensorHealth(
                i,
                false
            );
        }
    }

    else {

        sensorTimeoutCounts[i] = 0;


        if (sensorFaults[i]) {

            sensorFaults[i] = false;


            Serial.print(
                "[SENSOR] RECOVERED: spot-"
            );

            Serial.println(i + 1);


            publishSensorHealth(
                i,
                true
            );
        }


        SpotState currentState =
            updatePhysicalState(
                i,
                distance
            );


        publishState(
            i,
            distance,
            currentState
        );
    }


    currentSensor++;


    if (
        currentSensor >=
        NUM_SPOTS
    ) {

        currentSensor = 0;
    }
}


// ============================================================
//                          SETUP
// ============================================================

void handleHilSerial() {

    while (Serial.available() > 0) {

        char c = Serial.read();

        // Complete command
        if (c == '\n') {

            hilCommandBuffer[hilCommandIndex] = '\0';

            int channel;
            float distance;

            if (
                sscanf(
                    hilCommandBuffer,
                    "%d,%f",
                    &channel,
                    &distance
                ) == 2
            ) {

                if (
                    channel >= 0 &&
                    channel < NUM_SPOTS
                ) {

                    hilSendDistance(
                        (uint8_t)channel,
                        distance
                    );
                }
            }

            hilCommandIndex = 0;
        }

        // Ignore carriage return
        else if (c == '\r') {
            continue;
        }

        // Store byte
        else {

            if (
                hilCommandIndex <
                sizeof(hilCommandBuffer) - 1
            ) {

                hilCommandBuffer[
                    hilCommandIndex++
                ] = c;
            }
            else {

                // Buffer overflow -> reset
                hilCommandIndex = 0;
            }
        }
    }
}



void setup() {

    Serial.begin(115200);

    delay(1000);

    Serial.println(
        "===== MCU STARTED ====="
    );


    // --------------------------------------------------------
    // Ultrasonic pins
    // --------------------------------------------------------

    pinMode(
        TRIG_PIN,
        OUTPUT
    );

    pinMode(
        ECHO_PIN,
        INPUT
    );


    // --------------------------------------------------------
    // Selector pins
    // --------------------------------------------------------

    pinMode(
        MUX_S0,
        OUTPUT
    );

    pinMode(
        MUX_S1,
        OUTPUT
    );

    pinMode(
        MUX_S2,
        OUTPUT
    );

    pinMode(
        MUX_S3,
        OUTPUT
    );


    // --------------------------------------------------------
    // HIL control pins
    // --------------------------------------------------------

    pinMode(
        CTRL_CS,
        OUTPUT
    );

    pinMode(
        CTRL_CLK,
        OUTPUT
    );

    pinMode(
        CTRL_DATA,
        OUTPUT
    );


    digitalWrite(
        CTRL_CS,
        HIGH
    );

    digitalWrite(
        CTRL_CLK,
        LOW
    );

    digitalWrite(
        CTRL_DATA,
        LOW
    );


    // --------------------------------------------------------
    // IMPORTANT ISOLATION TEST
    //
    // HIL defaults:
    // every channel = 200cm
    //
    // Change ONLY channel 4 to 25cm
    //
    // channel 4 = spot-5
    // --------------------------------------------------------


    // --------------------------------------------------------
    // WiFi / MQTT
    // --------------------------------------------------------

    WiFi.begin(
        WIFI_SSID,
        WIFI_PASSWORD,
        6
    );


    mqttClient.setServer(
        MQTT_SERVER,
        MQTT_PORT
    );


    Serial.println(
        "Parking Sensor started"
    );
}


// ============================================================
//                          LOOP
// ============================================================

void loop() {

    unsigned long now = millis();

    handleHilSerial();

    handleConnectivity(now);

    publishHeartbeat(now);

    scanSensor(now);
}