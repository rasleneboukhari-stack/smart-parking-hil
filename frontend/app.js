"use strict";

(() => {
    const POLL_INTERVAL = 3000;
    const LAYOUT_REFRESH_INTERVAL = 30000;
    const STORAGE_KEY = "reservation_id";

    const CLEAR_WHEN_TERMINAL = new Set([
        "EXPIRED",
        "CANCELLED"
    ]);

    const VALID_RESERVATION_STATES = new Set([
        "ACTIVE",
        "AWAITING_CONFIRMATION",
        "COMPLETED",
        "EXPIRED",
        "CANCELLED"
    ]);

    const $ = (id) => document.getElementById(id);

    const ui = {
        connection: $("connection"),
        connectionText: $("connection-text"),

        placeholder: $("map-loading"),
        empty: $("map-empty"),
        notice: $("notice"),

        canvas: $("parking-canvas"),
        mapViewport: $("map-viewport"),
        mapAccessibilityLayer: $("map-accessibility-layer"),
        mapGestureHint: $("map-gesture-hint"),
        mapScale: $("map-scale"),
        mapRecenter: $("map-recenter"),
        mapCenterControl: $("map-center-control"),

        mapRouteCard: $("map-route-card"),
        mapRouteTitle: $("map-route-title"),
        mapRouteInstruction: $("map-route-instruction"),
        mapRouteClose: $("map-route-close"),

        mapPlaceCard: $("map-place-card"),
        mapPlaceBadge: $("map-place-badge"),
        mapPlaceStatus: $("map-place-status"),
        mapPlaceTitle: $("map-place-title"),
        mapPlaceMeta: $("map-place-meta"),
        mapPlaceNavigate: $("map-place-navigate"),
        mapPlaceReserve: $("map-place-reserve"),
        mapPlaceClose: $("map-place-close"),

        mapDirectNavigate: $("map-direct-navigate"),
        mapDirectNavigateLabel: $("map-direct-navigate-label"),

        dialog: $("arrival-dialog"),
        dialogError: $("dialog-error"),

        confirm: $("confirm-button"),
        notMyCar: $("not-my-car-button"),
        reserveAnother: $("reserve-another-button"),
        parkedElsewhere: $("parked-elsewhere-button"),
        arrivalBack: $("arrival-back-button"),
        later: $("later-button"),

        cancel: $("cancel-button"),
        review: $("review-button"),
        navigate: $("navigate-button"),
        findCar: $("find-car-button"),

        exitMove: $("exit-move-button"),
        parkedElsewhereBanner: $("parked-elsewhere-banner"),
        exitParkedElsewhere: $("exit-parked-elsewhere-button"),

        locationButton: $("location-button"),
        locationIndicator: $("location-indicator"),
        locationText: $("location-text"),

        navigationPanel: $("navigation-panel"),
        navigationTitle: $("navigation-title"),
        navigationInstruction: $("navigation-instruction"),
        navigationLocation: $("navigation-location"),
        stopNavigation: $("stop-navigation-button"),

        floorTabs: $("floor-tabs"),
        zoneTabs: $("zone-tabs"),
        garageLocation: $("garage-location"),
        reservationLocation: $("reservation-location"),

        mapZoomOut: $("map-zoom-out"),
        mapZoomIn: $("map-zoom-in"),
        mapZoomFit: $("map-zoom-fit"),
        mapZoomValue: $("map-zoom-value"),
        availabilityScope: $("availability-scope"),

        garage: $("parking-garage"),
        mapFullscreenToggle: $("map-fullscreen-toggle"),
        mapFullscreenLabel: $("map-fullscreen-label")
    };

    const state = {
        spots: {},
        layout: null,
        layoutLoaded: false,
        layoutLoadedAt: 0,
        layoutFingerprint: "",

        reservationId: readStoredId(),
        reservation: null,

        loaded: false,
        online: false,
        busy: false,

        moving: false,
        parkedElsewhereMode: false,
        arrivalStep: "question",
        dismissedArrival: null,

        navigationTarget: null,
        navigationMode: null,
        route: null,

        // A tap selects a map place first. Actions come from the
        // map-native place card, like a modern maps application.
        selectedMapSpot: null,

        selectedFloor: null,
        selectedZone: "ALL",

        mapFullscreen: false,

        camera: {
            centerX: 0,
            centerY: 0,
            scale: 1,
            fitScale: 1,
            minScale: 0.2,
            maxScale: 8,
            initialized: false,
            userInteracted: false
        },

        location: {
            watchId: null,
            enabled: false,
            lat: null,
            lon: null,
            accuracy: null,
            error: null
        }
    };

    let pollPromise = null;
    let timer = null;
    let dialogReturnFocus = null;
    let mapFrame = null;
    let cameraAnimationFrame = null;
    let suppressMapTapUntil = 0;
    let lastTouchTap = null;

    const compactLayout =
        window.matchMedia("(max-width: 600px)");

    const layoutIndex = {
        floors: new Map(),
        spots: new Map(),
        spotsByFloor: new Map(),
        spotsByFloorZone: new Map(),
        spatial: new Map(),
        nodes: new Map(),
        adjacency: new Map()
    };

    const SPATIAL_CELL_METERS = 8;

    const activeMapPointers = new Map();
    let panGesture = null;
    let pinchGesture = null;

    const CAMERA_ZOOM_FACTOR = 1.25;
    const CAMERA_MAX_FACTOR = 10;
    const CAMERA_MIN_FACTOR = 0.35;

    // ============================================================
    //                  MAP CAMERA / INTERACTION
    // ============================================================

    function currentFloor() {
        if (!state.layoutLoaded || !state.layout) {
            return null;
        }

        return (
            layoutIndex.floors.get(state.selectedFloor) ||
            state.layout.floors?.[0] ||
            null
        );
    }

    function viewportSize() {
        return {
            width: Math.max(1, ui.mapViewport.clientWidth),
            height: Math.max(1, ui.mapViewport.clientHeight)
        };
    }

    function floorBounds(floor = currentFloor()) {
        if (!floor) {
            return null;
        }

        return {
            minX: 0,
            minY: 0,
            maxX: Number(floor.width) || 1,
            maxY: Number(floor.height) || 1
        };
    }

    function calculateFitScale(floor = currentFloor()) {
        if (!floor) {
            return 1;
        }

        const { width, height } = viewportSize();
        const padding = state.mapFullscreen ? 34 : 24;

        return Math.max(
            0.01,
            Math.min(
                Math.max(1, width - padding * 2) /
                    Math.max(1, Number(floor.width) || 1),
                Math.max(1, height - padding * 2) /
                    Math.max(1, Number(floor.height) || 1)
            )
        );
    }

    function updateCameraLimits() {
        const fitScale = calculateFitScale();

        state.camera.fitScale = fitScale;
        state.camera.minScale =
            Math.max(0.01, fitScale * CAMERA_MIN_FACTOR);
        state.camera.maxScale =
            Math.max(
                state.camera.minScale,
                fitScale * CAMERA_MAX_FACTOR
            );

        state.camera.scale = Math.min(
            state.camera.maxScale,
            Math.max(
                state.camera.minScale,
                state.camera.scale
            )
        );
    }

    function clampCamera() {
        /*
          Deliberately do NOT clamp centerX/centerY to the garage.
          Modern maps let the user pan past the mapped object and show
          surrounding context. Here that context is rendered as grey.

          If the user moves away from the garage, FIT / Recenter brings
          them back immediately.
        */
        updateCameraLimits();

        state.camera.scale =
            Math.min(
                state.camera.maxScale,
                Math.max(
                    state.camera.minScale,
                    state.camera.scale
                )
            );
    }

    function cancelCameraAnimation() {
        if (
            cameraAnimationFrame !==
            null
        ) {
            cancelAnimationFrame(
                cameraAnimationFrame
            );

            cameraAnimationFrame =
                null;
        }
    }

    function animateCameraTo(
        target,
        duration = 430
    ) {
        if (!target) {
            return;
        }

        cancelCameraAnimation();
        updateCameraLimits();

        const startX =
            state.camera.centerX;

        const startY =
            state.camera.centerY;

        const startScale =
            Math.max(
                0.0001,
                state.camera.scale
            );

        const targetX =
            Number(target.centerX);

        const targetY =
            Number(target.centerY);

        const targetScale =
            Math.min(
                state.camera.maxScale,
                Math.max(
                    state.camera.minScale,
                    Number(target.scale)
                )
            );

        if (
            !Number.isFinite(targetX) ||
            !Number.isFinite(targetY) ||
            !Number.isFinite(targetScale)
        ) {
            return;
        }

        const reducedMotion =
            window.matchMedia(
                "(prefers-reduced-motion: reduce)"
            ).matches;

        if (
            reducedMotion ||
            duration <= 0
        ) {
            state.camera.centerX =
                targetX;

            state.camera.centerY =
                targetY;

            state.camera.scale =
                targetScale;

            state.camera.initialized =
                true;

            state.camera.userInteracted =
                false;

            scheduleMapDraw();
            return;
        }

        const started =
            performance.now();

        const scaleRatio =
            targetScale /
            startScale;

        const ease =
            (t) =>
                1 -
                Math.pow(
                    1 - t,
                    3
                );

        const step =
            (now) => {
                const raw =
                    Math.min(
                        1,
                        (
                            now -
                            started
                        ) /
                        duration
                    );

                const t =
                    ease(raw);

                state.camera.centerX =
                    startX +
                    (
                        targetX -
                        startX
                    ) *
                    t;

                state.camera.centerY =
                    startY +
                    (
                        targetY -
                        startY
                    ) *
                    t;

                /*
                  Exponential scale interpolation feels much closer to
                  a real map camera than linear zoom.
                */
                state.camera.scale =
                    startScale *
                    Math.pow(
                        scaleRatio,
                        t
                    );

                state.camera.initialized =
                    true;

                scheduleMapDraw();

                if (raw < 1) {
                    cameraAnimationFrame =
                        requestAnimationFrame(
                            step
                        );
                }
                else {
                    cameraAnimationFrame =
                        null;

                    state.camera.centerX =
                        targetX;

                    state.camera.centerY =
                        targetY;

                    state.camera.scale =
                        targetScale;

                    state.camera.userInteracted =
                        false;

                    scheduleMapDraw();
                }
            };

        cameraAnimationFrame =
            requestAnimationFrame(
                step
            );
    }

    function fitCurrentFloor() {
        const floor = currentFloor();

        if (!floor) {
            return;
        }

        const fitScale = calculateFitScale();

        state.camera.fitScale = fitScale;
        state.camera.minScale =
            fitScale * CAMERA_MIN_FACTOR;
        state.camera.maxScale =
            fitScale * CAMERA_MAX_FACTOR;
        state.camera.scale = fitScale;

        state.camera.centerX =
            (Number(floor.width) || 1) / 2;
        state.camera.centerY =
            (Number(floor.height) || 1) / 2;

        state.camera.initialized = true;
        state.camera.userInteracted = false;

        clampCamera();
        scheduleMapDraw();
    }

    function worldToScreen(x, y) {
        const { width, height } = viewportSize();

        return {
            x:
                width / 2 +
                (x - state.camera.centerX) *
                    state.camera.scale,
            y:
                height / 2 +
                (y - state.camera.centerY) *
                    state.camera.scale
        };
    }

    function screenToWorld(x, y) {
        const { width, height } = viewportSize();

        return {
            x:
                state.camera.centerX +
                (x - width / 2) /
                    state.camera.scale,
            y:
                state.camera.centerY +
                (y - height / 2) /
                    state.camera.scale
        };
    }

    function zoomAroundScreenPoint(
        nextScale,
        clientX,
        clientY
    ) {
        if (!currentFloor()) {
            return;
        }

        cancelCameraAnimation();
        updateCameraLimits();

        const rect =
            ui.mapViewport.getBoundingClientRect();

        const screenX =
            clientX - rect.left;
        const screenY =
            clientY - rect.top;

        const world =
            screenToWorld(
                screenX,
                screenY
            );

        state.camera.scale =
            Math.min(
                state.camera.maxScale,
                Math.max(
                    state.camera.minScale,
                    nextScale
                )
            );

        const { width, height } = viewportSize();

        state.camera.centerX =
            world.x -
            (screenX - width / 2) /
                state.camera.scale;

        state.camera.centerY =
            world.y -
            (screenY - height / 2) /
                state.camera.scale;

        state.camera.userInteracted = true;

        clampCamera();
        scheduleMapDraw();
    }

    function changeMapZoom(multiplier) {
        const rect =
            ui.mapViewport.getBoundingClientRect();

        zoomAroundScreenPoint(
            state.camera.scale * multiplier,
            rect.left + rect.width / 2,
            rect.top + rect.height / 2
        );
    }

    function pointerPair() {
        return [...activeMapPointers.values()]
            .slice(0, 2);
    }

    function pairDistance(a, b) {
        return Math.hypot(
            b.clientX - a.clientX,
            b.clientY - a.clientY
        );
    }

    function pairMidpoint(a, b) {
        return {
            x: (a.clientX + b.clientX) / 2,
            y: (a.clientY + b.clientY) / 2
        };
    }

    function beginPinch() {
        const pair = pointerPair();

        if (pair.length < 2) {
            pinchGesture = null;
            return;
        }

        const midpoint =
            pairMidpoint(
                pair[0],
                pair[1]
            );

        const rect =
            ui.mapViewport.getBoundingClientRect();

        const localX =
            midpoint.x - rect.left;
        const localY =
            midpoint.y - rect.top;

        pinchGesture = {
            distance:
                Math.max(
                    1,
                    pairDistance(
                        pair[0],
                        pair[1]
                    )
                ),
            startScale:
                state.camera.scale,
            anchorWorld:
                screenToWorld(
                    localX,
                    localY
                )
        };

        panGesture = null;
    }

    function beginPan(pointer) {
        panGesture = {
            pointerId:
                pointer.pointerId,
            startClientX:
                pointer.clientX,
            startClientY:
                pointer.clientY,
            startCenterX:
                state.camera.centerX,
            startCenterY:
                state.camera.centerY,
            moved: false
        };
    }

    function canSinglePointerPan(pointer) {
        return (
            state.mapFullscreen ||
            pointer.pointerType === "mouse" ||
            pointer.pointerType === "pen" ||
            !compactLayout.matches
        );
    }

    function onMapPointerDown(event) {
        cancelCameraAnimation();

        activeMapPointers.set(
            event.pointerId,
            {
                pointerId:
                    event.pointerId,
                pointerType:
                    event.pointerType,
                clientX:
                    event.clientX,
                clientY:
                    event.clientY
            }
        );

        if (
            activeMapPointers.size >= 2
        ) {
            event.preventDefault();

            for (
                const pointerId
                of activeMapPointers.keys()
            ) {
                try {
                    ui.mapViewport
                        .setPointerCapture(
                            pointerId
                        );
                }
                catch {
                    // Browser may already own one pointer.
                }
            }

            beginPinch();
            return;
        }

        if (
            canSinglePointerPan(event)
        ) {
            event.preventDefault();

            try {
                ui.mapViewport
                    .setPointerCapture(
                        event.pointerId
                    );
            }
            catch {
                // Capture is optional.
            }

            beginPan(event);
        }
        else {
            /*
              Embedded phone map deliberately leaves a single-finger
              vertical gesture available to the page. A tap can still
              select a parking bay; two fingers own map pan/pinch.
            */
            beginPan(event);
        }
    }

    function onMapPointerMove(event) {
        if (
            !activeMapPointers.has(
                event.pointerId
            )
        ) {
            return;
        }

        activeMapPointers.set(
            event.pointerId,
            {
                pointerId:
                    event.pointerId,
                pointerType:
                    event.pointerType,
                clientX:
                    event.clientX,
                clientY:
                    event.clientY
            }
        );

        if (
            activeMapPointers.size >= 2
        ) {
            event.preventDefault();

            if (!pinchGesture) {
                beginPinch();
            }

            const pair = pointerPair();

            if (
                pair.length < 2 ||
                !pinchGesture
            ) {
                return;
            }

            const distance =
                Math.max(
                    1,
                    pairDistance(
                        pair[0],
                        pair[1]
                    )
                );

            const midpoint =
                pairMidpoint(
                    pair[0],
                    pair[1]
                );

            const nextScale =
                pinchGesture.startScale *
                (
                    distance /
                    pinchGesture.distance
                );

            updateCameraLimits();

            state.camera.scale =
                Math.min(
                    state.camera.maxScale,
                    Math.max(
                        state.camera.minScale,
                        nextScale
                    )
                );

            const rect =
                ui.mapViewport
                    .getBoundingClientRect();

            const localX =
                midpoint.x - rect.left;
            const localY =
                midpoint.y - rect.top;

            const { width, height } =
                viewportSize();

            state.camera.centerX =
                pinchGesture.anchorWorld.x -
                (localX - width / 2) /
                    state.camera.scale;

            state.camera.centerY =
                pinchGesture.anchorWorld.y -
                (localY - height / 2) /
                    state.camera.scale;

            state.camera.userInteracted =
                true;

            suppressMapTapUntil =
                performance.now() + 250;

            clampCamera();
            scheduleMapDraw();
            return;
        }

        if (!panGesture) {
            return;
        }

        const dx =
            event.clientX -
            panGesture.startClientX;

        const dy =
            event.clientY -
            panGesture.startClientY;

        if (
            Math.hypot(dx, dy) > 5
        ) {
            panGesture.moved = true;
        }

        if (
            !canSinglePointerPan(event)
        ) {
            return;
        }

        event.preventDefault();

        state.camera.centerX =
            panGesture.startCenterX -
            dx / state.camera.scale;

        state.camera.centerY =
            panGesture.startCenterY -
            dy / state.camera.scale;

        state.camera.userInteracted =
            true;

        if (panGesture.moved) {
            suppressMapTapUntil =
                performance.now() + 220;
        }

        clampCamera();
        scheduleMapDraw();
    }

    function onMapPointerEnd(event) {
        const pointer =
            activeMapPointers.get(
                event.pointerId
            );

        const wasPinching =
            activeMapPointers.size >= 2;

        activeMapPointers.delete(
            event.pointerId
        );

        try {
            if (
                ui.mapViewport.hasPointerCapture(
                    event.pointerId
                )
            ) {
                ui.mapViewport.releasePointerCapture(
                    event.pointerId
                );
            }
        }
        catch {
            // No capture to release.
        }

        if (wasPinching) {
            pinchGesture = null;

            const remaining =
                [...activeMapPointers.values()][0];

            if (remaining) {
                beginPan(remaining);
            }
            else {
                panGesture = null;
            }

            return;
        }

        const moved =
            Boolean(
                panGesture?.moved
            );

        panGesture = null;

        if (
            event.type !== "pointerup" ||
            moved ||
            performance.now() <
                suppressMapTapUntil
        ) {
            return;
        }

        const rect =
            ui.mapViewport
                .getBoundingClientRect();

        const localX =
            event.clientX -
            rect.left;

        const localY =
            event.clientY -
            rect.top;

        const world =
            screenToWorld(
                localX,
                localY
            );

        const hit =
            findSpotAtWorld(
                world.x,
                world.y
            );

        if (hit) {
            selectMapSpot(
                hit.id
            );
        }
        else {
            clearSelectedMapSpot();
        }

        if (
            pointer?.pointerType ===
            "touch"
        ) {
            const now =
                performance.now();

            if (
                lastTouchTap &&
                now -
                    lastTouchTap.time <
                    320 &&
                Math.hypot(
                    event.clientX -
                        lastTouchTap.x,
                    event.clientY -
                        lastTouchTap.y
                ) < 28
            ) {
                zoomAroundScreenPoint(
                    state.camera.scale *
                        CAMERA_ZOOM_FACTOR *
                        CAMERA_ZOOM_FACTOR,
                    event.clientX,
                    event.clientY
                );

                lastTouchTap = null;
            }
            else {
                lastTouchTap = {
                    time: now,
                    x: event.clientX,
                    y: event.clientY
                };
            }
        }
    }

    function onMapWheel(event) {
        if (
            !state.layoutLoaded
        ) {
            return;
        }

        event.preventDefault();

        const multiplier =
            event.deltaY < 0
                ? CAMERA_ZOOM_FACTOR
                : 1 / CAMERA_ZOOM_FACTOR;

        zoomAroundScreenPoint(
            state.camera.scale * multiplier,
            event.clientX,
            event.clientY
        );
    }

    function updateFullscreenViewport() {
        if (!state.mapFullscreen) {
            return;
        }

        const viewport =
            window.visualViewport;

        const left =
            viewport?.offsetLeft ?? 0;
        const top =
            viewport?.offsetTop ?? 0;
        const width =
            viewport?.width ??
            window.innerWidth;
        const height =
            viewport?.height ??
            window.innerHeight;

        ui.garage.style.setProperty(
            "--map-visual-left",
            `${left}px`
        );

        ui.garage.style.setProperty(
            "--map-visual-top",
            `${top}px`
        );

        ui.garage.style.setProperty(
            "--map-visual-width",
            `${width}px`
        );

        ui.garage.style.setProperty(
            "--map-visual-height",
            `${height}px`
        );
    }

    function renderFullscreenState() {
        document.body.classList.toggle(
            "map-fullscreen-active",
            state.mapFullscreen
        );

        ui.garage.dataset.mapMode =
            state.mapFullscreen
                ? "fullscreen"
                : "embedded";

        ui.mapFullscreenToggle.setAttribute(
            "aria-pressed",
            String(state.mapFullscreen)
        );

        ui.mapFullscreenToggle.setAttribute(
            "aria-label",
            state.mapFullscreen
                ? "Close full map"
                : "Open full map"
        );

        if (state.mapFullscreen) {
            updateFullscreenViewport();
        }
        else {
            for (
                const property of [
                    "--map-visual-left",
                    "--map-visual-top",
                    "--map-visual-width",
                    "--map-visual-height"
                ]
            ) {
                ui.garage.style.removeProperty(
                    property
                );
            }
        }
    }

    function openMapFullscreen() {
        cancelCameraAnimation();

        const oldScale =
            state.camera.scale;

        const oldCenterX =
            state.camera.centerX;

        const oldCenterY =
            state.camera.centerY;

        state.mapFullscreen =
            true;

        renderFullscreenState();

        activeMapPointers.clear();
        panGesture = null;
        pinchGesture = null;

        requestAnimationFrame(
            () => {
                updateFullscreenViewport();

                requestAnimationFrame(
                    () => {
                        /*
                          Keep the SAME map scale when entering Full Map.
                          The larger viewport simply reveals more world
                          around the current camera, like a proper map.
                        */
                        updateCameraLimits();

                        state.camera.scale =
                            Math.min(
                                state.camera.maxScale,
                                Math.max(
                                    state.camera.minScale,
                                    oldScale
                                )
                            );

                        state.camera.centerX =
                            Number.isFinite(
                                oldCenterX
                            )
                                ? oldCenterX
                                : (
                                    Number(
                                        currentFloor()?.width
                                    ) || 1
                                ) / 2;

                        state.camera.centerY =
                            Number.isFinite(
                                oldCenterY
                            )
                                ? oldCenterY
                                : (
                                    Number(
                                        currentFloor()?.height
                                    ) || 1
                                ) / 2;

                        state.camera.initialized =
                            true;

                        state.camera.userInteracted =
                            false;

                        scheduleMapDraw();
                    }
                );
            }
        );
    }

    function closeMapFullscreen() {
        if (!state.mapFullscreen) {
            return;
        }

        state.mapFullscreen = false;
        renderFullscreenState();

        activeMapPointers.clear();
        panGesture = null;
        pinchGesture = null;

        requestAnimationFrame(
            () => {
                /*
                  Reset to a valid embedded-camera fit. This is deliberate:
                  browser/page pinch zoom is independent from map zoom, so
                  opening/closing Full Map can never leave the parking map
                  trapped at the previous map-camera scale.
                */
                fitCurrentFloor();
            }
        );
    }

    function toggleMapFullscreen() {
        if (state.mapFullscreen) {
            closeMapFullscreen();
        }
        else {
            openMapFullscreen();
        }
    }

    // ============================================================
    //                      BACKEND PAYLOADS
    // ============================================================

    function reservePayload(spotId) {
        return {
            spot_id: spotId
        };
    }

    function movePayload(spotId) {
        // This matches your FastAPI MoveRequest model.
        return {
            new_spot_id: spotId
        };
    }

    function parkedElsewherePayload(spotId) {
        return {
            spot_id: spotId
        };
    }

    function normalizeReservation(data, fallbackId) {
        if (
            !data ||
            typeof data !== "object"
        ) {
            throw new Error(
                "The server returned an invalid reservation."
            );
        }

        const id =
            data.reservation_id ?? fallbackId;

        const status =
            String(data.status ?? "")
                .toUpperCase();

        if (
            !id ||
            !VALID_RESERVATION_STATES.has(status)
        ) {
            throw new Error(
                "The reservation response is invalid."
            );
        }

        return {
            id: String(id),
            status,
            spotId:
                data.spot_id == null
                    ? null
                    : String(data.spot_id),
            parkedSpotId:
                data.parked_spot_id == null
                    ? null
                    : String(data.parked_spot_id)
        };
    }

    // ============================================================
    //                      LOCAL STORAGE
    // ============================================================

    function readStoredId() {
        try {
            return (
                localStorage.getItem(STORAGE_KEY) ||
                null
            );
        }
        catch {
            return null;
        }
    }

    function persistId(id) {
        state.reservationId = id;

        try {
            if (id) {
                localStorage.setItem(
                    STORAGE_KEY,
                    id
                );
            }
            else {
                localStorage.removeItem(
                    STORAGE_KEY
                );
            }
        }
        catch {
            showNotice(
                "Browser storage is unavailable.",
                "error"
            );
        }
    }

    // ============================================================
    //                      HELPERS
    // ============================================================

    function spotLabel(id) {
        if (!id) {
            return "Assigned space";
        }

        const match =
            /^spot[-_]?(\d+)$/i.exec(id);

        return match
            ? `P${match[1].padStart(2, "0")}`
            : id;
    }

    function indexLayout(layout) {
        layoutIndex.floors.clear();
        layoutIndex.spots.clear();
        layoutIndex.spotsByFloor.clear();
        layoutIndex.spotsByFloorZone.clear();
        layoutIndex.spatial.clear();
        layoutIndex.nodes.clear();
        layoutIndex.adjacency.clear();

        for (const floor of layout?.floors || []) {
            layoutIndex.floors.set(
                String(floor.id),
                floor
            );
        }

        for (const spot of layout?.spots || []) {
            const id =
                String(spot.id);

            const floorId =
                String(spot.floor);

            const zone =
                String(
                    spot.zone || ""
                ).toUpperCase();

            layoutIndex.spots.set(
                id,
                spot
            );

            if (
                !layoutIndex.spotsByFloor
                    .has(floorId)
            ) {
                layoutIndex.spotsByFloor
                    .set(
                        floorId,
                        []
                    );
            }

            layoutIndex.spotsByFloor
                .get(floorId)
                .push(spot);

            const zoneKey =
                `${floorId}::${zone}`;

            if (
                !layoutIndex
                    .spotsByFloorZone
                    .has(zoneKey)
            ) {
                layoutIndex
                    .spotsByFloorZone
                    .set(
                        zoneKey,
                        []
                    );
            }

            layoutIndex
                .spotsByFloorZone
                .get(zoneKey)
                .push(spot);

            /*
              Spatial hash used for fast hit-testing in garages with
              hundreds or thousands of spaces.
            */
            const radius =
                Math.hypot(
                    Number(
                        spot.width
                    ) || 2.5,
                    Number(
                        spot.length
                    ) || 5
                ) / 2;

            const minCellX =
                Math.floor(
                    (
                        Number(spot.x) -
                        radius
                    ) /
                    SPATIAL_CELL_METERS
                );

            const maxCellX =
                Math.floor(
                    (
                        Number(spot.x) +
                        radius
                    ) /
                    SPATIAL_CELL_METERS
                );

            const minCellY =
                Math.floor(
                    (
                        Number(spot.y) -
                        radius
                    ) /
                    SPATIAL_CELL_METERS
                );

            const maxCellY =
                Math.floor(
                    (
                        Number(spot.y) +
                        radius
                    ) /
                    SPATIAL_CELL_METERS
                );

            for (
                let cellX = minCellX;
                cellX <= maxCellX;
                cellX++
            ) {
                for (
                    let cellY = minCellY;
                    cellY <= maxCellY;
                    cellY++
                ) {
                    const key =
                        `${floorId}:${cellX}:${cellY}`;

                    if (
                        !layoutIndex.spatial
                            .has(key)
                    ) {
                        layoutIndex.spatial
                            .set(
                                key,
                                []
                            );
                    }

                    layoutIndex.spatial
                        .get(key)
                        .push(spot);
                }
            }
        }

        for (
            const node
            of layout?.navigation?.nodes || []
        ) {
            const id = String(node.id);

            layoutIndex.nodes.set(
                id,
                node
            );

            layoutIndex.adjacency.set(
                id,
                []
            );
        }

        for (
            const edge
            of layout?.navigation?.edges || []
        ) {
            const from =
                String(edge.from);

            const to =
                String(edge.to);

            const a =
                layoutIndex.nodes.get(from);

            const b =
                layoutIndex.nodes.get(to);

            if (!a || !b) {
                continue;
            }

            const weight =
                Number(edge.weight) ||
                Math.hypot(
                    Number(b.x) - Number(a.x),
                    Number(b.y) - Number(a.y)
                );

            const direction =
                String(
                    edge.direction || "both"
                ).toLowerCase();

            if (
                direction === "both" ||
                direction === "forward" ||
                direction === "one-way"
            ) {
                layoutIndex.adjacency
                    .get(from)
                    ?.push({
                        to,
                        weight
                    });
            }

            if (
                direction === "both" ||
                direction === "backward"
            ) {
                layoutIndex.adjacency
                    .get(to)
                    ?.push({
                        to: from,
                        weight
                    });
            }
        }
    }

    function getLayoutSpot(spotId) {
        return (
            layoutIndex.spots.get(
                String(spotId)
            ) ||
            null
        );
    }

    function spotFloorId(spotOrId) {
        const layoutSpot =
            typeof spotOrId === "string"
                ? getLayoutSpot(spotOrId)
                : spotOrId?.id
                    ? getLayoutSpot(
                        spotOrId.id
                    )
                    : null;

        const raw =
            layoutSpot?.floor ??
            spotOrId?.floor ??
            state.layout?.floors?.[0]?.id ??
            "ground";

        return String(raw);
    }

    function spotZone(spotOrId) {
        const layoutSpot =
            typeof spotOrId === "string"
                ? getLayoutSpot(spotOrId)
                : spotOrId?.id
                    ? getLayoutSpot(
                        spotOrId.id
                    )
                    : null;

        return String(
            layoutSpot?.zone ??
            spotOrId?.zone ??
            "A"
        ).toUpperCase();
    }

    function floorLabel(floorId) {
        const floor =
            layoutIndex.floors.get(
                String(floorId)
            );

        if (floor?.name) {
            return String(floor.name);
        }

        const value =
            String(floorId);

        if (
            value === "0" ||
            value.toLowerCase() ===
                "ground"
        ) {
            return "Ground";
        }

        return value
            .replace(/[-_]/g, " ")
            .replace(
                /\b\w/g,
                (character) =>
                    character.toUpperCase()
            );
    }

    function floorShortLabel(floorId) {
        const floor =
            layoutIndex.floors.get(
                String(floorId)
            );

        if (
            Number(floor?.level) === 0 ||
            String(floorId)
                .toLowerCase() ===
                "ground"
        ) {
            return "G";
        }

        if (
            Number.isFinite(
                Number(floor?.level)
            )
        ) {
            return String(
                floor.level
            );
        }

        return String(floorId);
    }

    function layoutSpotsForSelection() {
        if (!state.layoutLoaded) {
            return [];
        }

        const floorId =
            String(
                state.selectedFloor
            );

        if (
            state.selectedZone ===
            "ALL"
        ) {
            return (
                layoutIndex.spotsByFloor
                    .get(floorId) ||
                []
            );
        }

        return (
            layoutIndex
                .spotsByFloorZone
                .get(
                    `${floorId}::${state.selectedZone}`
                ) ||
            []
        );
    }

    function selectSpotLocation(spotId) {
        const spot =
            getLayoutSpot(spotId);

        if (!spot) {
            return;
        }

        state.selectedFloor =
            String(spot.floor);

        state.selectedZone =
            String(spot.zone)
                .toUpperCase();

        state.camera.initialized =
            false;
    }

    function prettyStatus(status) {
        const labels = {
            ACTIVE: "Active",
            AWAITING_CONFIRMATION:
                "Confirm arrival",
            COMPLETED: "Parked",
            EXPIRED: "Expired",
            CANCELLED: "Cancelled"
        };

        return labels[status] || status;
    }

    function currentSpotId() {
        if (!state.reservationId) {
            return null;
        }

        if (
            state.reservation?.status ===
                "COMPLETED" &&
            state.reservation?.parkedSpotId
        ) {
            return state.reservation.parkedSpotId;
        }

        if (state.reservation?.spotId) {
            return state.reservation.spotId;
        }

        return (
            Object.keys(state.spots)
                .find(
                    (id) =>
                        String(
                            state.spots[id]
                                .reservation_id ?? ""
                        ) ===
                        state.reservationId
                ) ||
            null
        );
    }

    function arrivalKey() {
        return (
            `${state.reservationId}:` +
            `${currentSpotId() || ""}`
        );
    }

    function isMyCarSpot(id, spot) {
        return (
            state.reservation?.status ===
                "COMPLETED" &&
            id === currentSpotId() &&
            spot?.physical_state ===
                "OCCUPIED"
        );
    }

    function canChoose() {
        return (
            state.online &&
            !state.busy &&
            (
                !state.reservationId ||
                (
                    state.moving &&
                    state.reservation
                        ?.status ===
                        "AWAITING_CONFIRMATION"
                )
            )
        );
    }

    // ============================================================
    //                      HTTP
    // ============================================================

    async function api(
        path,
        {
            method = "GET",
            body
        } = {}
    ) {
        const controller =
            new AbortController();

        const timeout =
            setTimeout(
                () => controller.abort(),
                10000
            );

        try {
            const response =
                await fetch(
                    path,
                    {
                        method,
                        cache: "no-store",

                        headers:
                            body === undefined
                                ? {}
                                : {
                                    "Content-Type":
                                        "application/json"
                                },

                        body:
                            body === undefined
                                ? undefined
                                : JSON.stringify(body),

                        signal:
                            controller.signal
                    }
                );

            const raw =
                await response.text();

            let data = null;

            if (raw) {
                try {
                    data =
                        JSON.parse(raw);
                }
                catch {
                    if (response.ok) {
                        throw new Error(
                            "The server returned an unexpected response."
                        );
                    }
                }
            }

            if (!response.ok) {
                const detail =
                    typeof data?.detail ===
                        "string"
                        ? data.detail
                        : null;

                const error =
                    new Error(
                        detail ||
                        `Request failed (${response.status}).`
                    );

                error.status =
                    response.status;

                throw error;
            }

            return data;
        }
        catch (error) {
            if (
                error.name ===
                "AbortError"
            ) {
                throw new Error(
                    "The server took too long to respond."
                );
            }

            if (
                error instanceof
                TypeError
            ) {
                throw new Error(
                    "Unable to reach the garage."
                );
            }

            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
    }

    // ============================================================
    //                      NOTICES
    // ============================================================

    function showNotice(
        message,
        kind = "success"
    ) {
        ui.notice.textContent =
            message;

        ui.notice.dataset.kind =
            kind;

        ui.notice.hidden =
            false;
    }

    function clearNotice() {
        ui.notice.hidden =
            true;

        ui.dialogError.hidden =
            true;
    }

    // ============================================================
    //                      LOCATION
    // ============================================================

    function startLocation() {
        if (
            !("geolocation" in navigator)
        ) {
            state.location.error =
                "Location is not supported by this browser.";

            renderLocation();
            return;
        }

        if (
            state.location.watchId !==
            null
        ) {
            return;
        }

        ui.locationButton.disabled =
            true;

        state.location.error = null;

        state.location.watchId =
            navigator.geolocation
                .watchPosition(
                    (position) => {
                        state.location.enabled =
                            true;

                        state.location.lat =
                            position.coords.latitude;

                        state.location.lon =
                            position.coords.longitude;

                        state.location.accuracy =
                            position.coords.accuracy;

                        state.location.error =
                            null;

                        ui.locationButton.disabled =
                            false;

                        renderLocation();
                        renderNavigation();
                    },

                    (error) => {
                        state.location.enabled =
                            false;

                        state.location.error =
                            error.message ||
                            "Unable to access location.";

                        ui.locationButton.disabled =
                            false;

                        renderLocation();
                    },

                    {
                        enableHighAccuracy: true,
                        maximumAge: 3000,
                        timeout: 10000
                    }
                );
    }

    function renderLocation() {
        if (
            state.location.enabled
        ) {
            ui.locationIndicator
                .dataset.state =
                "live";

            ui.locationIndicator
                .querySelector("span")
                .textContent =
                "Live";

            const accuracy =
                Math.round(
                    state.location.accuracy ||
                    0
                );

            ui.locationText.textContent =
                `Phone location active · approximately ±${accuracy} m accuracy.`;

            ui.locationButton.textContent =
                "Location active";

            ui.locationButton.disabled =
                true;

            return;
        }

        if (
            state.location.error
        ) {
            ui.locationIndicator
                .dataset.state =
                "error";

            ui.locationIndicator
                .querySelector("span")
                .textContent =
                "Unavailable";

            ui.locationText.textContent =
                state.location.error;

            ui.locationButton.textContent =
                "Try location again";

            return;
        }

        ui.locationIndicator
            .dataset.state =
            "off";

        ui.locationIndicator
            .querySelector("span")
            .textContent =
            "Off";

        ui.locationText.textContent =
            "Turn on location to make navigation easier.";

        ui.locationButton.textContent =
            "Enable location";
    }

    // ============================================================
    //                      NAVIGATION
    // ============================================================

    function heuristicNodeDistance(
        nodeId,
        targetNodeId
    ) {
        const a =
            layoutIndex.nodes.get(nodeId);

        const b =
            layoutIndex.nodes.get(
                targetNodeId
            );

        if (!a || !b) {
            return 0;
        }

        return Math.hypot(
            Number(a.x) - Number(b.x),
            Number(a.y) - Number(b.y)
        );
    }

    function aStarRoute(
        startNodeId,
        targetNodeId
    ) {
        if (
            !layoutIndex.nodes.has(startNodeId) ||
            !layoutIndex.nodes.has(targetNodeId)
        ) {
            return null;
        }

        const open =
            new Set([startNodeId]);

        const cameFrom =
            new Map();

        const gScore =
            new Map([
                [startNodeId, 0]
            ]);

        const fScore =
            new Map([
                [
                    startNodeId,
                    heuristicNodeDistance(
                        startNodeId,
                        targetNodeId
                    )
                ]
            ]);

        while (open.size) {
            let current = null;
            let best = Infinity;

            for (const nodeId of open) {
                const score =
                    fScore.get(nodeId) ??
                    Infinity;

                if (score < best) {
                    best = score;
                    current = nodeId;
                }
            }

            if (current === null) {
                break;
            }

            if (current === targetNodeId) {
                const ids = [current];

                while (
                    cameFrom.has(current)
                ) {
                    current =
                        cameFrom.get(current);

                    ids.push(current);
                }

                ids.reverse();

                return ids;
            }

            open.delete(current);

            for (
                const edge
                of layoutIndex.adjacency
                    .get(current) || []
            ) {
                const tentative =
                    (
                        gScore.get(current) ??
                        Infinity
                    ) +
                    edge.weight;

                if (
                    tentative <
                    (
                        gScore.get(edge.to) ??
                        Infinity
                    )
                ) {
                    cameFrom.set(
                        edge.to,
                        current
                    );

                    gScore.set(
                        edge.to,
                        tentative
                    );

                    fScore.set(
                        edge.to,
                        tentative +
                        heuristicNodeDistance(
                            edge.to,
                            targetNodeId
                        )
                    );

                    open.add(edge.to);
                }
            }
        }

        return null;
    }

    function entranceForFloor(floorId) {
        return (
            (state.layout?.entrances || [])
                .find(
                    (entrance) =>
                        String(
                            entrance.floor
                        ) ===
                        String(floorId)
                ) ||
            null
        );
    }

    function calculateRouteToSpot(
        spotId
    ) {
        const spot =
            getLayoutSpot(spotId);

        if (!spot) {
            return null;
        }

        const entrance =
            entranceForFloor(
                spot.floor
            );

        const startNode =
            entrance?.navigation_node;

        const targetNode =
            spot.road_connection;

        if (
            !startNode ||
            !targetNode
        ) {
            return null;
        }

        const ids =
            aStarRoute(
                String(startNode),
                String(targetNode)
            );

        if (!ids?.length) {
            return null;
        }

        const points =
            ids
                .map(
                    (id) =>
                        layoutIndex.nodes
                            .get(id)
                )
                .filter(Boolean)
                .map(
                    (node) => ({
                        x: Number(node.x),
                        y: Number(node.y),
                        floor:
                            String(node.floor)
                    })
                );

        points.push({
            x: Number(spot.x),
            y: Number(spot.y),
            floor: String(spot.floor)
        });

        let distance = 0;

        for (
            let index = 1;
            index < points.length;
            index++
        ) {
            distance +=
                Math.hypot(
                    points[index].x -
                        points[index - 1].x,
                    points[index].y -
                        points[index - 1].y
                );
        }

        return {
            startNode:
                String(startNode),
            targetNode:
                String(targetNode),
            nodeIds: ids,
            points,
            distance
        };
    }

    function buildGarageDirections(spotId) {
        const spot =
            getLayoutSpot(spotId);

        if (!spot) {
            return (
                `Follow the parking signs to ` +
                `${spotLabel(spotId)}.`
            );
        }

        const route =
            calculateRouteToSpot(
                spotId
            );

        if (!route) {
            return (
                `Go to ${floorLabel(spot.floor)}, ` +
                `Zone ${spotZone(spot)} and follow ` +
                `the driving lane to ${spotLabel(spotId)}.`
            );
        }

        return (
            `Enter on ${floorLabel(spot.floor)} and follow ` +
            `the highlighted driving route for about ` +
            `${Math.max(1, Math.round(route.distance))} m. ` +
            `${spotLabel(spotId)} is in Zone ${spotZone(spot)}.`
        );
    }

    function routeBounds(route = state.route) {
        if (!route?.points?.length) {
            return null;
        }

        const floorId =
            String(
                state.selectedFloor
            );

        const points =
            route.points.filter(
                (point) =>
                    String(point.floor) ===
                    floorId
            );

        if (!points.length) {
            return null;
        }

        return {
            minX:
                Math.min(
                    ...points.map(
                        (point) => point.x
                    )
                ),
            minY:
                Math.min(
                    ...points.map(
                        (point) => point.y
                    )
                ),
            maxX:
                Math.max(
                    ...points.map(
                        (point) => point.x
                    )
                ),
            maxY:
                Math.max(
                    ...points.map(
                        (point) => point.y
                    )
                )
        };
    }

    function focusWorldBounds(
        bounds,
        padding = 50
    ) {
        if (!bounds) {
            fitCurrentFloor();
            return;
        }

        const { width, height } =
            viewportSize();

        const worldWidth =
            Math.max(
                2,
                bounds.maxX -
                    bounds.minX
            );

        const worldHeight =
            Math.max(
                2,
                bounds.maxY -
                    bounds.minY
            );

        updateCameraLimits();

        const computedScale =
            Math.min(
                Math.max(
                    1,
                    width - padding * 2
                ) / worldWidth,
                Math.max(
                    1,
                    height - padding * 2
                ) / worldHeight
            );

        /*
          Navigation-map camera: route focus should be useful, not jump
          into an extreme close-up just because the route is short.
        */
        const contextualMax =
            state.camera.fitScale *
            (
                state.mapFullscreen
                    ? 1.8
                    : 2.15
            );

        const targetScale =
            Math.min(
                state.camera.maxScale,
                contextualMax,
                Math.max(
                    state.camera.fitScale *
                        0.9,
                    computedScale
                )
            );

        animateCameraTo(
            {
                centerX:
                    (
                        bounds.minX +
                        bounds.maxX
                    ) / 2,

                centerY:
                    (
                        bounds.minY +
                        bounds.maxY
                    ) / 2,

                scale:
                    targetScale
            },
            state.mapFullscreen
                ? 500
                : 420
        );
    }

    function focusRoute() {
        if (!state.route) {
            fitCurrentFloor();
            return;
        }

        const bounds =
            routeBounds(
                state.route
            );

        if (!bounds) {
            fitCurrentFloor();
            return;
        }

        const extra =
            state.mapFullscreen
                ? 4
                : 3;

        focusWorldBounds({
            minX:
                bounds.minX - extra,
            minY:
                bounds.minY - extra,
            maxX:
                bounds.maxX + extra,
            maxY:
                bounds.maxY + extra
        }, state.mapFullscreen ? 64 : 50);
    }

    function centerSpotOnMap(spotId) {
        const spot =
            getLayoutSpot(spotId);

        if (!spot) {
            return;
        }

        updateCameraLimits();

        animateCameraTo(
            {
                centerX:
                    Number(spot.x),

                centerY:
                    Number(spot.y),

                scale:
                    Math.min(
                        state.camera.maxScale,
                        Math.max(
                            state.camera.scale,
                            state.camera.fitScale *
                                1.5
                        )
                    )
            },
            380
        );
    }

    function selectMapSpot(spotId) {
        const spot =
            getLayoutSpot(spotId);

        if (!spot) {
            state.selectedMapSpot = null;
            renderMapPlaceCard();
            scheduleMapDraw();
            return;
        }

        state.selectedMapSpot =
            String(spotId);

        renderMapPlaceCard();
        scheduleMapDraw();
    }

    function clearSelectedMapSpot() {
        if (!state.selectedMapSpot) {
            return;
        }

        state.selectedMapSpot = null;
        renderMapPlaceCard();
        scheduleMapDraw();
    }

    function startNavigationToSpot(
        spotId,
        mode = "map"
    ) {
        const target =
            String(spotId || "");

        const layoutSpot =
            getLayoutSpot(target);

        if (!target || !layoutSpot) {
            return;
        }

        state.navigationTarget =
            target;

        state.navigationMode =
            mode;

        /*
          Navigation owns the top route card. The selected-place bottom
          sheet is closed as soon as navigation starts so it does not
          cover the map.
        */
        state.selectedMapSpot =
            null;

        /*
          Navigation changes floor when necessary, but it deliberately
          keeps ALL zones visible. A route should never make half of the
          garage disappear.
        */
        state.selectedFloor =
            String(layoutSpot.floor);

        state.selectedZone =
            "ALL";

        state.route =
            calculateRouteToSpot(
                target
            );

        renderFilters();
        renderNavigation();
        renderMapPlaceCard();
        renderMap();

        requestAnimationFrame(
            () => {
                if (state.route) {
                    focusRoute();
                }
                else {
                    centerSpotOnMap(
                        target
                    );
                }
            }
        );
    }

    function startNavigation(mode) {
        const target =
            currentSpotId();

        if (!target) {
            return;
        }

        startNavigationToSpot(
            target,
            mode
        );
    }

    function stopNavigation() {
        state.navigationTarget =
            null;

        state.navigationMode =
            null;

        state.route =
            null;

        renderNavigation();
        renderMapPlaceCard();
        renderMap();
    }

    function renderNavigation() {
        const target =
            state.navigationTarget;

        ui.garage.classList.toggle(
            "is-navigating",
            Boolean(target)
        );

        if (ui.mapDirectNavigate) {
            ui.mapDirectNavigate.hidden =
                Boolean(target) ||
                !state.selectedMapSpot;
        }

        /*
          The old external navigation banner is no longer the primary
          navigation UI. The route card lives inside the map itself.
        */
        ui.navigationPanel.hidden =
            true;

        if (!target) {
            ui.mapRecenter.hidden =
                true;

            if (ui.mapRouteCard) {
                ui.mapRouteCard.hidden =
                    true;
            }

            state.route =
                null;

            return;
        }

        ui.mapRecenter.hidden =
            false;

        ui.mapRecenter.innerHTML =
            '<span aria-hidden="true">◎</span> Recenter';

        state.route =
            calculateRouteToSpot(
                target
            );

        const carMode =
            state.navigationMode ===
            "car";

        const title =
            carMode
                ? `Find ${spotLabel(target)}`
                : `To ${spotLabel(target)}`;

        const instruction =
            buildGarageDirections(
                target
            );

        /*
          Keep legacy text populated for accessibility / future desktop
          use even though the old banner is visually hidden.
        */
        ui.navigationTitle.textContent =
            carMode
                ? `Find your car · ${spotLabel(target)}`
                : `Navigate to ${spotLabel(target)}`;

        ui.navigationInstruction
            .textContent =
            instruction;

        if (
            state.location.enabled
        ) {
            const accuracy =
                Math.round(
                    state.location.accuracy ||
                    0
                );

            ui.navigationLocation
                .textContent =
                `Phone location active (±${accuracy} m). Indoor routing follows the garage road graph.`;
        }
        else {
            ui.navigationLocation
                .textContent =
                "Route starts at the garage entrance and follows the road graph from the layout file.";
        }

        if (ui.mapRouteCard) {
            ui.mapRouteCard.hidden =
                false;

            ui.mapRouteTitle.textContent =
                title;

            ui.mapRouteInstruction
                .textContent =
                instruction ||
                "Follow the highlighted route.";
        }
    }

    // ============================================================
    //                      MAP PLACE CARD
    // ============================================================

    function renderMapPlaceCard() {
        if (!ui.mapPlaceCard) {
            return;
        }

        const spotId =
            state.selectedMapSpot;

        const layoutSpot =
            spotId
                ? getLayoutSpot(spotId)
                : null;

        if (!spotId || !layoutSpot) {
            ui.mapPlaceCard.hidden =
                true;

            if (ui.mapDirectNavigate) {
                ui.mapDirectNavigate.hidden =
                    true;
            }

            return;
        }

        const live =
            state.spots[spotId];

        const status =
            statusForSpot(
                spotId
            );

        const isOwn =
            spotId ===
            currentSpotId();

        const isCar =
            isMyCarSpot(
                spotId,
                live
            );

        ui.mapPlaceCard.hidden =
            false;

        ui.mapPlaceBadge.textContent =
            spotLabel(spotId);

        ui.mapPlaceBadge.dataset.status =
            isCar
                ? "YOUR_CAR"
                : isOwn
                    ? "YOUR_SPACE"
                    : status;

        /*
          Give the user's reservation a warm visual identity in the
          map-native place card too.
        */
        ui.mapPlaceBadge.style.background =
            isCar
                ? "#eee8ff"
                : isOwn
                    ? "#fff0ad"
                    : "";

        ui.mapPlaceBadge.style.color =
            isCar
                ? "#6b54ad"
                : isOwn
                    ? "#7a5e10"
                    : "";

        ui.mapPlaceStatus.textContent =
            isCar
                ? "YOUR CAR"
                : isOwn
                    ? "YOUR SPACE"
                    : status === "FREE"
                        ? "AVAILABLE"
                        : status;

        ui.mapPlaceTitle.textContent =
            `Parking space ${spotLabel(spotId)}`;

        ui.mapPlaceMeta.textContent =
            `${floorLabel(layoutSpot.floor)} · Zone ${String(layoutSpot.zone || "—").toUpperCase()}`;

        ui.mapPlaceNavigate.disabled =
            !state.layoutLoaded;

        ui.mapPlaceNavigate.innerHTML =
            isCar
                ? '<span aria-hidden="true">↗</span> Find car'
                : '<span aria-hidden="true">↗</span> Navigate';

        /*
          Dedicated in-map Navigate CTA.
          This is separate from the bottom place sheet so there is
          always an obvious navigation action directly on the map.
        */
        if (ui.mapDirectNavigate) {
            ui.mapDirectNavigate.hidden =
                Boolean(
                    state.navigationTarget
                );

            ui.mapDirectNavigateLabel.textContent =
                isCar
                    ? `Find ${spotLabel(spotId)}`
                    : `Navigate to ${spotLabel(spotId)}`;
        }

        if (state.parkedElsewhereMode) {
            const claimable =
                live?.physical_state ===
                    "OCCUPIED" &&
                spotId !==
                    state.reservation?.spotId;

            ui.mapPlaceReserve.disabled =
                !claimable;

            ui.mapPlaceReserve.textContent =
                claimable
                    ? "This is where I parked"
                    : spotId ===
                        state.reservation?.spotId
                        ? "Not your car"
                        : "Select an occupied spot";

            return;
        }

        const reservable =
            status === "FREE" &&
            canChoose();

        ui.mapPlaceReserve.disabled =
            !reservable;

        // When the user chose "Reserve another spot", the existing
        // reservation is intentionally being moved. A free selected bay
        // must therefore offer a real Reserve action instead of showing
        // the generic "Reservation active" label.
        if (state.moving) {
            if (status === "FREE") {
                ui.mapPlaceReserve.textContent =
                    "Reserve";
            }
            else if (status === "OCCUPIED") {
                ui.mapPlaceReserve.textContent =
                    "Occupied";
            }
            else if (status === "RESERVED") {
                ui.mapPlaceReserve.textContent =
                    "Reserved";
            }
            else {
                ui.mapPlaceReserve.textContent =
                    "Unavailable";
            }

            return;
        }

        if (isOwn) {
            ui.mapPlaceReserve.textContent =
                "Your space";
        }
        else if (status === "OCCUPIED") {
            ui.mapPlaceReserve.textContent =
                "Occupied";
        }
        else if (status === "RESERVED") {
            ui.mapPlaceReserve.textContent =
                "Reserved";
        }
        else if (status === "UNKNOWN") {
            ui.mapPlaceReserve.textContent =
                "Unavailable";
        }
        else if (state.reservationId) {
            ui.mapPlaceReserve.textContent =
                "Reservation active";
        }
        else {
            ui.mapPlaceReserve.textContent =
                "Reserve";
        }
    }

    // ============================================================
    //                      FLOOR / ZONE FILTERS
    // ============================================================

    function renderFilters() {
        const floors =
            state.layout?.floors || [];

        if (
            state.selectedMapSpot
        ) {
            const selected =
                getLayoutSpot(
                    state.selectedMapSpot
                );

            const selectedVisible =
                selected &&
                (
                    !state.selectedFloor ||
                    String(selected.floor) ===
                        String(state.selectedFloor)
                ) &&
                (
                    state.selectedZone === "ALL" ||
                    String(selected.zone || "")
                        .toUpperCase() ===
                        state.selectedZone
                );

            if (!selectedVisible) {
                state.selectedMapSpot =
                    null;
            }
        }

        if (!floors.length) {
            ui.floorTabs.replaceChildren();
            ui.zoneTabs.replaceChildren();
            return;
        }

        const validFloorIds =
            floors.map(
                (floor) =>
                    String(floor.id)
            );

        if (
            !state.selectedFloor ||
            !validFloorIds.includes(
                String(
                    state.selectedFloor
                )
            )
        ) {
            state.selectedFloor =
                String(
                    floors[0].id
                );

            state.selectedZone =
                "ALL";

            state.camera.initialized =
                false;
        }

        const floorButtons =
            document.createDocumentFragment();

        for (const floor of floors) {
            const floorId =
                String(floor.id);

            const layoutSpots =
                (state.layout.spots || [])
                    .filter(
                        (spot) =>
                            String(
                                spot.floor
                            ) ===
                            floorId
                    );

            const freeCount =
                layoutSpots.filter(
                    (spot) =>
                        state.spots[
                            spot.id
                        ]?.status ===
                        "FREE"
                ).length;

            const button =
                document.createElement(
                    "button"
                );

            button.type =
                "button";

            button.className =
                "selector-tab";

            button.setAttribute(
                "aria-pressed",
                String(
                    String(
                        state.selectedFloor
                    ) === floorId
                )
            );

            button.innerHTML =
                `${floorLabel(floorId)}` +
                `<span class="floor-badge">${freeCount}</span>`;

            button.addEventListener(
                "click",
                () => {
                    state.selectedFloor =
                        floorId;

                    state.selectedZone =
                        "ALL";

                    state.navigationTarget =
                        null;

                    state.navigationMode =
                        null;

                    state.route =
                        null;

                    state.camera.initialized =
                        false;

                    render();

                    requestAnimationFrame(
                        fitCurrentFloor
                    );
                }
            );

            floorButtons.append(
                button
            );
        }

        ui.floorTabs.replaceChildren(
            floorButtons
        );

        const floor =
            layoutIndex.floors.get(
                String(
                    state.selectedFloor
                )
            );

        const zonesFromFloor =
            (floor?.zones || [])
                .map(
                    (zone) =>
                        String(
                            zone.id ??
                            zone.name ??
                            ""
                        ).toUpperCase()
                )
                .filter(Boolean);

        const zonesFromSpots =
            (state.layout.spots || [])
                .filter(
                    (spot) =>
                        String(
                            spot.floor
                        ) ===
                        String(
                            state.selectedFloor
                        )
                )
                .map(
                    (spot) =>
                        String(
                            spot.zone
                        ).toUpperCase()
                );

        const zones =
            [...new Set([
                ...zonesFromFloor,
                ...zonesFromSpots
            ])].sort();

        if (
            state.selectedZone !==
                "ALL" &&
            !zones.includes(
                state.selectedZone
            )
        ) {
            state.selectedZone =
                "ALL";
        }

        const zoneButtons =
            document
                .createDocumentFragment();

        for (
            const zone
            of ["ALL", ...zones]
        ) {
            const button =
                document.createElement(
                    "button"
                );

            button.type =
                "button";

            button.className =
                "selector-tab";

            button.textContent =
                zone === "ALL"
                    ? "All"
                    : `Zone ${zone}`;

            button.setAttribute(
                "aria-pressed",
                String(
                    state.selectedZone ===
                        zone
                )
            );

            button.addEventListener(
                "click",
                () => {
                    state.selectedZone =
                        zone;

                    state.navigationTarget =
                        null;

                    state.navigationMode =
                        null;

                    state.route =
                        null;

                    render();

                    requestAnimationFrame(
                        fitCurrentFloor
                    );
                }
            );

            zoneButtons.append(
                button
            );
        }

        ui.zoneTabs.replaceChildren(
            zoneButtons
        );

        const zoneText =
            state.selectedZone === "ALL"
                ? "All zones"
                : `Zone ${state.selectedZone}`;

        ui.garageLocation.textContent =
            `${floorLabel(state.selectedFloor)} · ${zoneText}`;

        ui.availabilityScope.textContent =
            state.selectedZone === "ALL"
                ? "ALL ZONES"
                : `ZONE ${state.selectedZone}`;
    }

    // ============================================================
    //                      RESERVATION STATE
    // ============================================================

    function acceptReservation(
        reservation
    ) {
        const old =
            state.reservation;

        const changed =
            old?.status !==
                reservation.status ||
            old?.spotId !==
                reservation.spotId ||
            old?.parkedSpotId !==
                reservation.parkedSpotId;

        if (changed) {
            state.dismissedArrival =
                null;
            state.arrivalStep =
                "question";
            state.parkedElsewhereMode =
                false;

            if (
                reservation.spotId &&
                old?.spotId !== reservation.spotId
            ) {
                // Fresh page / QR claim: keep ALL ZONES selected.
                // Only explicit navigation or an in-session move focuses
                // the exact zone.
                if (old) {
                    selectSpotLocation(
                        reservation.spotId
                    );
                }
                else {
                    const reservationSpot =
                        state.spots[
                            reservation.spotId
                        ];

                    if (reservationSpot) {
                        state.selectedFloor =
                            spotFloorId(
                                reservationSpot
                            );
                    }

                    state.selectedZone = "ALL";
                    state.camera.initialized = false;
                }
            }
        }

        if (
            CLEAR_WHEN_TERMINAL.has(
                reservation.status
            )
        ) {
            const messages = {
                EXPIRED:
                    "Your reservation has expired. Select another space when you are ready.",

                CANCELLED:
                    "Reservation cancelled."
            };

            persistId(null);

            state.reservation =
                null;

            state.moving =
                false;
            state.parkedElsewhereMode =
                false;

            state.navigationTarget =
                null;

            state.navigationMode =
                null;

            showNotice(
                messages[
                    reservation.status
                ]
            );

            return;
        }

        state.reservation =
            reservation;

        if (
            reservation.status !==
            "AWAITING_CONFIRMATION"
        ) {
            state.moving =
                false;
        }
    }

    function handleCompletedCarDeparture() {
        if (
            state.reservation?.status !==
            "COMPLETED"
        ) {
            return;
        }

        const spotId =
            currentSpotId();

        if (!spotId) {
            return;
        }

        const spot =
            state.spots[spotId];

        if (
            spot &&
            spot.physical_state ===
                "FREE"
        ) {
            persistId(null);

            state.reservation =
                null;

            state.navigationTarget =
                null;

            state.navigationMode =
                null;

            showNotice(
                "Your car has left the parking space. The bay is available again."
            );
        }
    }

    // ============================================================
    //                      SUMMARY
    // ============================================================

    function renderSummary() {
        const values =
            Object.values(state.spots);

        const counts = {
            FREE: 0,
            OCCUPIED: 0,
            RESERVED: 0
        };

        for (const spot of values) {
            if (
                Object.prototype
                    .hasOwnProperty
                    .call(
                        counts,
                        spot.status
                    )
            ) {
                counts[
                    spot.status
                ]++;
            }
        }

        $("free-count").textContent =
            state.loaded
                ? counts.FREE
                : "—";

        $("occupied-count")
            .textContent =
            state.loaded
                ? counts.OCCUPIED
                : "—";

        $("reserved-count")
            .textContent =
            state.loaded
                ? counts.RESERVED
                : "—";

        for (
            const name of [
                "free",
                "reserved",
                "occupied"
            ]
        ) {
            const total =
                values.length;

            const percentage =
                total
                    ? (
                        counts[
                            name.toUpperCase()
                        ] /
                        total
                    ) * 100
                    : 0;

            $(
                name +
                "-meter"
            ).style.width =
                `${percentage}%`;
        }

        ui.connection.dataset.state =
            state.online
                ? "live"
                : state.loaded
                    ? "offline"
                    : "connecting";

        ui.connectionText.textContent =
            state.online
                ? "Live updates"
                : state.loaded
                    ? "Reconnecting"
                    : "Connecting";

        const reservation =
            state.reservation;

        const hasReservation =
            Boolean(
                state.reservationId &&
                reservation
            );

        $("reservation-empty").hidden =
            hasReservation;

        $("reservation-details").hidden =
            !hasReservation;

        $("move-banner").hidden =
            !state.moving;

        if (ui.parkedElsewhereBanner) {
            ui.parkedElsewhereBanner.hidden =
                !state.parkedElsewhereMode;
        }

        if (hasReservation) {
            const parked =
                reservation.status ===
                "COMPLETED";

            $("space-label").textContent =
                parked
                    ? "YOUR CAR"
                    : "YOUR SPACE";

            $("reservation-spot")
                .parentElement
                .classList
                .toggle(
                    "is-parked",
                    parked
                );

            $("reservation-spot")
                .textContent =
                spotLabel(
                    currentSpotId()
                );

            const reservationSpot =
                state.spots[
                    currentSpotId()
                ];

            if (reservationSpot) {
                ui.reservationLocation.textContent =
                    `${floorLabel(spotFloorId(reservationSpot)).toUpperCase()} · ` +
                    `ZONE ${spotZone(reservationSpot)} · SMART GARAGE`;
            }

            $("reservation-reference")
                .textContent =
                state.reservationId;

            $("reservation-status")
                .textContent =
                prettyStatus(
                    reservation.status
                );

            $("reservation-status")
                .dataset.status =
                reservation.status;

            const help = {
                ACTIVE:
                    "Your space is reserved. Use navigation to find it.",

                AWAITING_CONFIRMATION:
                    state.moving
                        ? "Choose a green bay on the map to move your reservation."
                        : state.parkedElsewhereMode
                            ? "Select the occupied bay where you actually parked."
                            : "A car was detected in your reserved space. Let us know if it is yours.",

                COMPLETED:
                    "Your car is parked here. This space stays highlighted in gold so you can find it later."
            };

            $("reservation-help")
                .textContent =
                help[
                    reservation.status
                ] || "";

            ui.navigate.hidden =
                reservation.status !==
                "ACTIVE";

            ui.findCar.hidden =
                reservation.status !==
                "COMPLETED";

            ui.review.hidden =
                reservation.status !==
                    "AWAITING_CONFIRMATION" ||
                state.moving ||
                state.parkedElsewhereMode;

            ui.cancel.hidden =
                reservation.status ===
                "COMPLETED";

            ui.cancel.disabled =
                state.busy ||
                !state.online;

            ui.review.disabled =
                state.busy;

            ui.navigate.disabled =
                state.busy;

            ui.findCar.disabled =
                state.busy;
        }

        $("map-title").textContent =
            state.moving
                ? "A fresh space awaits."
                : state.parkedElsewhereMode
                    ? "Where did you park?"
                    : state.reservation
                        ?.status ===
                        "COMPLETED"
                        ? "Your car is parked."
                        : "Find your space.";

        $("map-description").textContent =
            state.moving
                ? "Choose a green bay to move your reservation."
                : state.parkedElsewhereMode
                    ? "Select the occupied bay where your car is actually parked."
                    : state.reservation
                        ?.status ===
                        "COMPLETED"
                        ? "Your car is highlighted in gold. Use Find my car whenever you need it."
                        : state.reservationId
                            ? "Your reservation is shown below."
                            : "Select a green parking bay to make it yours.";

        ui.confirm.disabled =
            state.busy ||
            !state.online;

        ui.notMyCar.disabled =
            state.busy ||
            !state.online;

        ui.reserveAnother.disabled =
            state.busy ||
            !state.online;

        ui.parkedElsewhere.disabled =
            state.busy ||
            !state.online;

        ui.arrivalBack.disabled =
            state.busy;

        ui.later.disabled =
            state.busy;

        ui.exitMove.disabled =
            state.busy;

        if (ui.exitParkedElsewhere) {
            ui.exitParkedElsewhere.disabled =
                state.busy;
        }

        ui.mapViewport.setAttribute(
            "aria-busy",
            String(state.busy)
        );
    }

    // ============================================================
    //                      MAP
    // ============================================================

    function statusForSpot(spotId) {
        const live =
            state.spots[
                spotId
            ];

        const raw =
            String(
                live?.status ||
                "UNKNOWN"
            ).toUpperCase();

        return [
            "FREE",
            "OCCUPIED",
            "RESERVED"
        ].includes(raw)
            ? raw
            : "UNKNOWN";
    }

    function spotAccent(
        spotId
    ) {
        const live =
            state.spots[
                spotId
            ];

        if (
            isMyCarSpot(
                spotId,
                live
            )
        ) {
            /*
              Confirmed car uses violet, clearly different from the
              amber/yellow active reservation.
            */
            return "#b79cff";
        }

        /*
          Your own reservation is intentionally warm yellow so it can
          never be confused with somebody else's blue reservation.
        */
        if (
            spotId ===
            currentSpotId()
        ) {
            return "#f2c85b";
        }

        const status =
            statusForSpot(
                spotId
            );

        return {
            FREE: "#5ad7a3",
            OCCUPIED: "#ff8d83",
            RESERVED: "#79a9ff",
            UNKNOWN: "#899399"
        }[status];
    }

    function visibleLayoutSpots() {
        return layoutSpotsForSelection();
    }

    function findSpotAtWorld(
        worldX,
        worldY
    ) {
        const floorId =
            String(
                state.selectedFloor
            );

        const cellX =
            Math.floor(
                worldX /
                SPATIAL_CELL_METERS
            );

        const cellY =
            Math.floor(
                worldY /
                SPATIAL_CELL_METERS
            );

        const candidates =
            layoutIndex.spatial.get(
                `${floorId}:${cellX}:${cellY}`
            ) ||
            [];

        const spots =
            state.selectedZone === "ALL"
                ? candidates
                : candidates.filter(
                    (spot) =>
                        String(
                            spot.zone
                        ).toUpperCase() ===
                        state.selectedZone
                );

        for (
            let index =
                spots.length - 1;
            index >= 0;
            index--
        ) {
            const spot =
                spots[index];

            const centerX =
                Number(spot.x);
            const centerY =
                Number(spot.y);

            const width =
                Math.max(
                    0.1,
                    Number(spot.width) ||
                    2.5
                );

            const length =
                Math.max(
                    0.1,
                    Number(spot.length) ||
                    5
                );

            const radians =
                -(
                    Number(
                        spot.rotation
                    ) || 0
                ) *
                Math.PI /
                180;

            const dx =
                worldX - centerX;

            const dy =
                worldY - centerY;

            const localX =
                dx * Math.cos(radians) -
                dy * Math.sin(radians);

            const localY =
                dx * Math.sin(radians) +
                dy * Math.cos(radians);

            if (
                Math.abs(localX) <=
                    width / 2 &&
                Math.abs(localY) <=
                    length / 2
            ) {
                return spot;
            }
        }

        return null;
    }

    function scheduleMapDraw() {
        if (mapFrame !== null) {
            return;
        }

        mapFrame =
            requestAnimationFrame(
                () => {
                    mapFrame = null;
                    drawMap();
                }
            );
    }

    function resizeCanvas() {
        const rect =
            ui.mapViewport
                .getBoundingClientRect();

        const dpr =
            Math.min(
                3,
                Math.max(
                    1,
                    window.devicePixelRatio ||
                    1
                )
            );

        const width =
            Math.max(
                1,
                Math.round(
                    rect.width * dpr
                )
            );

        const height =
            Math.max(
                1,
                Math.round(
                    rect.height * dpr
                )
            );

        if (
            ui.canvas.width !==
                width ||
            ui.canvas.height !==
                height
        ) {
            ui.canvas.width =
                width;

            ui.canvas.height =
                height;
        }

        return {
            cssWidth:
                Math.max(
                    1,
                    rect.width
                ),
            cssHeight:
                Math.max(
                    1,
                    rect.height
                ),
            dpr
        };
    }

    function drawPolyline(
        ctx,
        points,
        {
            stroke,
            width,
            dash = [],
            alpha = 1,
            lineCap = "round",
            lineJoin = "round"
        }
    ) {
        if (
            !Array.isArray(points) ||
            points.length < 2
        ) {
            return;
        }

        ctx.save();

        ctx.globalAlpha =
            alpha;

        ctx.strokeStyle =
            stroke;

        ctx.lineWidth =
            width;

        ctx.lineCap =
            lineCap;

        ctx.lineJoin =
            lineJoin;

        ctx.setLineDash(
            dash
        );

        ctx.beginPath();

        points.forEach(
            (point, index) => {
                const x =
                    Array.isArray(point)
                        ? Number(point[0])
                        : Number(point.x);

                const y =
                    Array.isArray(point)
                        ? Number(point[1])
                        : Number(point.y);

                const screen =
                    worldToScreen(
                        x,
                        y
                    );

                if (index === 0) {
                    ctx.moveTo(
                        screen.x,
                        screen.y
                    );
                }
                else {
                    ctx.lineTo(
                        screen.x,
                        screen.y
                    );
                }
            }
        );

        ctx.stroke();
        ctx.restore();
    }

    function drawRoads(
        ctx,
        floor
    ) {
        const roads =
            (state.layout?.roads || [])
                .filter(
                    (road) =>
                        String(road.floor) ===
                        String(floor.id)
                );

        function roadPoint(point) {
            return Array.isArray(point)
                ? {
                    x: Number(point[0]),
                    y: Number(point[1])
                }
                : {
                    x: Number(point.x),
                    y: Number(point.y)
                };
        }

        function drawLaneEdge(
            a,
            b,
            offsetPx,
            stroke,
            alpha = 1
        ) {
            const sa =
                worldToScreen(
                    a.x,
                    a.y
                );

            const sb =
                worldToScreen(
                    b.x,
                    b.y
                );

            const dx =
                sb.x - sa.x;

            const dy =
                sb.y - sa.y;

            const length =
                Math.hypot(dx, dy) || 1;

            const nx =
                -dy / length;

            const ny =
                dx / length;

            ctx.save();

            ctx.strokeStyle =
                stroke;

            ctx.globalAlpha =
                alpha;

            ctx.lineWidth =
                Math.max(
                    1,
                    state.camera.scale *
                        0.045
                );

            ctx.lineCap =
                "round";

            ctx.beginPath();

            ctx.moveTo(
                sa.x + nx * offsetPx,
                sa.y + ny * offsetPx
            );

            ctx.lineTo(
                sb.x + nx * offsetPx,
                sb.y + ny * offsetPx
            );

            ctx.stroke();
            ctx.restore();
        }

        function drawRoadArrow(
            a,
            b,
            t,
            side = 0,
            reverse = false
        ) {
            const ax =
                a.x +
                (b.x - a.x) * t;

            const ay =
                a.y +
                (b.y - a.y) * t;

            const screen =
                worldToScreen(
                    ax,
                    ay
                );

            const angle =
                Math.atan2(
                    b.y - a.y,
                    b.x - a.x
                ) +
                (reverse ? Math.PI : 0);

            const roadNormalX =
                -Math.sin(angle);

            const roadNormalY =
                Math.cos(angle);

            const laneOffset =
                side *
                Math.max(
                    5,
                    state.camera.scale *
                        0.9
                );

            const size =
                Math.max(
                    5,
                    Math.min(
                        10,
                        state.camera.scale *
                            0.28
                    )
                );

            ctx.save();

            ctx.translate(
                screen.x +
                    roadNormalX *
                    laneOffset,
                screen.y +
                    roadNormalY *
                    laneOffset
            );

            ctx.rotate(angle);

            ctx.strokeStyle =
                "#c7ced1";

            ctx.globalAlpha =
                0.28;

            ctx.lineWidth =
                Math.max(
                    1.1,
                    state.camera.scale *
                        0.04
                );

            ctx.lineCap =
                "round";

            ctx.beginPath();

            ctx.moveTo(
                -size * 0.7,
                -size * 0.55
            );

            ctx.lineTo(
                0,
                0
            );

            ctx.lineTo(
                -size * 0.7,
                size * 0.55
            );

            ctx.stroke();
            ctx.restore();
        }

        for (const road of roads) {
            if (
                !Array.isArray(
                    road.points
                ) ||
                road.points.length < 2
            ) {
                continue;
            }

            const roadWidthMeters =
                Math.max(
                    2,
                    Number(road.width) || 5.5
                );

            const roadWidthPx =
                roadWidthMeters *
                state.camera.scale;

            /*
              1) concrete shoulder
              2) asphalt / driving surface
              3) subtle central lightening
            */
            drawPolyline(
                ctx,
                road.points,
                {
                    stroke: "#0f1417",
                    width:
                        roadWidthPx + 10,
                    alpha: 0.82
                }
            );

            drawPolyline(
                ctx,
                road.points,
                {
                    stroke: "#32393e",
                    width:
                        roadWidthPx + 3,
                    alpha: 1
                }
            );

            drawPolyline(
                ctx,
                road.points,
                {
                    stroke: "#3b4449",
                    width:
                        Math.max(
                            1,
                            roadWidthPx - 4
                        ),
                    alpha: 0.58
                }
            );

            /*
              Realistic edge lines: these sit near the actual road edges
              instead of drawing every road as one glowing tube.
            */
            for (
                let index = 0;
                index <
                    road.points.length - 1;
                index++
            ) {
                const a =
                    roadPoint(
                        road.points[index]
                    );

                const b =
                    roadPoint(
                        road.points[
                            index + 1
                        ]
                    );

                const edgeOffset =
                    Math.max(
                        2,
                        roadWidthPx / 2 -
                            Math.max(
                                2,
                                state.camera.scale *
                                    0.15
                            )
                    );

                drawLaneEdge(
                    a,
                    b,
                    edgeOffset,
                    "#899399",
                    0.24
                );

                drawLaneEdge(
                    a,
                    b,
                    -edgeOffset,
                    "#899399",
                    0.24
                );

                /*
                  Parking-garage aisles normally use directional arrows
                  more than a heavy motorway centre line.
                */
                const segmentMeters =
                    Math.hypot(
                        b.x - a.x,
                        b.y - a.y
                    );

                if (
                    state.camera.scale >= 4.2 &&
                    segmentMeters >= 15
                ) {
                    const direction =
                        String(
                            road.direction ||
                            "both"
                        ).toLowerCase();

                    if (
                        direction ===
                            "oneway" ||
                        direction ===
                            "forward"
                    ) {
                        drawRoadArrow(
                            a,
                            b,
                            0.5,
                            0,
                            false
                        );
                    }
                    else {
                        drawRoadArrow(
                            a,
                            b,
                            0.38,
                            -1,
                            false
                        );

                        drawRoadArrow(
                            a,
                            b,
                            0.62,
                            1,
                            true
                        );
                    }
                }
            }

            /*
              A restrained broken centre guide appears only when the
              user zooms in enough to benefit from it.
            */
            if (
                state.camera.scale >= 6.5
            ) {
                drawPolyline(
                    ctx,
                    road.points,
                    {
                        stroke: "#b6bec2",
                        width:
                            Math.max(
                                1,
                                state.camera.scale *
                                    0.035
                            ),
                        dash: [
                            Math.max(
                                6,
                                state.camera.scale *
                                    0.5
                            ),
                            Math.max(
                                8,
                                state.camera.scale *
                                    0.65
                            )
                        ],
                        alpha: 0.18
                    }
                );
            }
        }
    }

    function drawZoneLabels(
        ctx
    ) {
        const groups =
            new Map();

        for (
            const spot
            of visibleLayoutSpots()
        ) {
            const zone =
                String(
                    spot.zone || ""
                ).toUpperCase();

            if (!zone) {
                continue;
            }

            if (!groups.has(zone)) {
                groups.set(
                    zone,
                    []
                );
            }

            groups.get(zone)
                .push(spot);
        }

        for (
            const [zone, spots]
            of groups
        ) {
            if (!spots.length) {
                continue;
            }

            const x =
                spots.reduce(
                    (sum, spot) =>
                        sum +
                        Number(spot.x),
                    0
                ) /
                spots.length;

            const y =
                Math.min(
                    ...spots.map(
                        (spot) =>
                            Number(spot.y) -
                            (
                                Number(
                                    spot.length
                                ) || 5
                            ) / 2
                    )
                ) -
                0.85;

            const screen =
                worldToScreen(
                    x,
                    y
                );

            const label =
                `ZONE ${zone}`;

            const fontSize =
                Math.max(
                    9,
                    Math.min(
                        12,
                        state.camera.scale *
                            0.34
                    )
                );

            ctx.save();

            ctx.font =
                `700 ${fontSize}px DM Sans, sans-serif`;

            const textWidth =
                ctx.measureText(
                    label
                ).width;

            const paddingX = 9;
            const height =
                fontSize + 9;

            const width =
                textWidth +
                paddingX * 2;

            const left =
                screen.x -
                width / 2;

            const top =
                screen.y -
                height;

            ctx.fillStyle =
                "#161c20e8";

            ctx.strokeStyle =
                "#ffffff10";

            ctx.lineWidth = 1;

            ctx.beginPath();

            if (
                typeof ctx.roundRect ===
                    "function"
            ) {
                ctx.roundRect(
                    left,
                    top,
                    width,
                    height,
                    height / 2
                );
            }
            else {
                ctx.rect(
                    left,
                    top,
                    width,
                    height
                );
            }

            ctx.fill();
            ctx.stroke();

            ctx.fillStyle =
                "#9bb0a7";

            ctx.textAlign =
                "center";

            ctx.textBaseline =
                "middle";

            ctx.fillText(
                label,
                screen.x,
                top +
                    height / 2 +
                    0.5
            );

            ctx.restore();
        }
    }

    function drawEntranceExit(
        ctx,
        item,
        label,
        accent
    ) {
        const screen =
            worldToScreen(
                Number(item.x),
                Number(item.y)
            );

        const radius =
            Math.max(
                7,
                Math.min(
                    11,
                    state.camera.scale *
                        0.3
                )
            );

        ctx.save();

        ctx.shadowColor =
            accent;

        ctx.shadowBlur =
            Math.min(
                16,
                radius * 1.2
            );

        ctx.beginPath();

        ctx.arc(
            screen.x,
            screen.y,
            radius + 3,
            0,
            Math.PI * 2
        );

        ctx.fillStyle =
            "#071411";

        ctx.fill();

        ctx.shadowBlur = 0;

        ctx.beginPath();

        ctx.arc(
            screen.x,
            screen.y,
            radius,
            0,
            Math.PI * 2
        );

        ctx.fillStyle =
            "#172924";

        ctx.fill();

        ctx.lineWidth =
            Math.max(
                2,
                radius * 0.18
            );

        ctx.strokeStyle =
            accent;

        ctx.stroke();

        /*
          Small inner dot creates the visual language of a
          navigation waypoint instead of a plain engineering node.
        */
        ctx.beginPath();

        ctx.arc(
            screen.x,
            screen.y,
            Math.max(
                2,
                radius * 0.28
            ),
            0,
            Math.PI * 2
        );

        ctx.fillStyle =
            accent;

        ctx.fill();

        const fontSize =
            Math.max(
                8,
                Math.min(
                    10,
                    state.camera.scale *
                        0.3
                )
            );

        ctx.font =
            `700 ${fontSize}px DM Sans, sans-serif`;

        const textWidth =
            ctx.measureText(
                label
            ).width;

        const pillWidth =
            textWidth + 15;

        const pillHeight =
            fontSize + 9;

        const pillX =
            screen.x -
            pillWidth / 2;

        const pillY =
            screen.y -
            radius -
            pillHeight -
            8;

        ctx.fillStyle =
            "#171d21ee";

        ctx.strokeStyle =
            "#ffffff0f";

        ctx.lineWidth = 1;

        ctx.beginPath();

        if (
            typeof ctx.roundRect ===
                "function"
        ) {
            ctx.roundRect(
                pillX,
                pillY,
                pillWidth,
                pillHeight,
                pillHeight / 2
            );
        }
        else {
            ctx.rect(
                pillX,
                pillY,
                pillWidth,
                pillHeight
            );
        }

        ctx.fill();
        ctx.stroke();

        ctx.fillStyle =
            "#e8f1ec";

        ctx.textAlign =
            "center";

        ctx.textBaseline =
            "middle";

        ctx.fillText(
            label,
            screen.x,
            pillY +
                pillHeight / 2
        );

        ctx.restore();
    }

    function drawRoute(ctx) {
        const route =
            state.route;

        if (
            !route?.points?.length
        ) {
            return;
        }

        const points =
            route.points.filter(
                (point) =>
                    String(point.floor) ===
                    String(
                        state.selectedFloor
                    )
            );

        if (
            points.length < 2
        ) {
            return;
        }

        const routeWidth =
            Math.max(
                5,
                Math.min(
                    11,
                    state.camera.scale *
                        0.22
                )
            );

        /*
          The dark casing keeps the route readable on every road,
          similar to navigation-map route styling.
        */
        drawPolyline(
            ctx,
            points,
            {
                stroke: "#101416",
                width:
                    routeWidth + 7,
                alpha: 0.72
            }
        );

        ctx.save();
        ctx.shadowColor =
            "#f5cf62";
        ctx.shadowBlur = 11;

        drawPolyline(
            ctx,
            points,
            {
                stroke: "#f5cf62",
                width:
                    routeWidth,
                alpha: 1
            }
        );

        ctx.restore();

        const first =
            worldToScreen(
                points[0].x,
                points[0].y
            );

        const last =
            worldToScreen(
                points[
                    points.length - 1
                ].x,
                points[
                    points.length - 1
                ].y
            );

        for (
            const endpoint of [
                {
                    point: first,
                    radius: 5,
                    fill: "#d4f59d"
                },
                {
                    point: last,
                    radius: 6,
                    fill: "#f5cf62"
                }
            ]
        ) {
            ctx.save();

            ctx.shadowColor =
                endpoint.fill;

            ctx.shadowBlur = 10;

            ctx.fillStyle =
                "#091612";

            ctx.beginPath();

            ctx.arc(
                endpoint.point.x,
                endpoint.point.y,
                endpoint.radius + 3,
                0,
                Math.PI * 2
            );

            ctx.fill();

            ctx.shadowBlur = 0;

            ctx.fillStyle =
                endpoint.fill;

            ctx.beginPath();

            ctx.arc(
                endpoint.point.x,
                endpoint.point.y,
                endpoint.radius,
                0,
                Math.PI * 2
            );

            ctx.fill();

            ctx.restore();
        }
    }

    function drawParkingSpot(
        ctx,
        layoutSpot
    ) {
        const spotId =
            String(layoutSpot.id);

        const live =
            state.spots[spotId];

        const status =
            statusForSpot(
                spotId
            );

        const accent =
            spotAccent(
                spotId
            );

        const center =
            worldToScreen(
                Number(layoutSpot.x),
                Number(layoutSpot.y)
            );

        const width =
            Math.max(
                5,
                (
                    Number(
                        layoutSpot.width
                    ) || 2.5
                ) *
                state.camera.scale
            );

        const length =
            Math.max(
                9,
                (
                    Number(
                        layoutSpot.length
                    ) || 5
                ) *
                state.camera.scale
            );

        const rotation =
            (
                Number(
                    layoutSpot.rotation
                ) || 0
            ) *
            Math.PI /
            180;

        const isOwn =
            spotId ===
            currentSpotId();

        const isCar =
            isMyCarSpot(
                spotId,
                live
            );

        const isTarget =
            spotId ===
            state.navigationTarget;

        const isSelected =
            spotId ===
            state.selectedMapSpot;

        const radius =
            Math.max(
                2,
                Math.min(
                    7,
                    width * 0.09
                )
            );

        ctx.save();

        ctx.translate(
            center.x,
            center.y
        );

        ctx.rotate(rotation);

        /*
          Neutral base bay: status is communicated with restrained
          colour instead of every space glowing like a debug diagram.
        */
        let fill =
            status === "FREE"
                ? "#173b30"
                : "#20272b";

        let fillAlpha =
            status === "FREE"
                ? 0.74
                : 0.5;

        if (status === "OCCUPIED") {
            fill =
                "#4a2c2b";
            fillAlpha = 0.76;
        }
        else if (
            status === "RESERVED"
        ) {
            fill =
                "#20385f";
            fillAlpha = 0.78;
        }

        if (isOwn) {
            fill =
                "#51451f";
            fillAlpha = 0.9;
        }

        if (isCar) {
            fill =
                "#38304a";
            fillAlpha = 0.94;
        }

        ctx.globalAlpha =
            fillAlpha;

        ctx.fillStyle =
            fill;

        ctx.beginPath();

        if (
            typeof ctx.roundRect ===
                "function"
        ) {
            ctx.roundRect(
                -width / 2,
                -length / 2,
                width,
                length,
                radius
            );
        }
        else {
            ctx.rect(
                -width / 2,
                -length / 2,
                width,
                length
            );
        }

        ctx.fill();

        /*
          Neutral structural frame.
        */
        ctx.globalAlpha =
            0.72;

        ctx.strokeStyle =
            status === "UNKNOWN"
                ? "#7f898e"
                : accent;

        ctx.globalAlpha =
            isOwn || isCar
                ? 1
                : status === "FREE" ||
                  status === "RESERVED"
                    ? 0.92
                    : 0.82;

        ctx.lineWidth =
            isOwn ||
            isCar
                ? Math.max(
                    2,
                    width * 0.045
                )
                : Math.max(
                    1.35,
                    width * 0.032
                );

        ctx.beginPath();

        if (
            typeof ctx.roundRect ===
                "function"
        ) {
            ctx.roundRect(
                -width / 2,
                -length / 2,
                width,
                length,
                radius
            );
        }
        else {
            ctx.rect(
                -width / 2,
                -length / 2,
                width,
                length
            );
        }

        ctx.stroke();

        /*
          Status rail on the road-facing end. At overview zoom this is
          enough to read hundreds of spaces without visual clutter.
        */
        const railHeight =
            Math.max(
                2.2,
                Math.min(
                    5,
                    length * 0.09
                )
            );

        ctx.globalAlpha =
            isOwn || isCar
                ? 0.98
                : status === "UNKNOWN"
                    ? 0.45
                    : 0.82;

        ctx.fillStyle =
            accent;

        ctx.beginPath();

        if (
            typeof ctx.roundRect ===
                "function"
        ) {
            ctx.roundRect(
                -width * 0.34,
                length / 2 -
                    railHeight -
                    1,
                width * 0.68,
                railHeight,
                railHeight / 2
            );
        }
        else {
            ctx.rect(
                -width * 0.34,
                length / 2 -
                    railHeight -
                    1,
                width * 0.68,
                railHeight
            );
        }

        ctx.fill();

        /*
          Top-down vehicle silhouette.
        */
        if (
            status === "OCCUPIED" ||
            isCar
        ) {
            const carWidth =
                width * 0.58;

            const carLength =
                length * 0.62;

            const carRadius =
                Math.max(
                    2,
                    Math.min(
                        7,
                        carWidth * 0.2
                    )
                );

            ctx.globalAlpha =
                isCar
                    ? 0.96
                    : 0.8;

            ctx.fillStyle =
                isCar
                    ? "#a98ee8"
                    : "#c66e67";

            ctx.beginPath();

            if (
                typeof ctx.roundRect ===
                    "function"
            ) {
                ctx.roundRect(
                    -carWidth / 2,
                    -carLength / 2,
                    carWidth,
                    carLength,
                    carRadius
                );
            }
            else {
                ctx.rect(
                    -carWidth / 2,
                    -carLength / 2,
                    carWidth,
                    carLength
                );
            }

            ctx.fill();

            if (
                carWidth >= 8 &&
                carLength >= 15
            ) {
                ctx.globalAlpha =
                    0.46;

                ctx.fillStyle =
                    "#202629";

                const glassWidth =
                    carWidth * 0.7;

                const glassHeight =
                    Math.max(
                        2,
                        carLength * 0.13
                    );

                for (
                    const glassY of [
                        -carLength * 0.23,
                        carLength * 0.1
                    ]
                ) {
                    ctx.beginPath();

                    if (
                        typeof ctx.roundRect ===
                            "function"
                    ) {
                        ctx.roundRect(
                            -glassWidth / 2,
                            glassY,
                            glassWidth,
                            glassHeight,
                            2
                        );
                    }
                    else {
                        ctx.rect(
                            -glassWidth / 2,
                            glassY,
                            glassWidth,
                            glassHeight
                        );
                    }

                    ctx.fill();
                }
            }
        }

        ctx.restore();

        /*
          Labels progressively appear as zoom increases, exactly like a
          map: overview shows geometry/status; detail zoom reveals names.
        */
        if (
            width >= 16 &&
            length >= 26
        ) {
            ctx.save();

            ctx.textAlign =
                "center";

            ctx.textBaseline =
                "middle";

            ctx.font =
                `700 ${Math.max(
                    7,
                    Math.min(
                        12,
                        width * 0.38
                    )
                )}px Manrope, sans-serif`;

            ctx.fillStyle =
                isCar
                    ? "#ded4ff"
                    : isOwn
                        ? "#ffe49a"
                        : "#e3e8ea";

            ctx.globalAlpha =
                isOwn || isCar
                    ? 1
                    : 0.88;

            ctx.fillText(
                spotLabel(spotId),
                center.x,
                center.y
            );

            ctx.restore();
        }

        /*
          Clean rectangular map selection / navigation target.
        */
        if (
            isSelected ||
            isTarget
        ) {
            ctx.save();

            ctx.translate(
                center.x,
                center.y
            );

            ctx.rotate(rotation);

            const extra =
                Math.max(
                    3,
                    Math.min(
                        7,
                        state.camera.scale *
                            0.15
                    )
                );

            ctx.strokeStyle =
                isTarget
                    ? "#ffd86f"
                    : "#f4f6f7";

            ctx.globalAlpha =
                0.98;

            ctx.lineWidth =
                Math.max(
                    2,
                    state.camera.scale *
                        0.055
                );

            ctx.shadowColor =
                isTarget
                    ? "#ffd86f"
                    : "#ffffff";

            ctx.shadowBlur =
                isTarget
                    ? 8
                    : 4;

            ctx.beginPath();

            if (
                typeof ctx.roundRect ===
                    "function"
            ) {
                ctx.roundRect(
                    -width / 2 -
                        extra,
                    -length / 2 -
                        extra,
                    width +
                        extra * 2,
                    length +
                        extra * 2,
                    radius +
                        extra * 0.25
                );
            }
            else {
                ctx.rect(
                    -width / 2 -
                        extra,
                    -length / 2 -
                        extra,
                    width +
                        extra * 2,
                    length +
                        extra * 2
                );
            }

            ctx.stroke();
            ctx.restore();
        }
    }

    function updateScaleBar() {
        if (!state.camera.scale) {
            return;
        }

        const targetPixels = 72;
        const rawMeters =
            targetPixels /
            state.camera.scale;

        const magnitude =
            10 **
            Math.floor(
                Math.log10(
                    Math.max(
                        rawMeters,
                        0.0001
                    )
                )
            );

        const normalized =
            rawMeters /
            magnitude;

        const step =
            normalized >= 5
                ? 5
                : normalized >= 2
                    ? 2
                    : 1;

        const meters =
            step *
            magnitude;

        const pixels =
            Math.max(
                22,
                meters *
                state.camera.scale
            );

        const line =
            ui.mapScale
                .querySelector(
                    "span"
                );

        const label =
            ui.mapScale
                .querySelector(
                    "small"
                );

        line.style.width =
            `${pixels}px`;

        label.textContent =
            meters >= 1000
                ? `${meters / 1000} km`
                : `${Number(
                    meters.toFixed(
                        meters < 1
                            ? 1
                            : 0
                    )
                )} m`;
    }

    function isSpotNearViewport(
        spot,
        margin = 90
    ) {
        const center =
            worldToScreen(
                Number(spot.x),
                Number(spot.y)
            );

        const radius =
            Math.hypot(
                Number(
                    spot.width
                ) || 2.5,
                Number(
                    spot.length
                ) || 5
            ) *
            state.camera.scale /
            2;

        const {
            width,
            height
        } =
            viewportSize();

        return (
            center.x + radius >=
                -margin &&
            center.x - radius <=
                width + margin &&
            center.y + radius >=
                -margin &&
            center.y - radius <=
                height + margin
        );
    }

    function drawMap() {
        const {
            cssWidth,
            cssHeight,
            dpr
        } =
            resizeCanvas();

        const ctx =
            ui.canvas.getContext(
                "2d"
            );

        ctx.setTransform(
            dpr,
            0,
            0,
            dpr,
            0,
            0
        );

        ctx.clearRect(
            0,
            0,
            cssWidth,
            cssHeight
        );

        /*
          World outside the garage remains visible as neutral grey.
          Because the camera is intentionally uncapped, the user can
          pan beyond the building just like on a normal map.
        */
        ctx.fillStyle =
            "#242a2e";

        ctx.fillRect(
            0,
            0,
            cssWidth,
            cssHeight
        );

        if (
            !state.layoutLoaded ||
            !currentFloor()
        ) {
            return;
        }

        if (
            !state.camera.initialized
        ) {
            fitCurrentFloor();
            return;
        }

        clampCamera();

        const floor =
            currentFloor();

        const topLeft =
            worldToScreen(
                0,
                0
            );

        const bottomRight =
            worldToScreen(
                Number(
                    floor.width
                ) || 1,
                Number(
                    floor.height
                ) || 1
            );

        ctx.save();

        const floorWidth =
            bottomRight.x -
            topLeft.x;

        const floorHeight =
            bottomRight.y -
            topLeft.y;

        /*
          Continuous map world: the physical garage floor is the same
          neutral grey as the world around it. No boxed/capped map.
        */
        ctx.fillStyle =
            "#242a2e";

        ctx.fillRect(
            topLeft.x,
            topLeft.y,
            floorWidth,
            floorHeight
        );

                ctx.restore();

        drawRoads(
            ctx,
            floor
        );

        drawRoute(ctx);

        drawZoneLabels(ctx);

        for (
            const entrance
            of state.layout
                ?.entrances || []
        ) {
            if (
                String(
                    entrance.floor
                ) ===
                String(
                    state.selectedFloor
                )
            ) {
                drawEntranceExit(
                    ctx,
                    entrance,
                    "ENTRANCE",
                    "#bdec8c"
                );
            }
        }

        for (
            const exit
            of state.layout
                ?.exits || []
        ) {
            if (
                String(
                    exit.floor
                ) ===
                String(
                    state.selectedFloor
                )
            ) {
                drawEntranceExit(
                    ctx,
                    exit,
                    "EXIT",
                    "#91a39b"
                );
            }
        }

        for (
            const spot
            of visibleLayoutSpots()
        ) {
            if (
                !isSpotNearViewport(
                    spot
                )
            ) {
                continue;
            }

            drawParkingSpot(
                ctx,
                spot
            );
        }

        updateScaleBar();

        const percent =
            Math.round(
                (
                    state.camera.scale /
                    Math.max(
                        0.001,
                        state.camera.fitScale
                    )
                ) *
                100
            );

        ui.mapZoomValue.textContent =
            `${percent}%`;

        ui.mapZoomOut.disabled =
            state.camera.scale <=
            state.camera.minScale *
                1.001;

        ui.mapZoomIn.disabled =
            state.camera.scale >=
            state.camera.maxScale *
                0.999;
    }

    function renderMapAccessibility() {
        const fragment =
            document
                .createDocumentFragment();

        for (
            const layoutSpot
            of visibleLayoutSpots()
        ) {
            const id =
                String(
                    layoutSpot.id
                );

            const status =
                statusForSpot(
                    id
                );

            const own =
                id ===
                currentSpotId();

            const button =
                document.createElement(
                    "button"
                );

            button.type =
                "button";

            button.dataset.spotId =
                id;

            button.textContent =
                `${spotLabel(id)} — ` +
                `${
                    own
                        ? "your space"
                        : status.toLowerCase()
                }`;

            button.disabled =
                false;

            button.addEventListener(
                "click",
                () =>
                    selectMapSpot(id)
            );

            fragment.append(
                button
            );
        }

        ui.mapAccessibilityLayer
            .replaceChildren(
                fragment
            );
    }

    function renderMap() {
        ui.mapViewport.setAttribute(
            "aria-busy",
            String(
                state.busy ||
                !state.loaded ||
                !state.layoutLoaded
            )
        );

        if (!state.layoutLoaded) {
            ui.placeholder.hidden =
                false;

            ui.empty.hidden =
                true;

            const text =
                ui.placeholder
                    .querySelector("p");

            if (text) {
                text.textContent =
                    "Loading parking layout…";
            }

            scheduleMapDraw();
            return;
        }

        if (!state.loaded) {
            ui.placeholder.hidden =
                false;

            ui.empty.hidden =
                true;

            const text =
                ui.placeholder
                    .querySelector("p");

            if (text) {
                text.textContent =
                    "Connecting to live parking sensors…";
            }

            scheduleMapDraw();
            return;
        }

        ui.placeholder.hidden =
            true;

        const spots =
            visibleLayoutSpots();

        ui.empty.hidden =
            spots.length > 0;

        renderMapAccessibility();

        if (
            !state.camera.initialized
        ) {
            requestAnimationFrame(
                fitCurrentFloor
            );
        }
        else {
            scheduleMapDraw();
        }
    }

    // ============================================================
    //                      DIALOG
    // ============================================================

    function closeDialog() {
        if (
            !ui.dialog.open
        ) {
            return;
        }

        ui.dialog.close();

        if (
            dialogReturnFocus
                ?.isConnected &&
            !dialogReturnFocus
                .disabled
        ) {
            dialogReturnFocus.focus({
                preventScroll:
                    true
            });
        }
    }

    function renderDialog() {
        const shouldOpen =
            state.reservation
                ?.status ===
                "AWAITING_CONFIRMATION" &&
            !state.moving &&
            !state.parkedElsewhereMode &&
            state.dismissedArrival !==
                arrivalKey();

        if (!shouldOpen) {
            closeDialog();
            return;
        }

        const arrivalSpotId =
            currentSpotId();

        const arrivalSpot =
            state.spots[arrivalSpotId];

        $("arrival-title").textContent =
            `A car just parked in ${spotLabel(arrivalSpotId)}.`;

        $("arrival-description").textContent =
            state.arrivalStep ===
                "not-mine"
                ? "What happened?"
                : "Is it your car?";

        $("arrival-spot")
            .textContent =
            arrivalSpot
                ? `${spotLabel(arrivalSpotId)} · ${floorLabel(spotFloorId(arrivalSpot))} · Zone ${spotZone(arrivalSpot)}`
                : `${spotLabel(arrivalSpotId)} · Zone A`;

        const choosingNext =
            state.arrivalStep ===
            "not-mine";

        ui.confirm.hidden =
            choosingNext;
        ui.notMyCar.hidden =
            choosingNext;
        ui.later.hidden =
            choosingNext;

        ui.reserveAnother.hidden =
            !choosingNext;
        ui.parkedElsewhere.hidden =
            !choosingNext;
        ui.arrivalBack.hidden =
            !choosingNext;

        if (
            !ui.dialog.open
        ) {
            dialogReturnFocus =
                document.activeElement;

            ui.dialogError.hidden =
                true;

            ui.dialog.showModal();
        }
    }

    function render() {
        renderLocation();
        renderSummary();
        renderFilters();
        renderNavigation();
        renderMapPlaceCard();
        renderMap();
        renderDialog();
    }

    // ============================================================
    //                      REFRESH
    // ============================================================

    function acceptLayout(layout) {
        if (
            !layout ||
            typeof layout !== "object" ||
            !Array.isArray(layout.floors) ||
            !Array.isArray(layout.spots)
        ) {
            throw new Error(
                "The garage returned an invalid layout file."
            );
        }

        const fingerprint =
            JSON.stringify(layout);

        const changed =
            fingerprint !==
            state.layoutFingerprint;

        state.layout =
            layout;

        state.layoutLoaded =
            true;

        state.layoutLoadedAt =
            Date.now();

        state.layoutFingerprint =
            fingerprint;

        indexLayout(layout);

        const floorIds =
            layout.floors.map(
                (floor) =>
                    String(floor.id)
            );

        if (
            !state.selectedFloor ||
            !floorIds.includes(
                String(
                    state.selectedFloor
                )
            )
        ) {
            state.selectedFloor =
                floorIds[0] ||
                null;

            state.selectedZone =
                "ALL";

            state.camera.initialized =
                false;
        }

        if (changed) {
            state.camera.initialized =
                false;

            if (
                state.navigationTarget
            ) {
                state.route =
                    calculateRouteToSpot(
                        state.navigationTarget
                    );
            }
        }
    }

    async function refresh() {
        if (pollPromise) {
            return pollPromise;
        }

        pollPromise =
            (async () => {
                const id =
                    state.reservationId;

                const needsLayout =
                    !state.layoutLoaded ||
                    (
                        Date.now() -
                        state.layoutLoadedAt >=
                        LAYOUT_REFRESH_INTERVAL
                    );

                const [
                    spotsResult,
                    reservationResult,
                    layoutResult
                ] =
                    await Promise
                        .allSettled([
                            api("/spots"),

                            id
                                ? api(
                                    `/reservation/${encodeURIComponent(id)}`
                                )
                                : Promise
                                    .resolve(
                                        null
                                    ),

                            needsLayout
                                ? api(
                                    "/layout"
                                )
                                : Promise
                                    .resolve(
                                        state.layout
                                    )
                        ]);

                let failed =
                    false;

                if (
                    layoutResult.status ===
                    "fulfilled"
                ) {
                    try {
                        acceptLayout(
                            layoutResult.value
                        );
                    }
                    catch (error) {
                        failed = true;

                        showNotice(
                            error.message,
                            "error"
                        );
                    }
                }
                else if (
                    !state.layoutLoaded
                ) {
                    failed =
                        true;
                }

                if (
                    spotsResult.status ===
                    "fulfilled"
                ) {
                    const spots =
                        spotsResult.value;

                    if (
                        spots &&
                        typeof spots ===
                            "object" &&
                        !Array.isArray(
                            spots
                        )
                    ) {
                        state.spots =
                            spots;

                        state.loaded =
                            true;

                        $("updated-at")
                            .textContent =
                            `Updated ${new Date().toLocaleTimeString(
                                [],
                                {
                                    hour:
                                        "2-digit",
                                    minute:
                                        "2-digit"
                                }
                            )}`;
                    }
                    else {
                        failed = true;

                        showNotice(
                            "The garage returned invalid live parking data.",
                            "error"
                        );
                    }
                }
                else {
                    failed =
                        true;
                }

                if (
                    id &&
                    state.reservationId ===
                        id
                ) {
                    if (
                        reservationResult
                            .status ===
                        "fulfilled"
                    ) {
                        try {
                            acceptReservation(
                                normalizeReservation(
                                    reservationResult.value,
                                    id
                                )
                            );
                        }
                        catch (error) {
                            failed =
                                true;

                            showNotice(
                                error.message,
                                "error"
                            );
                        }
                    }
                    else if (
                        reservationResult
                            .reason
                            ?.status ===
                        404
                    ) {
                        persistId(null);

                        state.reservation =
                            null;

                        state.moving =
                            false;

                        state.navigationTarget =
                            null;

                        state.navigationMode =
                            null;

                        state.route =
                            null;

                        showNotice(
                            "Your saved reservation was not found.",
                            "error"
                        );
                    }
                    else {
                        failed =
                            true;
                    }
                }

                state.online =
                    !failed;

                handleCompletedCarDeparture();

                render();

                if (failed) {
                    ui.connection
                        .dataset.state =
                        "offline";

                    ui.connectionText
                        .textContent =
                        "Reconnecting";

                    $("updated-at")
                        .textContent =
                        state.loaded
                            ? "Connection lost · last known map"
                            : "Waiting for connection";

                    if (
                        !state.layoutLoaded
                    ) {
                        const text =
                            ui.placeholder
                                .querySelector(
                                    "p"
                                );

                        if (text) {
                            text.textContent =
                                "Unable to load the parking layout. Retrying automatically…";
                        }
                    }
                }
            })();

        try {
            await pollPromise;
        }
        finally {
            pollPromise =
                null;
        }
    }

    // ============================================================
    //                      MUTATIONS
    // ============================================================

    async function mutate(action) {
        if (
            state.busy ||
            !state.online
        ) {
            return;
        }

        state.busy =
            true;

        clearNotice();
        render();

        try {
            if (pollPromise) {
                await pollPromise;
            }

            if (
                !state.online
            ) {
                throw new Error(
                    "The garage is offline."
                );
            }

            await action();
        }
        catch (error) {
            showNotice(
                error.message,
                "error"
            );

            if (
                ui.dialog.open
            ) {
                ui.dialogError
                    .textContent =
                    error.message;

                ui.dialogError.hidden =
                    false;
            }
        }
        finally {
            await refresh();

            state.busy =
                false;

            render();
        }
    }

    // ============================================================
    //                      MAP SPOT ACTION
    // ============================================================

    function chooseSpot(spotId) {
        const layoutSpot =
            getLayoutSpot(spotId);

        if (!layoutSpot) {
            return;
        }

        if (state.parkedElsewhereMode) {
            const live =
                state.spots[spotId];

            if (
                live?.physical_state !==
                    "OCCUPIED" ||
                spotId ===
                    state.reservation?.spotId
            ) {
                return;
            }

            mutate(
                async () => {
                    const id =
                        state.reservationId;

                    if (
                        !id ||
                        state.reservation
                            ?.status !==
                            "AWAITING_CONFIRMATION"
                    ) {
                        throw new Error(
                            "Your reservation has changed."
                        );
                    }

                    await api(
                        `/reservation/${encodeURIComponent(id)}/parked-elsewhere`,
                        {
                            method: "POST",
                            body:
                                parkedElsewherePayload(
                                    spotId
                                )
                        }
                    );

                    state.parkedElsewhereMode =
                        false;
                    state.arrivalStep =
                        "question";
                    state.selectedMapSpot =
                        spotId;
                    state.dismissedArrival =
                        null;

                    selectSpotLocation(
                        spotId
                    );

                    showNotice(
                        `Got it. Your car is parked in ${spotLabel(spotId)}.`
                    );
                }
            );

            return;
        }

        if (!canChoose()) {
            return;
        }

        if (
            state.spots[
                spotId
            ]?.status !==
            "FREE"
        ) {
            return;
        }

        mutate(
            async () => {
                if (
                    state.spots[
                        spotId
                    ]?.status !==
                    "FREE"
                ) {
                    throw new Error(
                        "That space is no longer available."
                    );
                }

                if (
                    state.moving
                ) {
                    const id =
                        state.reservationId;

                    if (
                        !id ||
                        state.reservation
                            ?.status !==
                            "AWAITING_CONFIRMATION"
                    ) {
                        throw new Error(
                            "Your reservation has changed."
                        );
                    }

                    await api(
                        `/reservation/${encodeURIComponent(id)}/move`,
                        {
                            method:
                                "POST",

                            body:
                                movePayload(
                                    spotId
                                )
                        }
                    );

                    state.moving =
                        false;

                    selectSpotLocation(
                        spotId
                    );

                    state.selectedMapSpot =
                        spotId;

                    state.dismissedArrival =
                        null;

                    state.camera.initialized =
                        false;

                    showNotice(
                        `Reservation moved to ${spotLabel(spotId)}.`
                    );
                }
                else {
                    if (
                        state.reservationId
                    ) {
                        return;
                    }

                    const data =
                        await api(
                            "/reserve",
                            {
                                method:
                                    "POST",

                                body:
                                    reservePayload(
                                        spotId
                                    )
                            }
                        );

                    if (
                        !data
                            ?.reservation_id
                    ) {
                        throw new Error(
                            "The server did not return a reservation ID."
                        );
                    }

                    persistId(
                        String(
                            data
                                .reservation_id
                        )
                    );

                    selectSpotLocation(
                        spotId
                    );

                    state.selectedMapSpot =
                        spotId;

                    state.reservation =
                        null;

                    state.dismissedArrival =
                        null;

                    state.camera.initialized =
                        false;

                    showNotice(
                        `${spotLabel(spotId)} is reserved.`
                    );
                }
            }
        );
    }

    // ============================================================
    //                      CONFIRM CAR
    // ============================================================

    ui.confirm.addEventListener(
        "click",
        () => {
            mutate(
                async () => {
                    const id =
                        state.reservationId;

                    if (
                        !id ||
                        state.reservation
                            ?.status !==
                            "AWAITING_CONFIRMATION"
                    ) {
                        throw new Error(
                            "This reservation is no longer awaiting confirmation."
                        );
                    }

                    await api(
                        `/reservation/${encodeURIComponent(id)}/confirm`,
                        {
                            method:
                                "POST"
                        }
                    );

                    state.dismissedArrival =
                        null;

                    showNotice(
                        "Perfect. Your car will now stay highlighted in gold."
                    );
                }
            );
        }
    );

    // ============================================================
    //                      CANCEL
    // ============================================================

    ui.cancel.addEventListener(
        "click",
        () => {
            mutate(
                async () => {
                    const id =
                        state.reservationId;

                    if (!id) {
                        return;
                    }

                    await api(
                        `/reservation/${encodeURIComponent(id)}/cancel`,
                        {
                            method:
                                "POST"
                        }
                    );

                    state.moving =
                        false;

                    showNotice(
                        "Cancellation sent."
                    );
                }
            );
        }
    );

    // ============================================================
    //                  ARRIVAL: NOT MY CAR
    // ============================================================

    ui.notMyCar.addEventListener(
        "click",
        () => {
            if (state.busy) {
                return;
            }

            state.arrivalStep =
                "not-mine";

            renderDialog();
        }
    );

    ui.arrivalBack.addEventListener(
        "click",
        () => {
            state.arrivalStep =
                "question";

            renderDialog();
        }
    );

    // ============================================================
    //                  RESERVE ANOTHER SPOT
    // ============================================================

    ui.reserveAnother.addEventListener(
        "click",
        () => {
            if (
                state.busy ||
                !state.online
            ) {
                return;
            }

            state.moving =
                true;
            state.arrivalStep =
                "question";
            state.selectedMapSpot =
                null;

            clearNotice();
            render();

            // Make the next required action explicit after the arrival
            // dialog closes.
            showNotice(
                "Select another spot, then press Reserve."
            );

            const firstFree =
                visibleLayoutSpots()
                    .find(
                        (spot) =>
                            state.spots[
                                spot.id
                            ]?.status ===
                            "FREE"
                    );

            if (firstFree) {
                centerSpotOnMap(
                    firstFree.id
                );

                ui.mapViewport.focus({
                    preventScroll: false
                });
            }
            else {
                showNotice(
                    "No replacement spaces are available yet."
                );
            }
        }
    );

    // ============================================================
    //                  PARKED IN ANOTHER SPOT
    // ============================================================

    ui.parkedElsewhere.addEventListener(
        "click",
        () => {
            if (
                state.busy ||
                !state.online
            ) {
                return;
            }

            state.parkedElsewhereMode =
                true;
            state.arrivalStep =
                "question";

            clearNotice();
            render();

            const occupied =
                visibleLayoutSpots()
                    .find(
                        (spot) =>
                            spot.id !==
                                state.reservation?.spotId &&
                            state.spots[
                                spot.id
                            ]?.physical_state ===
                                "OCCUPIED"
                    );

            if (occupied) {
                centerSpotOnMap(
                    occupied.id
                );
            }
            else {
                showNotice(
                    "No other occupied spot is visible yet.",
                    "error"
                );
            }
        }
    );

    ui.exitMove.addEventListener(
        "click",
        () => {
            state.moving =
                false;
            state.arrivalStep =
                "not-mine";

            state.dismissedArrival =
                null;

            render();
        }
    );

    ui.exitParkedElsewhere
        ?.addEventListener(
            "click",
            () => {
                state.parkedElsewhereMode =
                    false;
                state.arrivalStep =
                    "not-mine";
                state.dismissedArrival =
                    null;
                state.selectedMapSpot =
                    null;

                render();
            }
        );

    // ============================================================
    //                      MAP / NAVIGATION CONTROLS
    // ============================================================

    ui.navigate.addEventListener(
        "click",
        () => {
            startNavigation(
                "reservation"
            );
        }
    );

    ui.findCar.addEventListener(
        "click",
        () => {
            startNavigation(
                "car"
            );
        }
    );

    ui.stopNavigation
        .addEventListener(
            "click",
            stopNavigation
        );

    ui.mapRecenter
        .addEventListener(
            "click",
            () => {
                if (state.route) {
                    focusRoute();
                }
                else if (
                    state.navigationTarget
                ) {
                    centerSpotOnMap(
                        state.navigationTarget
                    );
                }
                else {
                    fitCurrentFloor();
                }
            }
        );

    ui.mapCenterControl
        ?.addEventListener(
            "click",
            () => {
                if (
                    state.selectedMapSpot
                ) {
                    centerSpotOnMap(
                        state.selectedMapSpot
                    );
                }
                else if (
                    state.navigationTarget
                ) {
                    centerSpotOnMap(
                        state.navigationTarget
                    );
                }
                else {
                    fitCurrentFloor();
                }
            }
        );

    ui.mapRouteClose
        ?.addEventListener(
            "click",
            stopNavigation
        );

    for (
        const eventName of [
            "pointerdown",
            "pointermove",
            "pointerup",
            "pointercancel"
        ]
    ) {
        ui.mapPlaceCard
            ?.addEventListener(
                eventName,
                (event) => {
                    event.stopPropagation();
                }
            );
    }

    ui.mapPlaceClose
        ?.addEventListener(
            "click",
            clearSelectedMapSpot
        );

    ui.mapDirectNavigate
        ?.addEventListener(
            "pointerdown",
            (event) => {
                event.stopPropagation();
            }
        );

    ui.mapDirectNavigate
        ?.addEventListener(
            "click",
            (event) => {
                event.preventDefault();
                event.stopPropagation();

                const spotId =
                    state.selectedMapSpot;

                if (!spotId) {
                    return;
                }

                const live =
                    state.spots[spotId];

                startNavigationToSpot(
                    spotId,
                    isMyCarSpot(
                        spotId,
                        live
                    )
                        ? "car"
                        : "map"
                );
            }
        );

    ui.mapPlaceNavigate
        ?.addEventListener(
            "click",
            (event) => {
                event.preventDefault();
                event.stopPropagation();

                const spotId =
                    state.selectedMapSpot;

                if (!spotId) {
                    return;
                }

                const live =
                    state.spots[spotId];

                startNavigationToSpot(
                    spotId,
                    isMyCarSpot(
                        spotId,
                        live
                    )
                        ? "car"
                        : "map"
                );
            }
        );

    ui.mapPlaceReserve
        ?.addEventListener(
            "click",
            () => {
                const spotId =
                    state.selectedMapSpot;

                if (!spotId) {
                    return;
                }

                chooseSpot(
                    spotId
                );
            }
        );

    ui.locationButton
        .addEventListener(
            "click",
            startLocation
        );

    ui.mapZoomOut.addEventListener(
        "click",
        () =>
            changeMapZoom(
                1 /
                CAMERA_ZOOM_FACTOR
            )
    );

    ui.mapZoomIn.addEventListener(
        "click",
        () =>
            changeMapZoom(
                CAMERA_ZOOM_FACTOR
            )
    );

    ui.mapZoomFit.addEventListener(
        "click",
        fitCurrentFloor
    );

    ui.mapFullscreenToggle.addEventListener(
        "click",
        toggleMapFullscreen
    );

    ui.mapViewport.addEventListener(
        "pointerdown",
        onMapPointerDown
    );

    ui.mapViewport.addEventListener(
        "pointermove",
        onMapPointerMove
    );

    ui.mapViewport.addEventListener(
        "pointerup",
        onMapPointerEnd
    );

    ui.mapViewport.addEventListener(
        "pointercancel",
        onMapPointerEnd
    );

    ui.mapViewport.addEventListener(
        "wheel",
        onMapWheel,
        {
            passive: false
        }
    );

    ui.mapViewport.addEventListener(
        "dblclick",
        (event) => {
            event.preventDefault();

            zoomAroundScreenPoint(
                state.camera.scale *
                    CAMERA_ZOOM_FACTOR *
                    CAMERA_ZOOM_FACTOR,
                event.clientX,
                event.clientY
            );
        }
    );

    ui.mapViewport.addEventListener(
        "keydown",
        (event) => {
            const panPixels = 55;

            if (
                event.key === "+" ||
                event.key === "="
            ) {
                event.preventDefault();
                changeMapZoom(
                    CAMERA_ZOOM_FACTOR
                );
                return;
            }

            if (
                event.key === "-" ||
                event.key === "_"
            ) {
                event.preventDefault();
                changeMapZoom(
                    1 /
                    CAMERA_ZOOM_FACTOR
                );
                return;
            }

            if (
                event.key === "0" ||
                event.key === "Home"
            ) {
                event.preventDefault();
                fitCurrentFloor();
                return;
            }

            const deltas = {
                ArrowLeft: [
                    -panPixels,
                    0
                ],
                ArrowRight: [
                    panPixels,
                    0
                ],
                ArrowUp: [
                    0,
                    -panPixels
                ],
                ArrowDown: [
                    0,
                    panPixels
                ]
            };

            const delta =
                deltas[
                    event.key
                ];

            if (!delta) {
                return;
            }

            event.preventDefault();

            state.camera.centerX +=
                delta[0] /
                state.camera.scale;

            state.camera.centerY +=
                delta[1] /
                state.camera.scale;

            state.camera.userInteracted =
                true;

            clampCamera();
            scheduleMapDraw();
        }
    );

    document.addEventListener(
        "keydown",
        (event) => {
            if (
                event.key === "Escape" &&
                state.mapFullscreen
            ) {
                closeMapFullscreen();
            }
        }
    );

    // ============================================================
    //                      DIALOG / VIEWPORT CONTROLS
    // ============================================================

    function dismissArrival() {
        if (
            state.busy
        ) {
            return;
        }

        state.dismissedArrival =
            arrivalKey();
        state.arrivalStep =
            "question";

        render();
    }

    ui.later.addEventListener(
        "click",
        dismissArrival
    );

    ui.dialog.addEventListener(
        "cancel",
        (event) => {
            event.preventDefault();
            dismissArrival();
        }
    );

    ui.review.addEventListener(
        "click",
        () => {
            state.dismissedArrival =
                null;

            renderDialog();
        }
    );

    function handleMapViewportResize() {
        if (
            state.mapFullscreen
        ) {
            updateFullscreenViewport();
        }

        if (
            !state.camera.initialized ||
            !state.camera.userInteracted
        ) {
            requestAnimationFrame(
                fitCurrentFloor
            );
        }
        else {
            updateCameraLimits();
            clampCamera();
            scheduleMapDraw();
        }
    }

    compactLayout
        .addEventListener(
            "change",
            handleMapViewportResize
        );

    window.addEventListener(
        "resize",
        handleMapViewportResize
    );

    if (
        "ResizeObserver" in window
    ) {
        const observer =
            new ResizeObserver(
                handleMapViewportResize
            );

        observer.observe(
            ui.mapViewport
        );
    }

    if (
        window.visualViewport
    ) {
        window.visualViewport
            .addEventListener(
                "resize",
                () => {
                    if (
                        state.mapFullscreen
                    ) {
                        updateFullscreenViewport();
                        scheduleMapDraw();
                    }
                }
            );

        window.visualViewport
            .addEventListener(
                "scroll",
                () => {
                    if (
                        state.mapFullscreen
                    ) {
                        updateFullscreenViewport();
                    }
                }
            );
    }

    renderFullscreenState();

    // ============================================================
    //                      POLLING
    // ============================================================

    async function tick() {
        clearTimeout(timer);

        if (
            document.hidden
        ) {
            return;
        }

        if (
            !state.busy
        ) {
            await refresh();
        }

        if (
            !document.hidden
        ) {
            timer =
                setTimeout(
                    tick,
                    POLL_INTERVAL
                );
        }
    }

    document.addEventListener(
        "visibilitychange",
        () => {
            clearTimeout(timer);

            if (
                !document.hidden
            ) {
                tick();
            }
        }
    );

    render();
    tick();
})();
