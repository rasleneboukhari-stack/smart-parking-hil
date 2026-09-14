# Smart Parking System

A complete embedded smart parking system combining simulation, backend
services, Hardware-in-the-Loop (HIL), embedded firmware, and a web
application.

## Overview

The system contains:

-   2D parking simulator
-   FastAPI backend gateway
-   Python HIL bridge
-   Wokwi custom HIL chip
-   ESP32-S3 embedded controller
-   Web application

The parking layout is flexible and configurable. Different parking
layouts, zones, and parking spot configurations can be supported by
changing configuration files without modifying the core architecture.

## Architecture

Communication flow:

    2D Parking Simulator
            |
            | HTTP / REST
            v
    FastAPI Gateway
            |
            | Internal API
            v
    Python HIL Bridge
            |
            | RFC2217 Serial
            v
    Wokwi Custom HIL Chip
            |
            | Ultrasonic Echo Simulation
            v
    ESP32-S3 Controller
            |
            | MQTT
            v
    Web Application

![Architecture](docs/images/architecture.png)

## Simulation Environment

The simulator generates vehicle movements, parking scenarios, and
virtual sensor distances.

![Simulator](docs/images/simulator.png)

## Backend Gateway

The FastAPI gateway manages parking states, receives simulation data,
exposes APIs, and communicates with the HIL bridge.

![Gateway](docs/images/gateway.png)

## Hardware-in-the-Loop

The HIL system allows the ESP32 firmware to interact with simulated
sensors.

Flow:

1.  Simulator generates distances.
2.  HIL bridge converts data into sensor commands.
3.  Wokwi custom chip generates ultrasonic echo pulses.
4.  ESP32 processes the signals like real hardware.

![HIL](docs/images/hil_system.png)

## Web Application

The web interface provides:

-   Live parking status
-   Reservations
-   Vehicle tracking
-   Notifications

![Web App](docs/images/web_app.png)

## Running

``` bash
./run_all.sh
```

Starts the gateway, HIL bridge, simulator, and web application.

## Structure

    smart-parking-hil/
    ├── frontend/
    ├── gateway/
    ├── src/
    ├── layouts/
    ├── docs/
    ├── run_all.sh
    └── README.md

## Technologies

-   ESP32-S3
-   C++
-   Python
-   FastAPI
-   MQTT
-   PySerial
-   Wokwi
-   PlatformIO
-   HTML/CSS/JavaScript
-   Git
-   Linux

## Goals

This project demonstrates embedded development, HIL testing, IoT
communication, backend design, and full system integration.
