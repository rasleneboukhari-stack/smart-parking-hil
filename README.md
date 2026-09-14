# Smart Parking System - Hardware-in-the-Loop Simulation

A complete smart parking system combining a 2D parking simulator, backend gateway, embedded ESP32 controller, custom Hardware-in-the-Loop (HIL) sensor simulation, and a web application.

## Overview

The system simulates a smart parking infrastructure:
- Vehicle movement simulation
- Virtual ultrasonic sensors
- Backend processing
- ESP32 embedded control
- Web application for monitoring and reservations

The parking layout is flexible and configurable. New layouts, zones, and sensor configurations can be added without changing the main architecture.

## Architecture

![System Architecture](docs/images/architecture.png)

## Components

### Simulation Environment

Generates parking scenarios and virtual sensor distances.

![Parking Simulator](docs/images/simulator.png)

### Backend Gateway

FastAPI service responsible for:
- Receiving simulation data
- Managing parking states
- Providing APIs
- Communicating with the HIL bridge

![Gateway](docs/images/gateway.png)

### Hardware-in-the-Loop System

Communication flow:

```
Simulator
 |
 | HTTP distance data
 v
FastAPI Gateway
 |
 v
Python HIL Bridge
 |
 | RFC2217 Serial
 v
Custom Wokwi HIL Chip
 |
 | Ultrasonic Echo pulses
 v
ESP32-S3 Controller
```

![HIL System](docs/images/hil_system.png)

### Web Application

Provides:
- Live parking status
- Parking map visualization
- Reservations
- Driver interface

![Web Application](docs/images/web_app.png)

## Running

Requirements:
- Python 3
- PlatformIO
- Wokwi CLI

Start the complete system:

```bash
./run_all.sh
```

## Project Structure

```
smart-parking-hil/
├── frontend/
├── gateway/
├── src/
├── layouts/
├── docs/
│   └── images/
├── platformio.ini
├── run_all.sh
└── README.md
```

## Technologies

Embedded:
- ESP32-S3
- C++
- PlatformIO
- Wokwi

Backend:
- Python
- FastAPI
- PySerial

Communication:
- HTTP
- MQTT
- RFC2217 Serial

Frontend:
- HTML
- CSS
- JavaScript
