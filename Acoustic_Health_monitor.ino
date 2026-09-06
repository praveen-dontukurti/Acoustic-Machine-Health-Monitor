#include <Arduino.h>
#include <WiFi.h>
#include <driver/i2s.h>
#include <arduinoFFT.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
// =================================================================
// 1. CONFIGURATION & CREDENTIALS
// =================================================================
const char* ssid     = "PRAVEEN";
const char* password = "123456789";

// --- TELEGRAM BOT CREDENTIALS ---
const char* botToken = "8644007929:AAGxO3fRrY-qt9SgF9rLZxC6tcpiKAiLIO0"; 
const char* chatId   = "-5334692827";
// --- I2S HARDWARE PINS (INMP441) ---
#define I2S_WS   25   // Word Select / L/R Clock (D25)
#define I2S_SD   32   // Serial Data (D32)
#define I2S_SCK  33   // Serial Clock (D33)
#define I2S_PORT I2S_NUM_0

// --- FFT CONFIGURATION ---
#define SAMPLES 512              // Power of 2
#define SAMPLING_FREQ 16000.0    // 16 kHz sampling rate

// Friction Frequency Band: 3000 Hz to 7500 Hz (Resolution = 31.25 Hz/bin)
#define FRICTION_BIN_START 96
#define FRICTION_BIN_END   240
#define REQUIRED_ANOMALY_FRAMES 3

// --- BUFFERS & OBJECTS ---
double vReal[SAMPLES];
double vImag[SAMPLES];
ArduinoFFT<double> FFT = ArduinoFFT<double>(vReal, vImag, SAMPLES, SAMPLING_FREQ);
WebSocketsServer webSocket(8080);//addedns

// --- DYNAMIC CALIBRATION & ANOMALY VARIABLES ---
float ambientNoiseBaseline = 0.0;
float dynamicFrictionThreshold = 100.0;
bool isSystemCalibrated = false;
int anomalyConsecutiveCount = 0;

// --- TELEGRAM ALERT STATE ---
bool alertAlreadySent = false;  // prevents repeated spam during one ongoing anomaly

// =================================================================
// 2. HARDWARE AUDIO INGESTION (I2S)
// =================================================================
void setupI2S() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = (uint32_t)SAMPLING_FREQ,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 64,
    .use_apll = false
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD
  };

  i2s_driver_install(I2S_PORT, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_PORT, &pin_config);
}

// Reads 512 live samples from INMP441 directly into FFT buffer
void captureLiveAudioSamples() {
  size_t bytes_read = 0;
  int32_t raw_sample = 0;

  for (int i = 0; i < SAMPLES; i++) {
    i2s_read(I2S_PORT, &raw_sample, sizeof(raw_sample), &bytes_read, portMAX_DELAY);

    // Scale 32-bit sample down into real array
    vReal[i] = (double)(raw_sample >> 18);
    vImag[i] = 0.0;
  }
}

// =================================================================
// 3. SIGNAL PROCESSING & FFT MATH
// =================================================================
void computeFFT() {
  FFT.windowing(FFTWindow::Hamming, FFTDirection::Forward);
  FFT.compute(FFTDirection::Forward);
  FFT.complexToMagnitude();
}

double getFrictionBandEnergy() {
  double totalEnergy = 0.0;
  int numberOfBins = 0;

  for (int i = FRICTION_BIN_START; i <= FRICTION_BIN_END; i++) {
    totalEnergy += vReal[i];
    numberOfBins++;
  }

  if (numberOfBins > 0) {
    return totalEnergy / numberOfBins;
  }
  return 0.0;
}
// =================================================================
// 4. DYNAMIC NOISE CALIBRATION & ANOMALY DECISION
// =================================================================
void runAmbientNoiseCalibration() {
  Serial.println("\n==================================================");
  Serial.println("Sampling ambient room noise...");
  Serial.println(">> Ensure the test motor is OFF during these 3 seconds.");
  Serial.println("==================================================");

  float maxRoomNoiseObserved = 0.0;
  unsigned long calibrationStartTime = millis();

  // Non-blocking 3-second calibration loop
  while (millis() - calibrationStartTime < 3000) {
    captureLiveAudioSamples();
    computeFFT();
    float currentReading = getFrictionBandEnergy();

    if (currentReading > maxRoomNoiseObserved) {
      maxRoomNoiseObserved = currentReading;
    }
    delay(10);
  }

  // Set baseline and define threshold 30% above maximum room noise
  ambientNoiseBaseline = maxRoomNoiseObserved;
  dynamicFrictionThreshold = ambientNoiseBaseline * 1.30;

  // Safe lower bound
  if (dynamicFrictionThreshold < 80.0) {
    dynamicFrictionThreshold = 80.0;
  }

  isSystemCalibrated = true;

  Serial.println("[M6: CALIBRATION COMPLETE]");
  Serial.print(">> Baseline Room Noise      : ");
  Serial.println(ambientNoiseBaseline);
  Serial.print(">> Dynamic Friction Threshold: ");
  Serial.println(dynamicFrictionThreshold);
  Serial.println("==================================================\n");
}

bool evaluateMachineHealth(float liveFrictionEnergy) {
  return (liveFrictionEnergy > dynamicFrictionThreshold);
}

// =================================================================
//  TELEGRAM ALERT FUNCTION
// =================================================================
void sendTelegramAlert(String message) {
  WiFiClientSecure client;
  client.setInsecure();  // skips certificate validation - acceptable for demo project

  HTTPClient https;
  message.replace(" ","%20");
  String url = "https://api.telegram.org/bot" + String(botToken) +
               "/sendMessage?chat_id=" + String(chatId) +
               "&text=" + message;

  if (https.begin(client, url)) {
    int httpCode = https.GET();
    Serial.print("Alert sent, HTTP code: ");
    Serial.println(httpCode);
    https.end();
  } else {
    Serial.println("Unable to connect to Telegram API");
  }
}
// ===== FRONTEND INTEGRATION =====
void sendTelemetry(double dominantFreq, float frictionEnergy, bool criticalAnomaly) {
  float anomalyScore = 0.0;

  if (dynamicFrictionThreshold > 0.0 && frictionEnergy > dynamicFrictionThreshold) {
    anomalyScore = ((frictionEnergy - dynamicFrictionThreshold) /
                    dynamicFrictionThreshold) * 100.0;
    anomalyScore = constrain(anomalyScore, 0.0f, 100.0f);
  }

  const char* status = "HEALTHY";
  if (criticalAnomaly) {
    status = "CRITICAL";
  } else if (anomalyScore > 0.0) {
    status = "WARNING";
  }

  DynamicJsonDocument telemetry(8192);
  telemetry["peakFreq"] = dominantFreq;
  telemetry["anomalyScore"] = anomalyScore;
  telemetry["status"] = status;
  telemetry["noiseFloor"] = ambientNoiseBaseline;
  telemetry["sampleRate"] = (uint32_t)SAMPLING_FREQ;
  telemetry["fftSize"] = SAMPLES;

  JsonArray spectrum = telemetry.createNestedArray("frequencySpectrum");
  for (int i = 0; i < SAMPLES / 2; i++) {
    spectrum.add(constrain((float)vReal[i], 0.0f, 120.0f));
  }

  String payload;
  serializeJson(telemetry, payload);
  webSocket.broadcastTXT(payload);
}
void handleWebSocketEvent(uint8_t client, WStype_t type, uint8_t* payload, size_t length) {
  if (type != WStype_TEXT) {
    return;
  }

  StaticJsonDocument<256> command;
  if (deserializeJson(command, payload, length)) {
    return;
  }

  const char* commandName = command["command"] | "";
  if (strcmp(commandName, "calibrate") == 0) {
    runAmbientNoiseCalibration();
  }
}
// =================================================================
// 5. SETUP & MAIN EXECUTION
// =================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\nInitializing Acoustic Machine Health Monitor...");

  // 1. Initialize Wi-Fi with 5-second fallback timeout
  Serial.print("Connecting to Wi-Fi");
  WiFi.begin(ssid, password);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 5000) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWi-Fi Connected!");
    Serial.print("ESP32 IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWi-Fi Timeout: Running in standalone offline mode.");
  }

  // 2. Initialize Hardware I2S Microphone
  setupI2S();
  Serial.println("I2S Microphone Initialized.");

  // 3. Run Initial Calibration
  runAmbientNoiseCalibration();
  webSocket.begin();
  webSocket.onEvent(handleWebSocketEvent);
  Serial.println("Ready. Type 'c' in Serial Monitor anytime to re-calibrate.\n");
}

void loop() {
  webSocket.loop();
  if (Serial.available() > 0) {
    char ch = Serial.read();
    if (ch == 'c' || ch == 'C') {
      runAmbientNoiseCalibration();
    }
  }

  // 1. Capture live physical audio
  captureLiveAudioSamples();

  // 2. Perform FFT transformation
  computeFFT();

  // 3. Extract metrics
  double dominantFreq = FFT.majorPeak();
  float frictionEnergy = getFrictionBandEnergy();

  // 4. Anomaly Decision
  bool singleFrameAnomaly = evaluateMachineHealth(frictionEnergy);

  if (singleFrameAnomaly) {
    anomalyConsecutiveCount++;
  } else {
    anomalyConsecutiveCount = 0;
  }

  bool criticalAnomaly = (anomalyConsecutiveCount >= REQUIRED_ANOMALY_FRAMES);

  // 5. Print status
  Serial.print("Dom Freq: ");
  Serial.print(dominantFreq, 1);
  Serial.print(" Hz | Friction Energy: ");
  Serial.print(frictionEnergy, 1);
  Serial.print(" | Thresh: ");
  Serial.print(dynamicFrictionThreshold, 1);

  if (criticalAnomaly) {
    Serial.println(" >>> [CRITICAL ANOMALY DETECTED!] <<<");
    // --- SEND TELEGRAM ALERT (once per anomaly event) ---
    if (!alertAlreadySent) {
      sendTelegramAlert("URGENT: CRITICAL ANOMALY DETECTED - Machine friction spike.");
      alertAlreadySent = true;
    }
  } else {
    Serial.println(" | [STATUS: HEALTHY]");
    alertAlreadySent = false;  // reset so next anomaly can trigger a fresh alert
  }
  sendTelemetry(dominantFreq, frictionEnergy, criticalAnomaly);
  delay(100);
}
