"use strict";

(() => {
    /*
      PARKSIDE GAME SIMULATOR

      Architecture stays correct:
        game world -> virtual sensor distances -> HIL bridge -> ESP32
        -> MQTT -> gateway -> actual display / actual phone website

      The game NEVER publishes FREE/OCCUPIED itself.
    */

    const SENSOR_MAX_CM = 200;
    const SENSOR_BEAM_OFFSETS_M = [-0.28, 0, 0.28];
    const HIL_UPDATE_INTERVAL_MS = 100;

    // Stable frontend -> gateway contract.
    // Later the Wokwi/HIL-side bridge only has to consume the gateway endpoint.
    const HIL_DISTANCE_ENDPOINT = "/simulator/hil/distances";
    const HIL_ZONE_ID = 1;

    const GATE_OPEN_RADIUS_M = 3.35;
    const GATE_CLOSE_RADIUS_M = 4.8;
    const GATE_OFFSET_M = 1.25;
    const LOT_LEFT_M = 0.8;
    const LOT_TOP_M = 1.4;
    const LOT_EDGE_MARGIN_M = 0.45;
    const PARK_ASSIST_RADIUS_M = 5.5;

    const DISPLAY_NATIVE_W = 1540;
    const DISPLAY_NATIVE_H = 900;
    const PHONE_NATIVE_W = 390;
    const PHONE_NATIVE_H = 844;

    const $ = (id) => document.getElementById(id);

    const ui = {
        gatewayStatus: $("gateway-status"),
        hilStatus: $("mqtt-status"),
        floorSelect: $("floor-select"),
        floorTitle: $("floor-title"),
        canvas: $("sim-canvas"),
        viewport: $("sim-viewport"),
        message: $("sim-message"),
        fitMap: $("fit-map"),
        pause: $("pause-sim"),
        sensorsToggle: $("toggle-sensors"),
        distanceHud: $("distance-hud"),
        distanceGrid: $("distance-grid"),
        hudCarName: $("hud-car-name"),
        hudCarMode: $("hud-car-mode"),
        cameraModeLabel: $("camera-mode-label"),
        carList: $("car-list"),
        addCar: $("add-car"),
        selectedCarName: $("selected-car-name"),
        selectedCarState: $("selected-car-state"),
        speedValue: $("speed-value"),
        parkingValue: $("parking-value"),
        reservationSummary: $("reservation-summary"),
        reservedSpotLabel: $("reserved-spot-label"),
        parkCar: $("park-car"),
        resetCar: $("reset-car"),
        gateOverlay: $("gate-display-overlay"),
        gateStage: $("gate-display-stage"),
        gateFrame: $("gate-display-frame"),
        gateDismiss: $("gate-display-dismiss"),
        phonePanel: $("phone-panel"),
        phoneCarName: $("phone-car-name"),
        phoneStage: $("phone-stage"),
        phoneEmpty: $("phone-empty"),
        phoneFrame: $("phone-frame"),

        startScreen: $("start-screen"),
        startButton: $("start-simulator"),
        menuMusicToggle: $("menu-music-toggle"),
        keepMusic: $("keep-music"),
        musicToggle: $("music-toggle"),
        fullscreenToggle: $("fullscreen-toggle"),
        parkCarQuick: $("park-car-quick"),
        gatePrompt: $("gate-prompt"),

        pauseScreen: $("pause-screen"),
        pauseResume: $("pause-resume"),
        pauseRestartCar: $("pause-restart-car"),
        pauseFullscreen: $("pause-fullscreen"),
        pauseMusic: $("pause-music"),
        pauseRestartGame: $("pause-restart-game"),
        pauseMainMenu: $("pause-main-menu")
    };

    const state = {
        layout: null,
        spotsLive: {},
        selectedFloor: null,
        selectedCarId: null,
        cars: [],
        nextCarId: 1,
        paused: false,
        started: false,
        gatePromptVisible: false,
        musicEnabled: false,
        menuMusicDesired: true,
        keys: new Set(),
        gatewayConnected: false,
        gateVisible: false,
        gateDismissedUntilExit: false,
        gateBaselineReservations: {},
        sensorHudVisible: false,
        hilDistances: {},
        lastHilPush: 0,

        // Distance transport state
        hilFrameSequence: 0,
        hilPostInFlight: false,
        hilBridgeConnected: false,
        camera: {
            mode: "follow",
            centerX: 0,
            centerY: 0,
            scale: 1,
            targetX: 0,
            targetY: 0,
            targetScale: 1
        }
    };

    let lastFrame = performance.now();
    let raf = null;
    let spotPoll = null;
    let phoneResizeObserver = null;

    let audioContext = null;
    let musicTimer = null;
    let musicStep = 0;


    /* =========================================================
       START SCREEN / FULLSCREEN / CHIPTUNE
    ========================================================== */

    const CHIPPY_MELODY = [
        261.63, 329.63, 392.00, 523.25,
        392.00, 329.63, 293.66, 349.23,
        440.00, 349.23, 293.66, 261.63
    ];

    function playTinyNote(freq, duration = 0.12, volume = 0.028) {
        if (!audioContext || !state.musicEnabled) return;

        const now = audioContext.currentTime;
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();

        osc.type = "square";
        osc.frequency.setValueAtTime(freq, now);

        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(volume, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        osc.connect(gain);
        gain.connect(audioContext.destination);

        osc.start(now);
        osc.stop(now + duration + 0.02);
    }

    function playMusicStep() {
        const note = CHIPPY_MELODY[musicStep % CHIPPY_MELODY.length];
        playTinyNote(note, 0.115, 0.022);

        if (musicStep % 4 === 0) {
            playTinyNote(note / 2, 0.16, 0.012);
        }

        musicStep++;
    }

    async function startMusic() {
        if (state.musicEnabled) return true;

        try {
            audioContext =
                audioContext ||
                new (window.AudioContext || window.webkitAudioContext)();

            await audioContext.resume?.();

            if (audioContext.state !== "running") {
                return false;
            }

            state.musicEnabled = true;
            musicStep = 0;

            playMusicStep();

            clearInterval(musicTimer);
            musicTimer = window.setInterval(
                playMusicStep,
                185
            );

            syncMusicButtons();
            return true;
        }
        catch (error) {
            console.warn("Music unavailable", error);
            state.musicEnabled = false;
            syncMusicButtons();
            return false;
        }
    }

    function stopMusic() {
        state.musicEnabled = false;

        clearInterval(musicTimer);
        musicTimer = null;

        syncMusicButtons();
    }

    function syncMusicButtons() {
        if (ui.musicToggle) {
            ui.musicToggle.textContent =
                state.musicEnabled ? "MUSIC ON" : "MUSIC OFF";
        }

        const strong =
            ui.menuMusicToggle?.querySelector("strong");

        if (strong) {
            strong.textContent =
                state.menuMusicDesired ? "ON" : "OFF";
        }

        ui.menuMusicToggle?.setAttribute(
            "aria-pressed",
            String(state.menuMusicDesired)
        );
    }

    async function toggleMenuMusic() {
        state.menuMusicDesired =
            !state.menuMusicDesired;

        if (state.menuMusicDesired) {
            await startMusic();
        }
        else {
            stopMusic();
        }

        syncMusicButtons();
    }

    async function toggleMusic() {
        if (state.musicEnabled) {
            stopMusic();
        }
        else {
            await startMusic();
        }
    }

    async function enterFullscreen() {
        try {
            if (
                !document.fullscreenElement &&
                document.documentElement.requestFullscreen
            ) {
                await document.documentElement.requestFullscreen();
            }
        }
        catch (error) {
            console.warn("Fullscreen request was blocked", error);
        }
    }

    async function toggleFullscreen() {
        if (document.fullscreenElement) {
            try {
                await document.exitFullscreen?.();
            }
            catch (error) {
                console.warn("Could not exit fullscreen", error);
            }

            return;
        }

        await enterFullscreen();
    }

    function syncFullscreenButton() {
        if (!ui.fullscreenToggle) return;

        ui.fullscreenToggle.textContent =
            document.fullscreenElement
                ? "EXIT FULLSCREEN"
                : "FULLSCREEN";
    }

    async function startSimulator() {
        if (state.started) return;

        /*
          Menu music is the default.
          When the game begins it STOPS, unless the explicit
          "KEEP MUSIC DURING GAME" option is checked.
        */
        const keepMusic =
            Boolean(ui.keepMusic?.checked);

        if (!keepMusic) {
            stopMusic();
        }
        else if (!state.musicEnabled) {
            await startMusic();
        }

        state.started = true;

        document.body.classList.add("sim-running");
        ui.startScreen.hidden = true;

        await enterFullscreen();

        requestAnimationFrame(() => {
            fitCamera(true);
            scalePhone();
            scaleIframe(
                ui.gateFrame,
                ui.gateStage,
                DISPLAY_NATIVE_W,
                DISPLAY_NATIVE_H
            );
            ui.viewport.focus();
        });

        syncFullscreenButton();

        message(
            "Drive to the entrance gate. Press SPACE when prompted."
        );
    }

    /*
      Browsers normally block autoplay before the first user gesture.
      We still try on load; if blocked, the FIRST click/key on the
      menu starts the menu music automatically.
    */
    async function tryStartMenuMusic() {
        if (
            state.started ||
            !state.menuMusicDesired ||
            state.musicEnabled
        ) {
            return;
        }

        await startMusic();
    }

    /* =========================================================
       HELPERS
    ========================================================== */

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function floorById(id) {
        return (state.layout?.floors || []).find(
            (f) => String(f.id) === String(id)
        ) || null;
    }

    function currentFloor() {
        return floorById(state.selectedFloor);
    }

    function layoutSpot(id) {
        return (state.layout?.spots || []).find(
            (spot) => String(spot.id) === String(id)
        ) || null;
    }

    function floorSpots() {
        return (state.layout?.spots || []).filter(
            (spot) => String(spot.floor) === String(state.selectedFloor)
        );
    }

    function floorRoads() {
        return (state.layout?.roads || []).filter(
            (road) => String(road.floor) === String(state.selectedFloor)
        );
    }

    function floorName(id) {
        return floorById(id)?.name || String(id);
    }

    function spotLabel(id) {
        return layoutSpot(id)?.label || String(id);
    }

    function selectedCar() {
        return state.cars.find((c) => c.id === state.selectedCarId) || null;
    }

    function setStatus(el, mode, text) {
        if (!el) return;
        el.dataset.state = mode;
        const span = el.querySelector("span");
        if (span) span.textContent = text;
    }

    function entranceForFloor(floorId) {
        return (state.layout?.entrances || []).find(
            (item) => String(item.floor) === String(floorId)
        ) || null;
    }

    function entrancePoint(floorId) {
        const e = entranceForFloor(floorId);
        const floor = floorById(floorId);
        return e
            ? {x: Number(e.x), y: Number(e.y)}
            : {x: 2, y: (Number(floor?.height) || 30) / 2};
    }

    function exitPoint(floorId) {
        const e = (state.layout?.exits || []).find(
            (item) => String(item.floor) === String(floorId)
        );
        const floor = floorById(floorId);
        return e
            ? {x: Number(e.x), y: Number(e.y)}
            : {x: (Number(floor?.width) || 36) - 2, y: (Number(floor?.height) || 30) / 2};
    }

    function gatePoint(floorId) {
        const e = entrancePoint(floorId);
        return {x: e.x + GATE_OFFSET_M, y: e.y};
    }

    function carDistanceToGate(car) {
        const g = gatePoint(car.floor);
        return Math.hypot(car.x - g.x, car.y - g.y);
    }


    function laneHalfWidth(floorId) {
        const road = (state.layout?.roads || []).find(
            (r) => String(r.floor) === String(floorId)
        );
        return Math.max(2.35, (Number(road?.width) || 6.2) * 0.48);
    }

    function barrierOpenFor(car) {
        return Boolean(car?.reservationId);
    }

    function insideLot(x, y, floor) {
        if (!floor) return false;
        const right = (Number(floor.width) || 36) - LOT_LEFT_M;
        const bottom = (Number(floor.height) || 30) - LOT_TOP_M;
        return x >= LOT_LEFT_M && x <= right && y >= LOT_TOP_M && y <= bottom;
    }

    function inEntranceOpening(y, floorId) {
        const e = entrancePoint(floorId);
        return Math.abs(y - e.y) <= laneHalfWidth(floorId);
    }

    function inExitOpening(y, floorId) {
        const e = exitPoint(floorId);
        return Math.abs(y - e.y) <= laneHalfWidth(floorId);
    }

    /* =========================================================
       DATA
    ========================================================== */

    async function loadLayout() {
        const res = await fetch("/layout", {cache: "no-store"});
        if (!res.ok) throw new Error("Could not load parking layout.");
        state.layout = await res.json();
        if (!(state.layout?.floors || []).length) {
            throw new Error("Parking layout has no floors.");
        }
        state.selectedFloor = String(state.layout.floors[0].id);
        renderFloorSelect();
        buildDistanceHud();
        fitCamera(true);
    }

    async function refreshSpots() {
        try {
            const res = await fetch("/spots", {cache: "no-store"});
            if (!res.ok) throw new Error("Gateway error");
            const previous = state.spotsLive;
            state.spotsLive = await res.json();
            state.gatewayConnected = true;
            setStatus(ui.gatewayStatus, "live", "Gateway live");
            detectReservationFallback(previous, state.spotsLive);
        } catch (err) {
            state.gatewayConnected = false;
            setStatus(ui.gatewayStatus, "error", "Gateway offline");
        }
    }

    /* =========================================================
       FLOOR UI
    ========================================================== */

    function renderFloorSelect() {
        const frag = document.createDocumentFragment();
        for (const f of state.layout?.floors || []) {
            const opt = document.createElement("option");
            opt.value = String(f.id);
            opt.textContent = f.name || String(f.id);
            frag.append(opt);
        }
        ui.floorSelect.replaceChildren(frag);
        ui.floorSelect.value = state.selectedFloor;
        ui.floorTitle.textContent = floorName(state.selectedFloor);
    }

    /* =========================================================
       CARS
    ========================================================== */

    const CAR_COLORS = [
        "#b84f45", "#4d78a8", "#c39a3e",
        "#4f8a68", "#875e91", "#d0c7ac"
    ];

    function addCar() {
        const floor = currentFloor();
        if (!floor) return;

        const e = entrancePoint(floor.id);
        const n = state.cars.length;
        const id = `car-${state.nextCarId++}`;

        state.cars.push({
            id,
            name: `Car ${n + 1}`,
            floor: String(floor.id),
            x: e.x - 5.5 - n * 2.45,
            y: e.y + ((n % 2) ? 0.25 : -0.25),
            angle: Math.PI / 2,
            speed: 0,
            steering: 0,
            width: 1.82,      // physical geometry for sensors
            length: 4.35,     // physical geometry for sensors
            visualScale: 0.48, // deliberately smaller retro sprite
            color: CAR_COLORS[n % CAR_COLORS.length],
            reservationId: null,
            reservedSpotId: null,
            claimUrl: null,
            parkedSpotId: null
        });

        state.selectedCarId = id;
        selectCar(id, false);
    }

    function selectCar(id, focus = true) {
        const car = state.cars.find((c) => c.id === id);
        if (!car) return;

        state.selectedCarId = id;
        state.selectedFloor = String(car.floor);
        ui.floorSelect.value = state.selectedFloor;
        ui.floorTitle.textContent = floorName(state.selectedFloor);
        state.camera.mode = "follow";
        state.gateDismissedUntilExit = false;

        renderCarsList();
        renderSelectedCar();
        updatePhone();
        updateGateProximity();

        if (focus) ui.viewport.focus();
    }

    function resetSelectedCar() {
        const car = selectedCar();
        if (!car) return;
        const e = entrancePoint(car.floor);
        const i = state.cars.indexOf(car);
        car.x = e.x - 5.5 - Math.max(i, 0) * 2.45;
        car.y = e.y;
        car.angle = Math.PI / 2;
        car.speed = 0;
        car.steering = 0;
        car.parkedSpotId = null;
        state.gateDismissedUntilExit = false;
        hideGateDisplay();
        state.camera.mode = "follow";
        message(`${car.name} returned to the entrance.`);
    }

    function renderCarsList() {
        const frag = document.createDocumentFragment();

        ui.carList.style.setProperty(
            "--car-count",
            String(Math.max(1, state.cars.length))
        );
        for (const car of state.cars) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "car-option";
            b.setAttribute("aria-pressed", String(car.id === state.selectedCarId));
            const mode = car.parkedSpotId ? "PARKED" : car.reservedSpotId ? "RESERVED" : "DRIVING";
            b.innerHTML = `
                <span class="car-swatch" style="background:${car.color}" aria-hidden="true"></span>
                <span><strong>${car.name}</strong><small>${floorName(car.floor)} · ${mode}</small></span>
                <span>${mode}</span>`;
            b.addEventListener("click", () => selectCar(car.id));
            frag.append(b);
        }
        ui.carList.replaceChildren(frag);
    }

    function renderSelectedCar() {
        const car = selectedCar();
        if (!car) return;
        const mode = car.parkedSpotId ? "PARKED" : car.reservedSpotId ? "RESERVED" : "DRIVING";
        ui.selectedCarName.textContent = car.name;
        ui.selectedCarState.textContent = mode;
        ui.speedValue.textContent = `${Math.abs(car.speed).toFixed(1)} m/s`;
        ui.parkingValue.textContent = car.parkedSpotId ? spotLabel(car.parkedSpotId) : "—";
        ui.reservationSummary.hidden = !car.reservedSpotId;
        if (car.reservedSpotId) ui.reservedSpotLabel.textContent = spotLabel(car.reservedSpotId);

        const canAssist = canParkSelectedCar(car);
        if (ui.parkCar) {
            ui.parkCar.disabled = !canAssist;
            ui.parkCar.textContent = car.parkedSpotId ? "PARKED" : "PARK CAR";
            ui.parkCar.title = car.reservedSpotId
                ? (canAssist ? `Park neatly in ${spotLabel(car.reservedSpotId)}` : `Drive closer to ${spotLabel(car.reservedSpotId)}`)
                : "Reserve a space at the entrance first";
        }

        if (ui.parkCarQuick) {
            ui.parkCarQuick.disabled = !canAssist;
            ui.parkCarQuick.textContent = car.parkedSpotId ? "PARKED" : "PARK CAR";
            ui.parkCarQuick.title = car.reservedSpotId
                ? (canAssist ? `Park neatly in ${spotLabel(car.reservedSpotId)}` : `Drive closer to ${spotLabel(car.reservedSpotId)}`)
                : "Reserve a space at the entrance first";
        }

        ui.hudCarName.textContent = car.name.toUpperCase();
        ui.hudCarMode.textContent = mode;
        ui.cameraModeLabel.textContent = state.camera.mode.toUpperCase();
    }


    function canParkSelectedCar(car = selectedCar()) {
        if (!car?.reservedSpotId || car.parkedSpotId) return false;
        const spot = layoutSpot(car.reservedSpotId);
        if (!spot || String(spot.floor) !== String(car.floor)) return false;
        const d = Math.hypot(car.x - Number(spot.x), car.y - Number(spot.y));
        return d <= PARK_ASSIST_RADIUS_M;
    }

    function parkSelectedCarCleanly() {
        const car = selectedCar();
        if (!car?.reservedSpotId) {
            message("Reserve a parking space at the entrance first.");
            return;
        }

        const spot = layoutSpot(car.reservedSpotId);
        if (!spot) return;

        const d = Math.hypot(car.x - Number(spot.x), car.y - Number(spot.y));
        if (d > PARK_ASSIST_RADIUS_M) {
            message(`Drive closer to ${spotLabel(spot.id)} before using PARK CAR.`);
            return;
        }

        car.x = Number(spot.x);
        car.y = Number(spot.y);
        car.angle = (Number(spot.rotation) || 0) * Math.PI / 180;
        car.speed = 0;
        car.steering = 0;
        car.parkedSpotId = String(spot.id);
        state.camera.mode = "follow";

        message(`${car.name} parked neatly in ${spotLabel(spot.id)}.`);
        renderCarsList();
        renderSelectedCar();
        ui.viewport.focus();
    }


    function showGatePrompt() {
        const car = selectedCar();
        if (!car || car.reservationId || state.gateVisible) return;

        state.gatePromptVisible = true;
        ui.gatePrompt.hidden = false;
        message("Entrance terminal ready — press SPACE to view parking display.");
    }

    function hideGatePrompt() {
        state.gatePromptVisible = false;
        ui.gatePrompt.hidden = true;
    }

    function openGateDisplayFromPrompt() {
        const car = selectedCar();
        if (!car || car.reservationId) return;

        if (carDistanceToGate(car) > GATE_OPEN_RADIUS_M) {
            return;
        }

        hideGatePrompt();
        showGateDisplay();
    }

    /* =========================================================
       REAL DISPLAY EMBED + RESERVATION ASSOCIATION
    ========================================================== */

    function scaleIframe(iframe, stage, nativeW, nativeH) {
        if (!iframe || !stage) return;
        const w = Math.max(1, stage.clientWidth);
        const h = Math.max(1, stage.clientHeight);
        const scale = Math.min(w / nativeW, h / nativeH);
        iframe.style.transform = `scale(${scale})`;
        iframe.style.left = `${Math.max(0, (w - nativeW * scale) / 2)}px`;
        iframe.style.top = `${Math.max(0, (h - nativeH * scale) / 2)}px`;
    }

    function captureGateBaseline() {
        state.gateBaselineReservations = {};
        for (const [spotId, spot] of Object.entries(state.spotsLive || {})) {
            state.gateBaselineReservations[spotId] = spot?.reservation_id || null;
        }
    }

    function showGateDisplay() {
        const car = selectedCar();
        if (!car || car.reservationId || state.gateDismissedUntilExit) return;
        if (state.gateVisible) return;
        state.gateVisible = true;
        hideGatePrompt();
        captureGateBaseline();
        ui.gateOverlay.hidden = false;

        // Reload the REAL display route each time. display.html itself carries
        // a fresh display.js version in this package, avoiding the stale iframe cache.
        ui.gateFrame.src = `/display?simulator=1&gate=${Date.now()}`;
        scaleIframe(ui.gateFrame, ui.gateStage, DISPLAY_NATIVE_W, DISPLAY_NATIVE_H);
        message("Gate closed. Reserve a space on the real Parkside terminal to enter.");
    }

    function hideGateDisplay(suppress = false) {
        if (!state.gateVisible && ui.gateOverlay.hidden) return;
        state.gateVisible = false;
        ui.gateOverlay.hidden = true;
        if (suppress) state.gateDismissedUntilExit = true;
        ui.viewport.focus();
    }

    function updateGateProximity() {
        const car = selectedCar();

        if (!car) {
            hideGatePrompt();
            if (state.gateVisible) hideGateDisplay();
            return;
        }

        const d = carDistanceToGate(car);

        if (d > GATE_CLOSE_RADIUS_M) {
            state.gateDismissedUntilExit = false;
            hideGatePrompt();

            if (state.gateVisible) {
                hideGateDisplay();
            }

            return;
        }

        if (car.reservationId) {
            hideGatePrompt();
            return;
        }

        if (
            d <= GATE_OPEN_RADIUS_M &&
            !state.gateVisible &&
            !state.gateDismissedUntilExit
        ) {
            showGatePrompt();
        }
        else if (d > GATE_OPEN_RADIUS_M) {
            hideGatePrompt();
        }
    }

    function applyDisplayReservation(data) {
        const car = selectedCar();
        if (!car || !data?.reservation_id || !data?.spot_id) return;

        car.reservationId = String(data.reservation_id);
        car.reservedSpotId = String(data.spot_id);
        car.claimUrl = data.claim_url
            ? new URL(data.claim_url, window.location.origin).href
            : null;

        state.gateDismissedUntilExit = true;
        hideGatePrompt();
        renderCarsList();
        renderSelectedCar();
        updatePhone();
        message(`${car.name} reserved ${spotLabel(car.reservedSpotId)}. The barrier is open.`);

        window.setTimeout(() => hideGateDisplay(true), 1100);
    }

    /* Fallback if the parent-message patch is not installed yet. */
    function detectReservationFallback(previous, current) {
        if (!state.gateVisible) return;
        const car = selectedCar();
        if (!car || car.reservationId) return;

        for (const [spotId, spot] of Object.entries(current || {})) {
            const before = state.gateBaselineReservations[spotId] || null;
            const now = spot?.reservation_id || null;
            if (!before && now) {
                applyDisplayReservation({
                    reservation_id: now,
                    spot_id: spotId,
                    claim_url: null
                });
                return;
            }
        }
    }

    window.addEventListener("message", (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;
        if (data?.type === "parkside-display-reservation") {
            applyDisplayReservation(data);
        }
    });

    /* =========================================================
       ACTUAL PHONE WEBSITE
    ========================================================== */

    function scalePhone() {
        if (!ui.phoneStage || !ui.phoneFrame) return;
        const w = Math.max(1, ui.phoneStage.clientWidth);
        const h = Math.max(1, ui.phoneStage.clientHeight);
        const scale = Math.min(w / PHONE_NATIVE_W, h / PHONE_NATIVE_H);
        ui.phoneFrame.style.transform = `scale(${scale})`;
        ui.phoneFrame.style.left = `${Math.max(0, (w - PHONE_NATIVE_W * scale) / 2)}px`;
        ui.phoneFrame.style.top = `${Math.max(0, (h - PHONE_NATIVE_H * scale) / 2)}px`;
    }

    function installPhoneResizeObserver() {
        if (!ui.phoneStage || typeof ResizeObserver === "undefined") {
            return;
        }

        phoneResizeObserver?.disconnect();

        phoneResizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(scalePhone);
        });

        phoneResizeObserver.observe(ui.phoneStage);
    }

    function updatePhone() {
        const car = selectedCar();
        if (!car) return;
        ui.phoneCarName.textContent = car.name;

        if (!car.reservationId) {
            ui.phoneFrame.hidden = true;
            ui.phoneEmpty.hidden = false;
            return;
        }

        try {
            localStorage.setItem("reservation_id", car.reservationId);
        } catch (err) {
            console.warn("Could not set reservation_id for phone iframe", err);
        }

        ui.phoneEmpty.hidden = true;
        ui.phoneFrame.hidden = false;
        ui.phoneFrame.src = `/?sim_phone=${encodeURIComponent(car.id)}&t=${Date.now()}`;
        requestAnimationFrame(scalePhone);
    }

    /* =========================================================
       CAMERA
    ========================================================== */

    function viewportRect() {
        return ui.viewport.getBoundingClientRect();
    }

    function fitScale() {
        const f = currentFloor();
        const r = viewportRect();
        if (!f) return 1;
        return Math.min(
            Math.max(1, r.width - 58) / (Number(f.width) || 36),
            Math.max(1, r.height - 58) / (Number(f.height) || 30)
        );
    }

    function fitCamera(immediate = false) {
        const f = currentFloor();
        if (!f) return;
        state.camera.mode = "fit";
        state.camera.targetX = (Number(f.width) || 36) / 2;
        state.camera.targetY = (Number(f.height) || 30) / 2;
        state.camera.targetScale = fitScale();
        if (immediate) {
            state.camera.centerX = state.camera.targetX;
            state.camera.centerY = state.camera.targetY;
            state.camera.scale = state.camera.targetScale;
        }
        ui.cameraModeLabel.textContent = "FIT";
        ui.fitMap.textContent = "FOLLOW";
    }

    function followCamera() {
        state.camera.mode = "follow";
        ui.cameraModeLabel.textContent = "FOLLOW";
        ui.fitMap.textContent = "FIT";
    }

    function updateCamera(dt) {
        const car = selectedCar();
        if (!car) return;

        if (state.camera.mode === "follow") {
            const speedLook = clamp(Math.abs(car.speed) * 0.34, 0, 1.7);
            const forwardX = Math.sin(car.angle);
            const forwardY = -Math.cos(car.angle);
            state.camera.targetX = car.x + forwardX * speedLook;
            state.camera.targetY = car.y + forwardY * speedLook;
            state.camera.targetScale = fitScale() * 1.15;
        }

        const t = 1 - Math.exp(-3.4 * dt);
        state.camera.centerX = lerp(state.camera.centerX, state.camera.targetX, t);
        state.camera.centerY = lerp(state.camera.centerY, state.camera.targetY, t);
        state.camera.scale = lerp(state.camera.scale, state.camera.targetScale, t);
    }

    function worldToScreen(x, y) {
        const r = viewportRect();
        return {
            x: r.width / 2 + (Number(x) - state.camera.centerX) * state.camera.scale,
            y: r.height / 2 + (Number(y) - state.camera.centerY) * state.camera.scale
        };
    }

    function screenToWorld(clientX, clientY) {
        const r = viewportRect();
        return {
            x: state.camera.centerX + (clientX - r.left - r.width / 2) / state.camera.scale,
            y: state.camera.centerY + (clientY - r.top - r.height / 2) / state.camera.scale
        };
    }

    /* =========================================================
       RETRO WORLD DRAWING
    ========================================================== */

    function drawPixelGrass(ctx, w, h) {
        const tile = 18;
        for (let y = 0; y < h; y += tile) {
            for (let x = 0; x < w; x += tile) {
                const n = ((x / tile) * 7 + (y / tile) * 11) % 5;
                ctx.fillStyle = n < 2 ? "#558047" : "#5b894e";
                ctx.fillRect(x, y, tile, tile);
                if (n === 0) {
                    ctx.fillStyle = "#739d5c";
                    ctx.fillRect(x + 5, y + 4, 2, 4);
                    ctx.fillRect(x + 11, y + 10, 2, 3);
                }
            }
        }
    }

    function drawTree(ctx, x, y, size = 1) {
        const p = worldToScreen(x, y);
        const s = 14 * size;
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.25)";
        ctx.fillRect(p.x - s * .7 + 4, p.y - s * .15 + 5, s * 1.4, s * .55);
        ctx.fillStyle = "#2e5e39";
        ctx.fillRect(p.x - s * .62, p.y - s * .42, s * 1.24, s * .72);
        ctx.fillStyle = "#3f7a45";
        ctx.fillRect(p.x - s * .48, p.y - s * .72, s * .96, s * .75);
        ctx.fillStyle = "#5a9852";
        ctx.fillRect(p.x - s * .28, p.y - s * .82, s * .56, s * .3);
        ctx.fillStyle = "#6daa5e";
        ctx.fillRect(p.x - s * .22, p.y - s * .69, s * .18, s * .16);
        ctx.strokeStyle = "#183c29";
        ctx.lineWidth = 2;
        ctx.strokeRect(p.x - s * .48, p.y - s * .72, s * .96, s * .75);
        ctx.restore();
    }

    function drawFence(ctx, x1, y1, x2, y2) {
        const a = worldToScreen(x1, y1);
        const b = worldToScreen(x2, y2);
        ctx.save();
        ctx.strokeStyle = "#c5b98c";
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const count = Math.max(1, Math.floor(len / 22));
        for (let i = 0; i <= count; i++) {
            const t = i / count;
            const x = lerp(a.x, b.x, t);
            const y = lerp(a.y, b.y, t);
            ctx.fillStyle = "#786f58";
            ctx.fillRect(x - 2, y - 7, 4, 14);
            ctx.fillStyle = "#d5c99a";
            ctx.fillRect(x - 1, y - 6, 2, 11);
        }
        ctx.restore();
    }

    function drawParkingSlab(ctx) {
        const f = currentFloor();
        const tl = worldToScreen(.7, 1.2);
        const br = worldToScreen((Number(f.width) || 36) - .7, (Number(f.height) || 30) - 1.2);
        ctx.fillStyle = "#3e4649";
        ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        ctx.strokeStyle = "#a9a48d";
        ctx.lineWidth = 5;
        ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
        ctx.strokeStyle = "#22282a";
        ctx.lineWidth = 2;
        ctx.strokeRect(tl.x + 5, tl.y + 5, br.x - tl.x - 10, br.y - tl.y - 10);

        ctx.save();
        ctx.globalAlpha = .22;
        for (let i = 0; i < 130; i++) {
            const x = tl.x + ((i * 79) % Math.max(1, br.x - tl.x));
            const y = tl.y + ((i * 43) % Math.max(1, br.y - tl.y));
            ctx.fillStyle = i % 4 ? "#2d3335" : "#747a7a";
            ctx.fillRect(x, y, 2, 2);
        }
        ctx.restore();
    }

    function drawRoadPolyline(ctx, road) {
        const pts = road.points || [];
        if (pts.length < 2) return;
        const width = (Number(road.width) || 6) * state.camera.scale;

        function path(stroke, lineWidth, dash = []) {
            ctx.save();
            ctx.strokeStyle = stroke;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = "butt";
            ctx.lineJoin = "miter";
            ctx.setLineDash(dash);
            ctx.beginPath();
            pts.forEach((pt, i) => {
                const p = worldToScreen(Array.isArray(pt) ? pt[0] : pt.x, Array.isArray(pt) ? pt[1] : pt.y);
                if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
            });
            ctx.stroke();
            ctx.restore();
        }
        path("#252b2d", width + 8);
        path("#535b5e", width);
        path("#c8c39f", Math.max(1, state.camera.scale * .055), [Math.max(7, state.camera.scale * .6), Math.max(7, state.camera.scale * .5)]);
    }

    function drawSpot(ctx, spot) {
        const p = worldToScreen(spot.x, spot.y);
        const w = (Number(spot.width) || 2.7) * state.camera.scale;
        const l = (Number(spot.length) || 5.2) * state.camera.scale;
        const a = (Number(spot.rotation) || 0) * Math.PI / 180;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(a);
        ctx.strokeStyle = "#e4dfbd";
        ctx.lineWidth = Math.max(2, state.camera.scale * .055);
        ctx.beginPath();
        ctx.moveTo(-w/2, -l/2); ctx.lineTo(-w/2, l/2); ctx.lineTo(w/2, l/2); ctx.lineTo(w/2, -l/2);
        ctx.stroke();
        ctx.strokeStyle = "#b7b198";
        ctx.lineWidth = Math.max(3, state.camera.scale * .09);
        ctx.beginPath();
        ctx.moveTo(-w*.3, -l*.4); ctx.lineTo(w*.3, -l*.4); ctx.stroke();
        ctx.restore();

        if (w > 17) {
            ctx.fillStyle = "#d5d0b0";
            ctx.font = `${Math.max(8, Math.min(12, w*.28))}px "VT323", monospace`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(spotLabel(spot.id), p.x, p.y);
        }

        const car = selectedCar();
        if (car?.reservedSpotId && String(car.reservedSpotId) === String(spot.id)) {
            ctx.fillStyle = "#efd055";
            ctx.strokeStyle = "#20241f";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y - l/2 - 5);
            ctx.lineTo(p.x - 7, p.y - l/2 - 16);
            ctx.lineTo(p.x + 7, p.y - l/2 - 16);
            ctx.closePath(); ctx.fill(); ctx.stroke();
        }
    }

    function drawCrosswalk(ctx, x, y) {
        const p = worldToScreen(x, y);
        const s = state.camera.scale;
        ctx.save();
        ctx.fillStyle = "#ddd8b8";
        for (let i = -2; i <= 2; i++) {
            ctx.fillRect(p.x - s * .12, p.y + i * s * .42 - s * .14, s * .7, s * .22);
        }
        ctx.restore();
    }

    function drawParkingSign(ctx, x, y, label = "P") {
        const p = worldToScreen(x, y);
        ctx.save();
        ctx.fillStyle = "#33393a";
        ctx.fillRect(p.x - 2, p.y, 4, 21);
        ctx.fillStyle = "#e3dfc3";
        ctx.fillRect(p.x - 12, p.y - 24, 24, 24);
        ctx.strokeStyle = "#151919"; ctx.lineWidth = 2;
        ctx.strokeRect(p.x - 12, p.y - 24, 24, 24);
        ctx.fillStyle = "#315f8a";
        ctx.fillRect(p.x - 9, p.y - 21, 18, 18);
        ctx.fillStyle = "white";
        ctx.font = '15px "Press Start 2P", monospace';
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(label, p.x, p.y - 12);
        ctx.restore();
    }

    function drawLamp(ctx, x, y) {
        const p = worldToScreen(x, y);
        ctx.fillStyle = "#303738";
        ctx.fillRect(p.x - 2, p.y - 16, 4, 20);
        ctx.fillStyle = "#f0df8a";
        ctx.fillRect(p.x - 5, p.y - 21, 10, 6);
        ctx.strokeStyle = "#151919"; ctx.lineWidth = 2;
        ctx.strokeRect(p.x - 5, p.y - 21, 10, 6);
    }

    function drawKiosk(ctx, x, y) {
        const p = worldToScreen(x, y);
        ctx.save();
        ctx.fillStyle = "#a49362";
        ctx.fillRect(p.x - 13, p.y - 18, 26, 32);
        ctx.strokeStyle = "#171a1b"; ctx.lineWidth = 3;
        ctx.strokeRect(p.x - 13, p.y - 18, 26, 32);
        ctx.fillStyle = "#2e3836";
        ctx.fillRect(p.x - 9, p.y - 13, 18, 12);
        ctx.fillStyle = "#9dc487";
        ctx.fillRect(p.x - 7, p.y - 11, 14, 8);
        ctx.fillStyle = "#d9d2a6";
        ctx.fillRect(p.x - 5, p.y + 5, 10, 4);
        ctx.restore();
    }

    function drawGate(ctx) {
        const g = gatePoint(state.selectedFloor);
        const p = worldToScreen(g.x, g.y);
        const car = selectedCar();
        const raised = barrierOpenFor(car) && carDistanceToGate(car) < 7;
        const roadHalfPx = laneHalfWidth(state.selectedFloor) * state.camera.scale;

        ctx.save();

        // booth above the lane
        ctx.fillStyle = "#d4c99a";
        ctx.fillRect(p.x - 34, p.y - roadHalfPx - 45, 30, 34);
        ctx.strokeStyle = "#151919";
        ctx.lineWidth = 3;
        ctx.strokeRect(p.x - 34, p.y - roadHalfPx - 45, 30, 34);

        ctx.fillStyle = "#7ca194";
        ctx.fillRect(p.x - 28, p.y - roadHalfPx - 39, 18, 11);
        ctx.strokeRect(p.x - 28, p.y - roadHalfPx - 39, 18, 11);

        // actual terminal post beside the barrier
        const baseY = p.y - roadHalfPx + 3;
        ctx.fillStyle = "#343b3b";
        ctx.fillRect(p.x - 8, baseY - 25, 15, 24);
        ctx.fillStyle = "#b9d69a";
        ctx.fillRect(p.x - 5, baseY - 22, 9, 9);
        ctx.strokeStyle = "#151919";
        ctx.strokeRect(p.x - 8, baseY - 25, 15, 24);

        // barrier base
        ctx.fillStyle = "#d4c059";
        ctx.fillRect(p.x - 8, baseY - 3, 16, 13);
        ctx.strokeRect(p.x - 8, baseY - 3, 16, 13);

        // CLOSED = arm goes vertically across the lane.
        // OPEN = arm swings parallel to the road.
        ctx.translate(p.x, baseY + 2);
        ctx.rotate(raised ? 0 : Math.PI / 2);

        const arm = Math.max(54, roadHalfPx * 2 - 10);
        ctx.fillStyle = "#eee9d5";
        ctx.fillRect(0, -4, arm, 8);
        for (let i = 8; i < arm; i += 18) {
            ctx.fillStyle = "#c54b44";
            ctx.fillRect(i, -4, 9, 8);
        }
        ctx.strokeStyle = "#151919";
        ctx.lineWidth = 2;
        ctx.strokeRect(0, -4, arm, 8);

        ctx.restore();
    }

    function drawEnvironment(ctx, rect) {
        drawPixelGrass(ctx, rect.width, rect.height);
        drawParkingSlab(ctx);
        floorRoads().forEach((road) => drawRoadPolyline(ctx, road));

        const f = currentFloor();
        if (!f) return;
        const fw = Number(f.width) || 36;
        const fh = Number(f.height) || 30;

        // trees around the outer edge, leaving the entrance/exit clear
        for (let x = 1.5; x < fw - 1; x += 3.1) {
            if (x > 1 && x < 5) continue;
            if (x > fw - 5) continue;
            drawTree(ctx, x, .55, .9);
            drawTree(ctx, x, fh - .55, .9);
        }
        for (let y = 3.5; y < fh - 3; y += 3.2) {
            drawTree(ctx, .15, y, .82);
            drawTree(ctx, fw - .15, y, .82);
        }

        drawFence(ctx, 4.8, 1.05, fw - 4.8, 1.05);
        drawFence(ctx, 4.8, fh - 1.05, fw - 4.8, fh - 1.05);

        // Side perimeter fences. Only the marked entrance and exit have openings.
        const e = entrancePoint(state.selectedFloor);
        const ex = exitPoint(state.selectedFloor);
        const opening = laneHalfWidth(state.selectedFloor) + 0.55;

        drawFence(ctx, 1.05, 1.05, 1.05, Math.max(1.05, e.y - opening));
        drawFence(ctx, 1.05, Math.min(fh - 1.05, e.y + opening), 1.05, fh - 1.05);
        drawFence(ctx, fw - 1.05, 1.05, fw - 1.05, Math.max(1.05, ex.y - opening));
        drawFence(ctx, fw - 1.05, Math.min(fh - 1.05, ex.y + opening), fw - 1.05, fh - 1.05);

        // environmental props
        drawParkingSign(ctx, e.x + 2.1, e.y - 3.0, "P");
        drawKiosk(ctx, e.x + 2.35, e.y + 3.1);
        drawCrosswalk(ctx, e.x + 4.4, e.y);
        drawCrosswalk(ctx, ex.x - 3.2, ex.y);
        drawLamp(ctx, 10, 10.4);
        drawLamp(ctx, 18, 17.6);
        drawLamp(ctx, 26, 10.4);
        drawLamp(ctx, 32, 17.6);

        floorSpots().forEach((spot) => drawSpot(ctx, spot));
        drawGate(ctx);
    }

    function drawCarSprite(ctx, car) {
        if (String(car.floor) !== String(state.selectedFloor)) return;
        const p = worldToScreen(car.x, car.y);
        const selected = car.id === state.selectedCarId;

        // Keep physical dimensions for sensors, but render as a smaller RPG sprite.
        const pxW = clamp(car.width * state.camera.scale * car.visualScale, 18, 34);
        const pxL = clamp(car.length * state.camera.scale * car.visualScale, 30, 52);

        ctx.save();
        ctx.translate(Math.round(p.x), Math.round(p.y));
        ctx.rotate(car.angle);
        ctx.imageSmoothingEnabled = false;

        // shadow
        ctx.fillStyle = "rgba(0,0,0,.32)";
        ctx.fillRect(Math.round(-pxW/2 + 3), Math.round(-pxL/2 + 4), Math.round(pxW), Math.round(pxL));

        // wheels
        ctx.fillStyle = "#15191a";
        const ww = Math.max(3, Math.round(pxW * .16));
        const wl = Math.max(5, Math.round(pxL * .18));
        ctx.fillRect(Math.round(-pxW/2 - 1), Math.round(-pxL*.31), ww, wl);
        ctx.fillRect(Math.round(pxW/2 - ww + 1), Math.round(-pxL*.31), ww, wl);
        ctx.fillRect(Math.round(-pxW/2 - 1), Math.round(pxL*.15), ww, wl);
        ctx.fillRect(Math.round(pxW/2 - ww + 1), Math.round(pxL*.15), ww, wl);

        // body block
        ctx.fillStyle = car.color;
        ctx.strokeStyle = "#15191a";
        ctx.lineWidth = 2;
        ctx.fillRect(Math.round(-pxW/2), Math.round(-pxL/2), Math.round(pxW), Math.round(pxL));
        ctx.strokeRect(Math.round(-pxW/2), Math.round(-pxL/2), Math.round(pxW), Math.round(pxL));

        // hood highlight
        ctx.fillStyle = "rgba(255,255,255,.14)";
        ctx.fillRect(Math.round(-pxW*.32), Math.round(-pxL*.43), Math.round(pxW*.64), Math.max(2, Math.round(pxL*.08)));

        // windshield
        ctx.fillStyle = "#95bcc3";
        ctx.fillRect(Math.round(-pxW*.34), Math.round(-pxL*.23), Math.round(pxW*.68), Math.max(4, Math.round(pxL*.16)));
        ctx.fillStyle = "#5f858d";
        ctx.fillRect(Math.round(-pxW*.31), Math.round(pxL*.12), Math.round(pxW*.62), Math.max(4, Math.round(pxL*.13)));

        // roof stripe
        ctx.fillStyle = "rgba(255,255,255,.1)";
        ctx.fillRect(Math.round(-pxW*.33), Math.round(-pxL*.015), Math.round(pxW*.66), Math.max(2, Math.round(pxL*.09)));

        // lights
        ctx.fillStyle = "#f0dd92";
        ctx.fillRect(Math.round(-pxW*.36), Math.round(-pxL/2 + 1), Math.max(3, Math.round(pxW*.18)), 3);
        ctx.fillRect(Math.round(pxW*.18), Math.round(-pxL/2 + 1), Math.max(3, Math.round(pxW*.18)), 3);
        ctx.fillStyle = "#bb423d";
        ctx.fillRect(Math.round(-pxW*.36), Math.round(pxL/2 - 4), Math.max(3, Math.round(pxW*.18)), 3);
        ctx.fillRect(Math.round(pxW*.18), Math.round(pxL/2 - 4), Math.max(3, Math.round(pxW*.18)), 3);

        if (selected) {
            ctx.strokeStyle = "#f0d15d";
            ctx.lineWidth = 2;
            ctx.strokeRect(Math.round(-pxW/2 - 3), Math.round(-pxL/2 - 3), Math.round(pxW + 6), Math.round(pxL + 6));
        }
        ctx.restore();

        if (selected) {
            ctx.save();
            ctx.font = '13px "VT323", monospace';
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.strokeStyle = "#161a1b"; ctx.lineWidth = 3;
            ctx.strokeText(car.name, p.x, p.y - pxL/2 - 6);
            ctx.fillStyle = "#f0d15d";
            ctx.fillText(car.name, p.x, p.y - pxL/2 - 6);
            ctx.restore();
        }
    }

    function draw() {
        const r = viewportRect();
        const dpr = Math.min(2, devicePixelRatio || 1);
        const cw = Math.round(r.width * dpr);
        const ch = Math.round(r.height * dpr);
        if (ui.canvas.width !== cw || ui.canvas.height !== ch) {
            ui.canvas.width = cw;
            ui.canvas.height = ch;
        }
        const ctx = ui.canvas.getContext("2d");
        ctx.setTransform(dpr,0,0,dpr,0,0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0,0,r.width,r.height);
        if (!state.layout) return;
        drawEnvironment(ctx, r);
        state.cars.forEach((car) => drawCarSprite(ctx, car));
    }

    /* =========================================================
       PHYSICS / NAVIGATION
    ========================================================== */

    function enforceGarageAccess(car, prevX, prevY) {
        const floor = floorById(car.floor);
        if (!floor) return;

        const right = (Number(floor.width) || 36) - LOT_LEFT_M;
        const bottom = (Number(floor.height) || 30) - LOT_TOP_M;
        const wasInside = insideLot(prevX, prevY, floor);
        const isInside = insideLot(car.x, car.y, floor);
        const entrance = entrancePoint(car.floor);
        const exit = exitPoint(car.floor);
        const gate = gatePoint(car.floor);

        // Trying to enter the lot from outside: ONLY the entrance opening is valid.
        if (!wasInside && isInside) {
            const throughEntrance =
                prevX < LOT_LEFT_M &&
                car.x >= LOT_LEFT_M &&
                inEntranceOpening(car.y, car.floor);

            if (!throughEntrance) {
                car.x = prevX;
                car.y = prevY;
                car.speed = 0;
                return;
            }
        }

        // If already inside, the perimeter is solid except entrance + exit openings.
        if (wasInside && !isInside) {
            const leavingEntrance =
                car.x < LOT_LEFT_M &&
                inEntranceOpening(car.y, car.floor);

            const leavingExit =
                car.x > right &&
                inExitOpening(car.y, car.floor);

            if (!leavingEntrance && !leavingExit) {
                car.x = prevX;
                car.y = prevY;
                car.speed = 0;
                return;
            }
        }

        // Real barrier collision: reservation is what opens the entrance gate.
        const nearEntranceLane =
            Math.abs(car.y - entrance.y) <= laneHalfWidth(car.floor);

        if (!barrierOpenFor(car) && nearEntranceLane) {
            const stopX = gate.x - Math.max(1.0, car.length * 0.28);

            if (prevX <= stopX && car.x > stopX) {
                car.x = stopX;
                car.speed = 0;
                message("Gate closed. Press SPACE near the terminal to view the parking display.");
            }
        }
    }

    function updatePhysics(dt) {
        if (!state.started || state.paused || state.gateVisible) return;
        const car = selectedCar();
        if (!car) return;

        const forward = state.keys.has("KeyW") || state.keys.has("ArrowUp");
        const backward = state.keys.has("KeyS") || state.keys.has("ArrowDown");
        const left = state.keys.has("KeyA") || state.keys.has("ArrowLeft");
        const right = state.keys.has("KeyD") || state.keys.has("ArrowRight");
        const hardBrake = state.keys.has("Space");

        const throttleAccel = 3.5;
        const reverseAccel = 2.7;
        const naturalDrag = 1.35;
        const brakePower = 8.0;
        const maxForward = 5.5;
        const maxReverse = -2.4;
        const wheelbase = 2.55;
        const maxSteer = 0.50;

        if (forward) car.speed += throttleAccel * dt;
        if (backward) car.speed -= reverseAccel * dt;

        if (!forward && !backward) {
            const sign = Math.sign(car.speed);
            car.speed -= sign * Math.min(Math.abs(car.speed), naturalDrag * dt);
        }

        if (hardBrake) {
            const sign = Math.sign(car.speed);
            car.speed -= sign * Math.min(Math.abs(car.speed), brakePower * dt);
        }

        car.speed = clamp(car.speed, maxReverse, maxForward);

        const desiredSteer = (left ? -1 : 0) + (right ? 1 : 0);
        const steerBlend = 1 - Math.exp(-10 * dt);
        car.steering = lerp(car.steering, desiredSteer, steerBlend);

        if (Math.abs(car.speed) > .03) {
            const steeringAngle = car.steering * maxSteer;
            car.angle += (car.speed / wheelbase) * Math.tan(steeringAngle) * dt;
        }

        const prevX = car.x;
        const prevY = car.y;

        car.x += Math.sin(car.angle) * car.speed * dt;
        car.y -= Math.cos(car.angle) * car.speed * dt;

        enforceGarageAccess(car, prevX, prevY);

        const f = floorById(car.floor);
        if (f) {
            car.x = clamp(car.x, -14, Number(f.width) + 10);
            car.y = clamp(car.y, -8, Number(f.height) + 8);
        }
    }

    function worldToLocalPoint(x, y, cx, cy, angle) {
        const dx = x - cx, dy = y - cy;
        const c = Math.cos(angle), s = Math.sin(angle);
        return {x: dx*c + dy*s, y: -dx*s + dy*c};
    }

    function pointInSpot(x, y, spot, margin = 0) {
        const angle = (Number(spot.rotation) || 0) * Math.PI / 180;
        const p = worldToLocalPoint(x,y,Number(spot.x),Number(spot.y),angle);
        return Math.abs(p.x) <= (Number(spot.width)||2.7)/2 - margin &&
               Math.abs(p.y) <= (Number(spot.length)||5.2)/2 - margin;
    }

    function updateParkedState() {
        for (const car of state.cars) {
            if (Math.abs(car.speed) > .7) { car.parkedSpotId = null; continue; }
            const spot = (state.layout?.spots || []).find(
                (s) => String(s.floor) === String(car.floor) && pointInSpot(car.x,car.y,s,.12)
            );
            car.parkedSpotId = spot ? String(spot.id) : null;
        }
    }

    /* =========================================================
       VIRTUAL SENSOR MODEL
    ========================================================== */

    function rotateVector(x,y,a) {
        return {x:x*Math.cos(a)-y*Math.sin(a), y:x*Math.sin(a)+y*Math.cos(a)};
    }

    function sensorPose(spot, lateral = 0) {
        const a = (Number(spot.rotation)||0)*Math.PI/180;
        const len = Number(spot.length)||5.2;
        const off = rotateVector(lateral, -len/2 + .08, a);
        const dir = rotateVector(0,1,a);
        return {x:Number(spot.x)+off.x, y:Number(spot.y)+off.y, dx:dir.x, dy:dir.y};
    }

    function rayVsCarDistance(ray, car) {
        const origin = worldToLocalPoint(ray.x,ray.y,car.x,car.y,car.angle);
        const c=Math.cos(car.angle), s=Math.sin(car.angle);
        const dir={x:ray.dx*c+ray.dy*s, y:-ray.dx*s+ray.dy*c};
        const hw=car.width/2, hl=car.length/2;
        let tMin=0, tMax=SENSOR_MAX_CM/100;
        const axes=[
            {o:origin.x,d:dir.x,min:-hw,max:hw},
            {o:origin.y,d:dir.y,min:-hl,max:hl}
        ];
        for (const a of axes) {
            if (Math.abs(a.d)<1e-8) {
                if (a.o<a.min || a.o>a.max) return null;
                continue;
            }
            let t1=(a.min-a.o)/a.d, t2=(a.max-a.o)/a.d;
            if (t1>t2) [t1,t2]=[t2,t1];
            tMin=Math.max(tMin,t1); tMax=Math.min(tMax,t2);
            if (tMin>tMax) return null;
        }
        if (tMax<0) return null;
        return Math.max(0.02,tMin);
    }

    function distanceForSpot(spot) {
        let nearest=SENSOR_MAX_CM/100;
        for (const lateral of SENSOR_BEAM_OFFSETS_M) {
            const ray=sensorPose(spot,lateral);
            for (const car of state.cars) {
                if (String(car.floor)!==String(spot.floor)) continue;
                const d=rayVsCarDistance(ray,car);
                if (d!==null && d<nearest) nearest=d;
            }
        }
        return clamp(nearest*100,0,SENSOR_MAX_CM);
    }

    async function sendDistanceFrameToGateway(distances) {
        /*
          This sends DISTANCE ONLY.

          It does NOT send FREE/OCCUPIED and it does NOT bypass the ESP32.
          The later HIL-side bridge will read this same frame from the gateway
          and update the 16 virtual HC-SR04 channels.
        */
        if (state.hilPostInFlight) {
            // Drop this frame instead of building up a request queue.
            // The next 100 ms frame will contain the newest values.
            return;
        }

        state.hilPostInFlight = true;

        const frame = {
            version: 1,
            zone_id: HIL_ZONE_ID,
            sequence: ++state.hilFrameSequence,
            sent_at_ms: Date.now(),
            distances_cm: { ...distances }
        };

        try {
            const response = await fetch(
                HIL_DISTANCE_ENDPOINT,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify(frame),
                    cache: "no-store"
                }
            );

            if (!response.ok) {
                throw new Error(
                    `Distance bridge HTTP ${response.status}`
                );
            }

            if (!state.hilBridgeConnected) {
                state.hilBridgeConnected = true;
                setStatus(
                    ui.hilStatus,
                    "live",
                    "Distance bridge live"
                );
            }
        }
        catch (error) {
            if (state.hilBridgeConnected) {
                console.warn(
                    "[SIM] HIL distance bridge offline:",
                    error
                );
            }

            state.hilBridgeConnected = false;

            setStatus(
                ui.hilStatus,
                "error",
                "Distance bridge offline"
            );
        }
        finally {
            state.hilPostInFlight = false;
        }
    }

    function updateSensorDistances(now) {
        const next={};
        for (const spot of state.layout?.spots || []) {
            next[String(spot.id)] = Number(distanceForSpot(spot).toFixed(1));
        }
        state.hilDistances=next;
        if (now-state.lastHilPush>=HIL_UPDATE_INTERVAL_MS) {
            state.lastHilPush=now;

            if (state.sensorHudVisible) {
                renderDistanceHud();
            }

            // Keep the local event because it is useful for browser debugging.
            window.dispatchEvent(
                new CustomEvent(
                    "parkside:hil-distances",
                    { detail: { ...next } }
                )
            );

            // Real transport path used by the future HIL bridge.
            sendDistanceFrameToGateway(next);
        }
    }

    function buildDistanceHud() {
        const frag=document.createDocumentFragment();
        for (const spot of state.layout?.spots || []) {
            const cell=document.createElement("div");
            cell.className="distance-cell";
            cell.dataset.spotId=String(spot.id);
            cell.innerHTML=`<span>${spotLabel(spot.id)}</span><strong>200 cm</strong>`;
            frag.append(cell);
        }
        ui.distanceGrid.replaceChildren(frag);
    }

    function renderDistanceHud() {
        for (const cell of ui.distanceGrid.querySelectorAll(".distance-cell")) {
            const d=state.hilDistances[cell.dataset.spotId] ?? SENSOR_MAX_CM;
            cell.querySelector("strong").textContent=`${d.toFixed(0)} cm`;
            cell.dataset.near=String(d<80);
        }
    }

    /* =========================================================
       CLICK CAR
    ========================================================== */

    function findCarAt(x,y) {
        return state.cars.slice().reverse().find((car) => {
            if (String(car.floor)!==String(state.selectedFloor)) return false;
            const p=worldToLocalPoint(x,y,car.x,car.y,car.angle);
            return Math.abs(p.x)<=car.width/2+.45 && Math.abs(p.y)<=car.length/2+.45;
        }) || null;
    }

    function message(text) {
        ui.message.textContent=text;
    }

    /* =========================================================
       PAUSE MENU
    ========================================================== */

    function syncPauseMenu() {
        if (!ui.pauseScreen) return;

        const musicStrong = ui.pauseMusic?.querySelector("strong");
        if (musicStrong) {
            musicStrong.textContent = state.musicEnabled ? "ON" : "OFF";
        }

        const fullscreenStrong = ui.pauseFullscreen?.querySelector("strong");
        if (fullscreenStrong) {
            fullscreenStrong.textContent = document.fullscreenElement ? "EXIT" : "ENTER";
        }
    }

    function openPauseMenu() {
        if (!state.started || state.gateVisible) return;

        state.paused = true;
        state.keys.clear();
        ui.pause.textContent = "RESUME";
        ui.pauseScreen.hidden = false;
        syncPauseMenu();
        requestAnimationFrame(() => ui.pauseResume?.focus());
    }

    function closePauseMenu() {
        if (!state.started) return;

        state.paused = false;
        ui.pause.textContent = "PAUSE";
        ui.pauseScreen.hidden = true;
        message("Simulation resumed.");
        ui.viewport.focus();
    }

    function restartSelectedCarFromPause() {
        resetSelectedCar();
        syncPauseMenu();
        message(`${selectedCar()?.name || "Car"} restarted at the entrance.`);
    }

    function restartSimulator() {
        window.location.reload();
    }

    async function returnToMainMenu() {
        state.keys.clear();
        state.paused = false;
        state.started = false;

        hideGateDisplay();
        hideGatePrompt();

        ui.pauseScreen.hidden = true;
        ui.startScreen.hidden = false;
        document.body.classList.remove("sim-running");

        if (document.fullscreenElement) {
            try {
                await document.exitFullscreen?.();
            } catch (error) {
                console.warn("Could not exit fullscreen", error);
            }
        }

        if (state.menuMusicDesired) {
            await startMusic();
        } else {
            stopMusic();
        }

        syncMusicButtons();
        syncFullscreenButton();
        requestAnimationFrame(() => ui.startButton?.focus());
    }

    /* =========================================================
       LOOP
    ========================================================== */

    function tick(now) {
        const dt=Math.min(.05,(now-lastFrame)/1000);
        lastFrame=now;
        updatePhysics(dt);
        updateParkedState();
        updateSensorDistances(now);
        updateGateProximity();
        updateCamera(dt);
        renderSelectedCar();
        draw();
        raf=requestAnimationFrame(tick);
    }

    /* =========================================================
       EVENTS
    ========================================================== */

    ui.startButton?.addEventListener("click", startSimulator);
    ui.menuMusicToggle?.addEventListener("click", toggleMenuMusic);
    ui.musicToggle?.addEventListener("click", toggleMusic);
    ui.fullscreenToggle?.addEventListener("click", toggleFullscreen);

    /*
      Let menu music begin as soon as the browser receives a user gesture,
      without starting the game.
    */
    ui.startScreen?.addEventListener(
        "pointerdown",
        tryStartMenuMusic,
        { passive: true }
    );

    ui.startScreen?.addEventListener(
        "keydown",
        tryStartMenuMusic
    );

    document.addEventListener("fullscreenchange", () => {
        document.body.classList.toggle(
            "sim-fullscreen",
            Boolean(document.fullscreenElement)
        );

        syncFullscreenButton();
        if (state.paused) syncPauseMenu();

        requestAnimationFrame(() => {
            if (state.camera.mode === "fit") fitCamera(true);
            scaleIframe(ui.gateFrame, ui.gateStage, DISPLAY_NATIVE_W, DISPLAY_NATIVE_H);
            scalePhone();

            requestAnimationFrame(() => {
                scalePhone();
            });
        });
    });

    ui.floorSelect.addEventListener("change",() => {
        state.selectedFloor=String(ui.floorSelect.value);
        ui.floorTitle.textContent=floorName(state.selectedFloor);
        fitCamera(false);
        ui.viewport.focus();
    });

    ui.addCar.addEventListener("click",() => addCar());
    ui.parkCar?.addEventListener("click", parkSelectedCarCleanly);
    ui.parkCarQuick?.addEventListener("click", parkSelectedCarCleanly);

    ui.resetCar.addEventListener("click",() => resetSelectedCar());

    ui.fitMap.addEventListener("click",() => {
        if (state.camera.mode==="follow") fitCamera(false); else followCamera();
        ui.viewport.focus();
    });

    ui.pause.addEventListener("click",() => {
        if (state.paused) closePauseMenu();
        else openPauseMenu();
    });

    ui.pauseResume?.addEventListener("click", closePauseMenu);
    ui.pauseRestartCar?.addEventListener("click", restartSelectedCarFromPause);
    ui.pauseFullscreen?.addEventListener("click", async () => {
        await toggleFullscreen();
        syncPauseMenu();
    });
    ui.pauseMusic?.addEventListener("click", async () => {
        await toggleMusic();
        syncPauseMenu();
    });
    ui.pauseRestartGame?.addEventListener("click", restartSimulator);
    ui.pauseMainMenu?.addEventListener("click", returnToMainMenu);

    ui.sensorsToggle.addEventListener("click",() => {
        state.sensorHudVisible=!state.sensorHudVisible;
        ui.distanceHud.hidden=!state.sensorHudVisible;
        ui.sensorsToggle.textContent=state.sensorHudVisible?"HIDE SENSORS":"SENSORS";
        if (state.sensorHudVisible) renderDistanceHud();
        ui.viewport.focus();
    });

    ui.gateDismiss.addEventListener("click",() => {
        hideGateDisplay(false);

        const car = selectedCar();
        if (
            car &&
            !car.reservationId &&
            carDistanceToGate(car) <= GATE_OPEN_RADIUS_M
        ) {
            showGatePrompt();
        }
    });

    ui.viewport.addEventListener("click",(ev) => {
        if (state.gateVisible) return;
        const w=screenToWorld(ev.clientX,ev.clientY);
        const car=findCarAt(w.x,w.y);
        if (car) selectCar(car.id);
        ui.viewport.focus();
    });

    const driveCodes=["KeyW","KeyA","KeyS","KeyD","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Space"];

    window.addEventListener("keydown",(ev) => {
        const active=document.activeElement;
        const editing=active && ["INPUT","TEXTAREA","SELECT"].includes(active.tagName);
        if (editing) return;

        if (!state.started) {
            tryStartMenuMusic();

            if (ev.code === "Enter") {
                ev.preventDefault();
                startSimulator();
            }

            return;
        }

        if (ev.code === "KeyP") {
            ev.preventDefault();
            if (state.paused) closePauseMenu();
            else openPauseMenu();
            return;
        }

        if (state.paused) {
            if (ev.code === "KeyF") {
                ev.preventDefault();
                toggleFullscreen().then(syncPauseMenu);
            }
            return;
        }

        if (
            ev.code === "Space" &&
            state.gatePromptVisible &&
            !state.gateVisible
        ) {
            ev.preventDefault();
            state.keys.delete("Space");
            openGateDisplayFromPrompt();
            return;
        }

        if (ev.code === "KeyF") {
            ev.preventDefault();
            toggleFullscreen();
            return;
        }

        if (ev.code==="KeyR") {
            ev.preventDefault();
            resetSelectedCar();
            return;
        }

        if (driveCodes.includes(ev.code)) {
            ev.preventDefault();
            state.keys.add(ev.code);

            if (state.camera.mode!=="follow") {
                followCamera();
            }
        }
    },{passive:false});

    window.addEventListener("keyup",(ev) => state.keys.delete(ev.code));
    window.addEventListener("blur",() => state.keys.clear());
    window.addEventListener("resize",() => {
        if (state.camera.mode==="fit") fitCamera(true);
        scaleIframe(ui.gateFrame,ui.gateStage,DISPLAY_NATIVE_W,DISPLAY_NATIVE_H);
        scalePhone();
    });

    function installPhoneSimulatorHooks() {
        try {
            const doc = ui.phoneFrame.contentDocument;
            if (!doc) return;

            const stopButton =
                doc.getElementById("stop-navigation-button");

            if (
                stopButton &&
                stopButton.dataset.simulatorCancelHook !== "true"
            ) {
                stopButton.dataset.simulatorCancelHook = "true";

                stopButton.addEventListener(
                    "click",
                    () => {
                        /*
                          Let the real phone app run its normal stopNavigation()
                          first. Then reload the embedded phone once so any
                          compact/fullscreen map state is guaranteed to reset.
                          The reservation survives because it lives in
                          localStorage / gateway state.
                        */
                        window.setTimeout(
                            () => {
                                try {
                                    ui.phoneFrame.contentWindow
                                        .location.reload();
                                }
                                catch (error) {
                                    console.warn(
                                        "Could not reset embedded phone navigation",
                                        error
                                    );
                                }
                            },
                            80
                        );
                    }
                );
            }
        }
        catch (error) {
            console.warn(
                "Could not install embedded phone navigation hook",
                error
            );
        }
    }

    function handlePhoneFrameLoad() {
        scalePhone();
        installPhoneSimulatorHooks();
    }

    ui.phoneFrame.addEventListener(
        "load",
        handlePhoneFrameLoad
    );
    ui.gateFrame.addEventListener("load",() => scaleIframe(ui.gateFrame,ui.gateStage,DISPLAY_NATIVE_W,DISPLAY_NATIVE_H));

    /* =========================================================
       HIL DEBUG API
    ========================================================== */

    window.parksideSimulator={
        getDistances:()=>({...state.hilDistances}),
        getCars:()=>state.cars.map((c)=>({...c})),
        getSelectedCar:()=>selectedCar()?{...selectedCar()}:null
    };

    /* =========================================================
       INIT
    ========================================================== */

    async function init() {
        try {
            await loadLayout();
            await refreshSpots();
            setStatus(ui.hilStatus,"live","Distance model ready");

            addCar(); addCar(); addCar();
            state.selectedCarId=state.cars[0].id;
            selectCar(state.selectedCarId,false);

            // Start fitted so the player understands the world; driving switches to follow.
            fitCamera(true);
            renderCarsList();
            renderSelectedCar();
            updatePhone();
            installPhoneResizeObserver();
            scalePhone();
            scaleIframe(ui.gateFrame,ui.gateStage,DISPLAY_NATIVE_W,DISPLAY_NATIVE_H);

            spotPoll=setInterval(refreshSpots,1200);
            lastFrame=performance.now();
            raf=requestAnimationFrame(tick);
            syncMusicButtons();
            syncFullscreenButton();

            /*
              Best-effort autoplay. If the browser blocks it,
              the first interaction with the game menu retries.
            */
            tryStartMenuMusic();

            message("Press START GAME to begin.");
            setTimeout(() => ui.startButton?.focus(), 100);
        } catch (err) {
            console.error(err);
            message(err?.message || "Simulator failed to start.");
            setStatus(ui.gatewayStatus,"error","Simulator error");
        }
    }

    init();
})();
