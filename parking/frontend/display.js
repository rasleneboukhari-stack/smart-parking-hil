"use strict";

(() => {
    const POLL_INTERVAL = 3000;
    const TICKET_SCREEN_SECONDS = 30;

    const $ = (id) =>
        document.getElementById(id);

    const ui = {
        connection: $("display-connection"),
        connectionText: $("display-connection-text"),
        freeCount: $("display-free-count"),

        floorTabs: $("display-floor-tabs"),
        zoneTabs: $("display-zone-tabs"),

        title: $("display-location-title"),

        freeMini: $("display-free-mini"),
        occupiedMini: $("display-occupied-mini"),
        reservedMini: $("display-reserved-mini"),

        updated: $("display-updated"),

        viewport: $("display-map-viewport"),
        canvas: $("display-map-canvas"),
        loading: $("display-loading"),


        spotDialog: $("spot-dialog"),
        spotDialogClose: $("spot-dialog-close"),
        spotDialogBack: $("spot-dialog-back"),
        selectedSpotLabel: $("selected-spot-label"),
        selectedSpotLocation: $("selected-spot-location"),
        reserveSelected: $("reserve-selected-spot"),
        reservationError: $("reservation-error"),

        ticketDialog: $("ticket-dialog"),
        ticketSpot: $("ticket-spot"),
        ticketLocation: $("ticket-location"),
        ticketDirection: $("ticket-direction"),
        ticketQr: $("ticket-qr"),
        ticketReference: $("ticket-reference"),
        ticketScreenTimer: $("ticket-screen-timer"),
        ticketDone: $("ticket-done"),
        localhostWarning: $("localhost-warning"),

        toast: $("display-toast")
    };

    const state = {
        layout: null,
        layoutLoaded: false,

        spots: {},
        loaded: false,
        online: false,

        selectedFloor: null,
        selectedZone: "ALL",
        selectedSpotId: null,

        reserving: false,
        ticket: null,

        camera: {
            centerX: 0,
            centerY: 0,
            scale: 1,
            fitScale: 1,
            minScale: 0.3,
            maxScale: 10,
            initialized: false
        }
    };

    let pollTimer = null;
    let pollPromise = null;

    let toastTimer = null;

    let ticketTimer = null;
    let ticketSecondsLeft = 0;

    let mapFrame = null;
    let suppressTapUntil = 0;

    const pointers =
        new Map();

    let panGesture = null;
    let pinchGesture = null;

    const hitSpots = [];

    function floorById(id) {
        return (
            state.layout?.floors || []
        ).find(
            (floor) =>
                String(floor.id) ===
                String(id)
        ) || null;
    }

    function currentFloor() {
        return floorById(
            state.selectedFloor
        );
    }

    function floorLabel(id) {
        const floor =
            floorById(id);

        if (floor?.name) {
            return floor.name;
        }

        if (
            String(id) ===
            "ground"
        ) {
            return "Ground";
        }

        return String(id);
    }

    function spotLabel(id) {
        const layoutSpot =
            (
                state.layout?.spots || []
            ).find(
                (spot) =>
                    String(spot.id) ===
                    String(id)
            );

        if (layoutSpot?.label) {
            return String(
                layoutSpot.label
            );
        }

        const match =
            /^spot[-_]?(\d+)$/i.exec(
                String(id)
            );

        return match
            ? `P${match[1].padStart(3, "0")}`
            : String(id);
    }

    function layoutSpot(id) {
        return (
            state.layout?.spots || []
        ).find(
            (spot) =>
                String(spot.id) ===
                String(id)
        ) || null;
    }

    function spotZone(spot) {
        return String(
            spot?.zone || "A"
        ).toUpperCase();
    }

    function spotStatus(id) {
        return String(
            state.spots[id]?.status ||
            "UNKNOWN"
        ).toUpperCase();
    }

    function selectedLayoutSpots() {
        return (
            state.layout?.spots || []
        ).filter(
            (spot) =>
                String(spot.floor) ===
                    String(
                        state.selectedFloor
                    ) &&
                (
                    state.selectedZone ===
                        "ALL" ||
                    spotZone(spot) ===
                        state.selectedZone
                )
        );
    }

    function setDialogOpen(open) {
        document.body.classList.toggle(
            "dialog-open",
            open
        );
    }

    function showToast(message) {
        clearTimeout(toastTimer);

        ui.toast.textContent =
            message;

        ui.toast.hidden =
            false;

        toastTimer =
            setTimeout(
                () => {
                    ui.toast.hidden =
                        true;
                },
                3000
            );
    }

    async function api(
        path,
        options = {}
    ) {
        const controller =
            new AbortController();

        const timeout =
            setTimeout(
                () =>
                    controller.abort(),
                10000
            );

        try {
            const response =
                await fetch(
                    path,
                    {
                        cache: "no-store",
                        signal:
                            controller.signal,
                        ...options
                    }
                );

            const type =
                response.headers.get(
                    "content-type"
                ) || "";

            const body =
                type.includes(
                    "application/json"
                )
                    ? await response.json()
                    : null;

            if (!response.ok) {
                const error =
                    new Error(
                        body?.detail ||
                        `Request failed (${response.status})`
                    );

                error.status =
                    response.status;

                throw error;
            }

            return body;
        }
        finally {
            clearTimeout(timeout);
        }
    }

    function renderConnection() {
        ui.connection.dataset.state =
            state.online
                ? "live"
                : state.loaded
                    ? "offline"
                    : "connecting";

        ui.connectionText.textContent =
            state.online
                ? "Live"
                : state.loaded
                    ? "Reconnecting"
                    : "Connecting";
    }

    function renderFilters() {
        const floors =
            state.layout?.floors || [];

        if (!floors.length) {
            ui.floorTabs.replaceChildren();
            ui.zoneTabs.replaceChildren();
            return;
        }

        if (
            !floorById(
                state.selectedFloor
            )
        ) {
            state.selectedFloor =
                String(
                    floors[0].id
                );

            state.selectedZone =
                "ALL";
        }

        const floorFragment =
            document.createDocumentFragment();

        for (const floor of floors) {
            const spots =
                (
                    state.layout?.spots ||
                    []
                ).filter(
                    (spot) =>
                        String(spot.floor) ===
                        String(floor.id)
                );

            const free =
                spots.filter(
                    (spot) =>
                        spotStatus(
                            spot.id
                        ) === "FREE"
                ).length;

            const button =
                document.createElement(
                    "button"
                );

            button.type =
                "button";

            button.className =
                "tab";

            button.setAttribute(
                "aria-pressed",
                String(
                    String(
                        state.selectedFloor
                    ) ===
                    String(floor.id)
                )
            );

            button.innerHTML =
                `${floor.name}` +
                `<small>${free} free</small>`;

            button.addEventListener(
                "click",
                () => {
                    state.selectedFloor =
                        String(
                            floor.id
                        );

                    state.selectedZone =
                        "ALL";

                    state.selectedSpotId =
                        null;

                    closeSpotDialog();

                    render();
                    fitMap();
                }
            );

            floorFragment.append(
                button
            );
        }

        ui.floorTabs.replaceChildren(
            floorFragment
        );

        const zones =
            [
                ...new Set(
                    (
                        state.layout?.spots ||
                        []
                    )
                        .filter(
                            (spot) =>
                                String(
                                    spot.floor
                                ) ===
                                String(
                                    state.selectedFloor
                                )
                        )
                        .map(spotZone)
                )
            ].sort();

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

        const zoneFragment =
            document.createDocumentFragment();

        for (
            const zone of [
                "ALL",
                ...zones
            ]
        ) {
            const spots =
                (
                    state.layout?.spots ||
                    []
                ).filter(
                    (spot) =>
                        String(
                            spot.floor
                        ) ===
                            String(
                                state.selectedFloor
                            ) &&
                        (
                            zone === "ALL" ||
                            spotZone(spot) ===
                                zone
                        )
                );

            const free =
                spots.filter(
                    (spot) =>
                        spotStatus(
                            spot.id
                        ) === "FREE"
                ).length;

            const button =
                document.createElement(
                    "button"
                );

            button.type =
                "button";

            button.className =
                "tab";

            button.setAttribute(
                "aria-pressed",
                String(
                    state.selectedZone ===
                    zone
                )
            );

            button.innerHTML =
                `${
                    zone === "ALL"
                        ? "All zones"
                        : `Zone ${zone}`
                }` +
                `<small>${free} free</small>`;

            button.addEventListener(
                "click",
                () => {
                    state.selectedZone =
                        zone;

                    state.selectedSpotId =
                        null;

                    closeSpotDialog();

                    render();
                    fitMap();
                }
            );

            zoneFragment.append(
                button
            );
        }

        ui.zoneTabs.replaceChildren(
            zoneFragment
        );
    }

    function renderStats() {
        const spots =
            selectedLayoutSpots();

        const counts = {
            FREE: 0,
            OCCUPIED: 0,
            RESERVED: 0
        };

        for (const spot of spots) {
            const status =
                spotStatus(
                    spot.id
                );

            if (
                Object.prototype
                    .hasOwnProperty.call(
                        counts,
                        status
                    )
            ) {
                counts[status]++;
            }
        }

        ui.freeCount.textContent =
            state.loaded
                ? counts.FREE
                : "—";

        ui.freeMini.textContent =
            state.loaded
                ? counts.FREE
                : "—";

        ui.occupiedMini.textContent =
            state.loaded
                ? counts.OCCUPIED
                : "—";

        ui.reservedMini.textContent =
            state.loaded
                ? counts.RESERVED
                : "—";

        ui.title.textContent =
            `${floorLabel(
                state.selectedFloor
            )} · ${
                state.selectedZone ===
                    "ALL"
                    ? "All zones"
                    : `Zone ${
                        state.selectedZone
                    }`
            }`;
    }

    function worldToScreen(
        x,
        y
    ) {
        const rect =
            ui.viewport
                .getBoundingClientRect();

        return {
            x:
                rect.width / 2 +
                (
                    Number(x) -
                    state.camera.centerX
                ) *
                state.camera.scale,

            y:
                rect.height / 2 +
                (
                    Number(y) -
                    state.camera.centerY
                ) *
                state.camera.scale
        };
    }

    function screenToWorld(
        clientX,
        clientY
    ) {
        const rect =
            ui.viewport
                .getBoundingClientRect();

        return {
            x:
                state.camera.centerX +
                (
                    clientX -
                    rect.left -
                    rect.width / 2
                ) /
                state.camera.scale,

            y:
                state.camera.centerY +
                (
                    clientY -
                    rect.top -
                    rect.height / 2
                ) /
                state.camera.scale
        };
    }

    function updateCameraLimits() {
        const floor =
            currentFloor();

        const rect =
            ui.viewport
                .getBoundingClientRect();

        if (
            !floor ||
            !rect.width ||
            !rect.height
        ) {
            return;
        }

        const width =
            Math.max(
                1,
                Number(floor.width) || 1
            );

        const height =
            Math.max(
                1,
                Number(floor.height) || 1
            );

        const padding = 34;

        const fitScale =
            Math.min(
                Math.max(
                    1,
                    rect.width -
                    padding * 2
                ) / width,

                Math.max(
                    1,
                    rect.height -
                    padding * 2
                ) / height
            );

        state.camera.fitScale =
            Math.max(
                0.01,
                fitScale
            );

        state.camera.minScale =
            state.camera.fitScale *
            0.55;

        state.camera.maxScale =
            state.camera.fitScale *
            8;
    }

    function fitMap() {
        const floor =
            currentFloor();

        if (!floor) {
            return;
        }

        const rect =
            ui.viewport
                .getBoundingClientRect();

        const spots =
            selectedLayoutSpots();

        let minX = 0;
        let minY = 0;
        let maxX =
            Number(floor.width) || 1;
        let maxY =
            Number(floor.height) || 1;

        /*
          When a specific zone is selected, frame that zone.
          With ALL zones selected, frame the full floor.
        */
        if (
            state.selectedZone !== "ALL" &&
            spots.length
        ) {
            minX =
                Math.min(
                    ...spots.map(
                        (spot) =>
                            Number(spot.x) -
                            (Number(spot.width) || 2.7) / 2
                    )
                ) - 5;

            maxX =
                Math.max(
                    ...spots.map(
                        (spot) =>
                            Number(spot.x) +
                            (Number(spot.width) || 2.7) / 2
                    )
                ) + 5;

            minY =
                Math.min(
                    ...spots.map(
                        (spot) =>
                            Number(spot.y) -
                            (Number(spot.length) || 5.2) / 2
                    )
                ) - 6;

            maxY =
                Math.max(
                    ...spots.map(
                        (spot) =>
                            Number(spot.y) +
                            (Number(spot.length) || 5.2) / 2
                    )
                ) + 6;
        }

        const worldWidth =
            Math.max(
                1,
                maxX - minX
            );

        const worldHeight =
            Math.max(
                1,
                maxY - minY
            );

        /*
          Use almost the full display area. This is intentionally
          wider/bigger than the old view, while still keeping the whole
          selected floor/zone visible.
        */
        const paddingX = 18;
        const paddingY = 14;

        const fitScale =
            Math.min(
                Math.max(
                    1,
                    rect.width -
                    paddingX * 2
                ) /
                worldWidth,

                Math.max(
                    1,
                    rect.height -
                    paddingY * 2
                ) /
                worldHeight
            );

        state.camera.fitScale =
            Math.max(
                0.01,
                fitScale
            );

        state.camera.minScale =
            state.camera.fitScale;

        state.camera.maxScale =
            state.camera.fitScale;

        state.camera.centerX =
            (
                minX +
                maxX
            ) / 2;

        state.camera.centerY =
            (
                minY +
                maxY
            ) / 2;

        state.camera.scale =
            state.camera.fitScale;

        state.camera.initialized =
            true;

        scheduleDraw();
    }

    function scheduleDraw() {
        if (
            mapFrame !==
            null
        ) {
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

    function drawPolyline(
        ctx,
        points,
        options
    ) {
        if (
            !Array.isArray(points) ||
            points.length < 2
        ) {
            return;
        }

        ctx.save();

        ctx.strokeStyle =
            options.stroke;

        ctx.globalAlpha =
            options.alpha ?? 1;

        ctx.lineWidth =
            options.width ?? 1;

        ctx.lineCap =
            "round";

        ctx.lineJoin =
            "round";

        ctx.setLineDash(
            options.dash || []
        );

        ctx.beginPath();

        points.forEach(
            (point, index) => {
                const x =
                    Array.isArray(point)
                        ? point[0]
                        : point.x;

                const y =
                    Array.isArray(point)
                        ? point[1]
                        : point.y;

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
            (
                state.layout?.roads ||
                []
            ).filter(
                (road) =>
                    String(road.floor) ===
                    String(floor.id)
            );

        for (const road of roads) {
            const width =
                (
                    Number(
                        road.width
                    ) || 5.5
                ) *
                state.camera.scale;

            drawPolyline(
                ctx,
                road.points,
                {
                    stroke: "#13191c",
                    width:
                        width + 7,
                    alpha: 0.86
                }
            );

            drawPolyline(
                ctx,
                road.points,
                {
                    stroke: "#3b4449",
                    width,
                    alpha: 1
                }
            );

            drawPolyline(
                ctx,
                road.points,
                {
                    stroke: "#b2bbc0",
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
                    alpha: 0.2
                }
            );
        }
    }

    function drawZoneLabels(ctx) {
        const groups =
            new Map();

        for (
            const spot
            of selectedLayoutSpots()
        ) {
            const zone =
                spotZone(spot);

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
                1;

            const screen =
                worldToScreen(
                    x,
                    y
                );

            const text =
                `ZONE ${zone}`;

            ctx.save();

            ctx.font =
                "700 10px DM Sans, sans-serif";

            const width =
                ctx.measureText(
                    text
                ).width + 18;

            const height = 24;

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
                    screen.x -
                    width / 2,
                    screen.y -
                    height / 2,
                    width,
                    height,
                    12
                );
            }
            else {
                ctx.rect(
                    screen.x -
                    width / 2,
                    screen.y -
                    height / 2,
                    width,
                    height
                );
            }

            ctx.fill();
            ctx.stroke();

            ctx.fillStyle =
                "#b0b9bd";

            ctx.textAlign =
                "center";

            ctx.textBaseline =
                "middle";

            ctx.fillText(
                text,
                screen.x,
                screen.y
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
                item.x,
                item.y
            );

        const radius =
            Math.max(
                7,
                Math.min(
                    11,
                    state.camera.scale *
                    0.28
                )
            );

        ctx.save();

        ctx.fillStyle =
            "#171d21";

        ctx.strokeStyle =
            accent;

        ctx.lineWidth = 3;

        ctx.beginPath();

        ctx.arc(
            screen.x,
            screen.y,
            radius,
            0,
            Math.PI * 2
        );

        ctx.fill();
        ctx.stroke();

        ctx.fillStyle =
            accent;

        ctx.beginPath();

        ctx.arc(
            screen.x,
            screen.y,
            Math.max(
                2,
                radius * 0.25
            ),
            0,
            Math.PI * 2
        );

        ctx.fill();

        ctx.font =
            "700 9px DM Sans, sans-serif";

        ctx.fillStyle =
            "#f0f3f4";

        ctx.textAlign =
            "center";

        ctx.fillText(
            label,
            screen.x,
            screen.y -
            radius -
            10
        );

        ctx.restore();
    }

    function spotAccent(status) {
        return {
            FREE: "#5ad7a3",
            OCCUPIED: "#ff8d83",
            RESERVED: "#79a9ff",
            UNKNOWN: "#899399"
        }[status] || "#899399";
    }

    function drawParkingSpot(
        ctx,
        spot
    ) {
        const id =
            String(spot.id);

        const status =
            spotStatus(id);

        const accent =
            spotAccent(status);

        const center =
            worldToScreen(
                spot.x,
                spot.y
            );

        const width =
            (
                Number(
                    spot.width
                ) || 2.7
            ) *
            state.camera.scale;

        const length =
            (
                Number(
                    spot.length
                ) || 5.2
            ) *
            state.camera.scale;

        const rotation =
            (
                Number(
                    spot.rotation
                ) || 0
            ) *
            Math.PI /
            180;

        ctx.save();

        ctx.translate(
            center.x,
            center.y
        );

        ctx.rotate(
            rotation
        );

        ctx.fillStyle =
            status === "FREE"
                ? "#173b30"
                : status === "RESERVED"
                    ? "#20385f"
                    : status === "OCCUPIED"
                        ? "#4a2c2b"
                        : "#272d31";

        ctx.globalAlpha =
            status === "UNKNOWN"
                ? 0.55
                : 0.82;

        ctx.strokeStyle =
            accent;

        ctx.lineWidth =
            Math.max(
                1.3,
                width * 0.03
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
                Math.max(
                    2,
                    width * 0.08
                )
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
        ctx.stroke();

        const railHeight =
            Math.max(
                2,
                Math.min(
                    5,
                    length * 0.08
                )
            );

        ctx.globalAlpha = 0.95;
        ctx.fillStyle =
            accent;

        ctx.fillRect(
            -width * 0.34,
            length / 2 -
            railHeight,
            width * 0.68,
            railHeight
        );

        if (
            status === "OCCUPIED"
        ) {
            const carWidth =
                width * 0.56;

            const carLength =
                length * 0.62;

            ctx.globalAlpha = 0.84;
            ctx.fillStyle =
                "#c66e67";

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
                    Math.max(
                        2,
                        carWidth * 0.18
                    )
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
        }

        ctx.restore();

        if (
            width >= 16 &&
            length >= 25
        ) {
            ctx.save();

            ctx.font =
                `700 ${Math.max(
                    7,
                    Math.min(
                        12,
                        width * 0.37
                    )
                )}px Manrope, sans-serif`;

            ctx.fillStyle =
                "#edf1f2";

            ctx.globalAlpha =
                0.92;

            ctx.textAlign =
                "center";

            ctx.textBaseline =
                "middle";

            ctx.fillText(
                spotLabel(id),
                center.x,
                center.y
            );

            ctx.restore();
        }

        hitSpots.push({
            id,
            centerX:
                Number(spot.x),
            centerY:
                Number(spot.y),
            width:
                Number(
                    spot.width
                ) || 2.7,
            length:
                Number(
                    spot.length
                ) || 5.2,
            rotation:
                Number(
                    spot.rotation
                ) || 0
        });
    }

    function pointInSpot(
        world,
        hit
    ) {
        const angle =
            -hit.rotation *
            Math.PI /
            180;

        const dx =
            world.x -
            hit.centerX;

        const dy =
            world.y -
            hit.centerY;

        const localX =
            dx *
            Math.cos(angle) -
            dy *
            Math.sin(angle);

        const localY =
            dx *
            Math.sin(angle) +
            dy *
            Math.cos(angle);

        return (
            Math.abs(localX) <=
                hit.width / 2 &&
            Math.abs(localY) <=
                hit.length / 2
        );
    }

    function drawMap() {
        const canvas =
            ui.canvas;

        const rect =
            ui.viewport
                .getBoundingClientRect();

        const cssWidth =
            Math.max(
                1,
                rect.width
            );

        const cssHeight =
            Math.max(
                1,
                rect.height
            );

        const dpr =
            Math.min(
                2,
                window.devicePixelRatio ||
                1
            );

        const pixelWidth =
            Math.round(
                cssWidth *
                dpr
            );

        const pixelHeight =
            Math.round(
                cssHeight *
                dpr
            );

        if (
            canvas.width !==
                pixelWidth ||
            canvas.height !==
                pixelHeight
        ) {
            canvas.width =
                pixelWidth;

            canvas.height =
                pixelHeight;
        }

        const ctx =
            canvas.getContext(
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

        ctx.fillStyle =
            "#242a2e";

        ctx.fillRect(
            0,
            0,
            cssWidth,
            cssHeight
        );

        const floor =
            currentFloor();

        if (!floor) {
            return;
        }

        if (
            !state.camera.initialized
        ) {
            fitMap();
            return;
        }

        hitSpots.length = 0;

        drawRoads(
            ctx,
            floor
        );

        drawZoneLabels(ctx);

        for (
            const entrance of
            (
                state.layout
                    ?.entrances || []
            ).filter(
                (item) =>
                    String(item.floor) ===
                    String(floor.id)
            )
        ) {
            drawEntranceExit(
                ctx,
                entrance,
                "ENTRANCE",
                "#c8ef91"
            );
        }

        for (
            const exit of
            (
                state.layout
                    ?.exits || []
            ).filter(
                (item) =>
                    String(item.floor) ===
                    String(floor.id)
            )
        ) {
            drawEntranceExit(
                ctx,
                exit,
                "EXIT",
                "#a9b5b9"
            );
        }

        for (
            const spot of
            selectedLayoutSpots()
        ) {
            drawParkingSpot(
                ctx,
                spot
            );
        }

    }

    function selectSpot(id) {
        const live =
            state.spots[id];

        const spot =
            layoutSpot(id);

        if (
            !live ||
            !spot
        ) {
            return;
        }

        if (
            String(
                live.status
            ).toUpperCase() !==
            "FREE"
        ) {
            showToast(
                `${spotLabel(id)} is no longer available.`
            );

            return;
        }

        state.selectedSpotId =
            String(id);

        ui.selectedSpotLabel
            .textContent =
            spotLabel(id);

        ui.selectedSpotLocation
            .textContent =
            `${floorLabel(
                spot.floor
            )} · Zone ${
                spotZone(spot)
            }`;

        ui.reservationError.hidden =
            true;

        ui.reservationError
            .textContent = "";

        ui.reserveSelected.disabled =
            false;

        ui.reserveSelected.textContent =
            "Reserve this space";

        ui.spotDialog.hidden =
            false;

        setDialogOpen(true);

        ui.reserveSelected.focus();
    }

    function closeSpotDialog() {
        if (state.reserving) {
            return;
        }

        ui.spotDialog.hidden =
            true;

        if (
            ui.ticketDialog.hidden
        ) {
            setDialogOpen(false);
        }
    }

    function createQrCode(url) {
        ui.ticketQr.replaceChildren();

        if (
            typeof window.QRCode !==
            "function"
        ) {
            const fallback =
                document.createElement(
                    "div"
                );

            fallback.style.fontSize =
                "11px";

            fallback.style.lineHeight =
                "1.5";

            fallback.style.padding =
                "12px";

            fallback.style.overflowWrap =
                "anywhere";

            fallback.textContent =
                `QR renderer unavailable. Claim URL: ${url}`;

            ui.ticketQr.append(
                fallback
            );

            return;
        }

        new window.QRCode(
            ui.ticketQr,
            {
                text: url,
                width: 200,
                height: 200,
                correctLevel:
                    window.QRCode
                        .CorrectLevel.M
            }
        );
    }

    function stopTicketTimer() {
        clearInterval(
            ticketTimer
        );

        ticketTimer = null;
    }

    function updateTicketTimer() {
        ui.ticketScreenTimer
            .textContent =
            `${Math.max(
                0,
                ticketSecondsLeft
            )}s`;

        if (
            ticketSecondsLeft <= 0
        ) {
            closeTicket();
            return;
        }

        ticketSecondsLeft--;
    }

    function startTicketTimer() {
        stopTicketTimer();

        ticketSecondsLeft =
            TICKET_SCREEN_SECONDS;

        updateTicketTimer();

        ticketTimer =
            setInterval(
                updateTicketTimer,
                1000
            );
    }

    function showTicket(
        data,
        spot
    ) {
        state.ticket =
            data;

        ui.ticketSpot.textContent =
            spotLabel(
                data.spot_id
            );

        ui.ticketLocation.textContent =
            `${floorLabel(
                spot.floor
            )} · Zone ${
                spotZone(spot)
            }`;

        ui.ticketDirection.textContent =
            `Follow signs to ${floorLabel(
                spot.floor
            )} · Zone ${
                spotZone(spot)
            }`;

        ui.ticketReference.textContent =
            String(
                data.reservation_id
            )
                .slice(0, 8)
                .toUpperCase();

        const claimUrl =
            new URL(
                data.claim_url,
                window.location.origin
            ).href;

        createQrCode(
            claimUrl
        );

        ui.localhostWarning.hidden =
            !(
                window.location.hostname ===
                    "localhost" ||
                window.location.hostname ===
                    "127.0.0.1"
            );

        ui.spotDialog.hidden =
            true;

        ui.ticketDialog.hidden =
            false;

        setDialogOpen(true);

        startTicketTimer();

        ui.ticketDone.focus();
    }

    function closeTicket() {
        stopTicketTimer();

        ui.ticketDialog.hidden =
            true;

        ui.ticketQr.replaceChildren();

        state.ticket = null;

        state.selectedSpotId =
            null;

        setDialogOpen(false);

        refresh();
    }

    async function reserveSelectedSpot() {
        if (
            state.reserving ||
            !state.selectedSpotId
        ) {
            return;
        }

        const id =
            state.selectedSpotId;

        const live =
            state.spots[id];

        const spot =
            layoutSpot(id);

        if (
            !live ||
            !spot ||
            String(
                live.status
            ).toUpperCase() !==
            "FREE"
        ) {
            closeSpotDialog();

            showToast(
                `${spotLabel(id)} is no longer available.`
            );

            await refresh();
            return;
        }

        state.reserving =
            true;

        ui.reserveSelected.disabled =
            true;

        ui.reserveSelected.textContent =
            "Reserving…";

        ui.reservationError.hidden =
            true;

        try {
            const data =
                await api(
                    "/display/reserve",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json"
                        },
                        body:
                            JSON.stringify({
                                spot_id: id
                            })
                    }
                );

            await refresh();

            showTicket(
                data,
                spot
            );
        }
        catch (error) {
            ui.reservationError.hidden =
                false;

            ui.reservationError
                .textContent =
                error.message ||
                "Could not reserve this space.";

            await refresh();
        }
        finally {
            state.reserving =
                false;

            ui.reserveSelected.disabled =
                false;

            ui.reserveSelected.textContent =
                "Reserve this space";
        }
    }

    function render() {
        renderConnection();
        renderFilters();
        renderStats();

        ui.loading.hidden =
            state.layoutLoaded &&
            state.loaded;

        scheduleDraw();
    }

    async function loadLayout() {
        const layout =
            await api(
                "/layout"
            );

        state.layout =
            layout;

        state.layoutLoaded =
            true;

        if (
            !state.selectedFloor &&
            layout?.floors?.length
        ) {
            state.selectedFloor =
                String(
                    layout.floors[0].id
                );
        }
    }

    async function refresh() {
        if (pollPromise) {
            return pollPromise;
        }

        pollPromise =
            (async () => {
                try {
                    if (
                        !state.layoutLoaded
                    ) {
                        await loadLayout();
                    }

                    const spots =
                        await api(
                            "/spots"
                        );

                    state.spots =
                        spots || {};

                    state.loaded =
                        true;

                    state.online =
                        true;

                    render();

                    if (
                        !state.camera.initialized
                    ) {
                        requestAnimationFrame(
                            fitMap
                        );
                    }

                    ui.updated.textContent =
                        `Updated ${
                            new Date()
                                .toLocaleTimeString(
                                    [],
                                    {
                                        hour:
                                            "2-digit",
                                        minute:
                                            "2-digit"
                                    }
                                )
                        }`;
                }
                catch (error) {
                    console.error(
                        error
                    );

                    state.online =
                        false;

                    renderConnection();

                    if (
                        !state.loaded
                    ) {
                        ui.loading.hidden =
                            false;

                        ui.loading
                            .querySelector(
                                "p"
                            )
                            .textContent =
                            "Could not connect to the parking gateway.";
                    }
                }
                finally {
                    pollPromise =
                        null;
                }
            })();

        return pollPromise;
    }

    ui.viewport
        .addEventListener(
            "click",
            (event) => {
                /*
                  The entrance display map itself never pans or zooms.
                  A tap is only used to select an available parking bay.
                */
                if (
                    !state.loaded ||
                    !state.layoutLoaded
                ) {
                    return;
                }

                const world =
                    screenToWorld(
                        event.clientX,
                        event.clientY
                    );

                const hit =
                    hitSpots
                        .slice()
                        .reverse()
                        .find(
                            (spot) =>
                                pointInSpot(
                                    world,
                                    spot
                                )
                        );

                if (hit) {
                    selectSpot(
                        hit.id
                    );
                }
            }
        );

    ui.spotDialogClose
        .addEventListener(
            "click",
            closeSpotDialog
        );

    ui.spotDialogBack
        .addEventListener(
            "click",
            closeSpotDialog
        );

    ui.reserveSelected
        .addEventListener(
            "click",
            reserveSelectedSpot
        );

    ui.ticketDone
        .addEventListener(
            "click",
            closeTicket
        );

    /*
      Clicking the dark backdrop also closes the selection dialog.
      Clicking the white card itself does not.
    */
    ui.spotDialog
        .addEventListener(
            "click",
            (event) => {
                if (
                    event.target ===
                    ui.spotDialog
                ) {
                    closeSpotDialog();
                }
            }
        );

    ui.ticketDialog
        .addEventListener(
            "click",
            (event) => {
                if (
                    event.target ===
                    ui.ticketDialog
                ) {
                    closeTicket();
                }
            }
        );

    window.addEventListener(
        "resize",
        () => {
            if (
                state.layoutLoaded
            ) {
                fitMap();
            }
        }
    );

    document.addEventListener(
        "keydown",
        (event) => {
            if (
                event.key ===
                "Escape"
            ) {
                if (
                    !ui.ticketDialog
                        .hidden
                ) {
                    closeTicket();
                }
                else if (
                    !ui.spotDialog
                        .hidden
                ) {
                    closeSpotDialog();
                }
            }
        }
    );

    refresh();

    pollTimer =
        setInterval(
            refresh,
            POLL_INTERVAL
        );
})();
