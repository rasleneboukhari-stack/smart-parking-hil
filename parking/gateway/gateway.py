from paho.mqtt import client as mqtt
import json
import time
import threading
import uuid
from fastapi import FastAPI
import uvicorn
from pydantic import BaseModel
from fastapi import HTTPException
import sqlite3
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
from hil_simulation_api import  router as hil_simulation_router
app = FastAPI()
app.include_router(hil_simulation_router)
app.mount(
    "/static",
    StaticFiles(directory="frontend"),
    name="static"
)

DB_FILE = "parking.db"

zones = {}

ZONE_OFFLINE_TIMEOUT = 15  # seconds

PROJECT_ROOT = Path(__file__).resolve().parent.parent

LAYOUT_FILE = (
        PROJECT_ROOT
        / "layouts"
        / "parking_layout.json"
)


def load_parking_layout():

    with open(
            LAYOUT_FILE,
            "r",
            encoding="utf-8"
    ) as file:

        layout = json.load(file)

    print(
        f"[LAYOUT] Loaded "
        f"{layout['name']}"
    )

    return layout


parking_layout = load_parking_layout()

class ReserveRequest(BaseModel):
    spot_id: str

class MoveRequest(BaseModel):
    new_spot_id: str

class ParkedElsewhereRequest(BaseModel):
    spot_id: str
# ============================================================
#                      MQTT CONFIG
# ============================================================

BROKER_HOST = "broker.hivemq.com"
BROKER_PORT = 1883
TOPIC = "raslene/parking/#"


# ============================================================
#                      RESERVATION STATES
# ============================================================

ACTIVE = "ACTIVE"
AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"
COMPLETED = "COMPLETED"
EXPIRED = "EXPIRED"
CANCELLED = "CANCELLED"

RESERVATION_TIMEOUT = 300


# ============================================================
#                      PARKING STATE
# ============================================================

layout_spots = {
    spot["id"]: spot
    for spot in parking_layout["spots"]
}


spots = {
    spot_id: {
        "distance": 0,
        "physical_state": "FREE",
        "reservation_id": None,
        "sensor_health": "UNKNOWN"
    }

    for spot_id in layout_spots
}

reservations = {}

# ============================================================
#                      SQL
# ============================================================

def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    cursor.execute("""
                   CREATE TABLE IF NOT EXISTS spots (
                        spot_id TEXT PRIMARY KEY,
                        physical_state TEXT NOT NULL,
                        distance REAL,
                        reservation_id TEXT
                   )
                   """)

    cursor.execute("""
                   CREATE TABLE IF NOT EXISTS reservations (
                       reservation_id TEXT PRIMARY KEY,
                       spot_id TEXT NOT NULL,
                       status TEXT NOT NULL,
                       created_at REAL NOT NULL,
                       claim_token TEXT,
                       parked_spot_id TEXT
                   )
                   """)

    cursor.execute("""
        PRAGMA table_info(reservations)
    """)

    columns = [
        row[1]
        for row in cursor.fetchall()
    ]

    if "claim_token" not in columns:
        cursor.execute("""
                       ALTER TABLE reservations
                           ADD COLUMN claim_token TEXT
                       """)

    if "parked_spot_id" not in columns:
        cursor.execute("""
                       ALTER TABLE reservations
                           ADD COLUMN parked_spot_id TEXT
                       """)


    conn.commit()
    conn.close()


def load_state_from_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    # Load reservations
    cursor.execute("""
                   SELECT
                       reservation_id,
                       spot_id,
                       status,
                       created_at,
                       claim_token,
                       parked_spot_id
                   FROM reservations
                   """)

    for (
            reservation_id,
            spot_id,
            status,
            created_at,
            claim_token,
            parked_spot_id
    ) in cursor.fetchall():

        reservations[reservation_id] = {
            "spot_id": spot_id,
            "status": status,
            "created_at": created_at,
            "claim_token": claim_token,
            "parked_spot_id": parked_spot_id
        }

    # Load spots
    cursor.execute("""
                   SELECT spot_id, physical_state, distance, reservation_id
                   FROM spots
                   """)

    for spot_id, physical_state, distance, reservation_id in cursor.fetchall():

        if spot_id in spots:
            spots[spot_id]["physical_state"] = physical_state
            spots[spot_id]["distance"] = distance
            spots[spot_id]["reservation_id"] = reservation_id

    conn.close()

    print("[DB] State loaded")


def save_spot(spot_id):
    spot = spots[spot_id]

    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    cursor.execute(
        """
        INSERT OR REPLACE INTO spots
        (spot_id, physical_state, distance, reservation_id)
        VALUES (?, ?, ?, ?)
        """,
        (
            spot_id,
            spot["physical_state"],
            spot["distance"],
            spot["reservation_id"]
        )
    )

    conn.commit()
    conn.close()


def save_reservation(reservation_id):
    reservation = reservations[reservation_id]

    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    cursor.execute(
        """
        INSERT OR REPLACE INTO reservations
        (
            reservation_id,
            spot_id,
            status,
            created_at,
            claim_token,
            parked_spot_id
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            reservation_id,
            reservation["spot_id"],
            reservation["status"],
            reservation["created_at"],
            reservation["claim_token"],
            reservation.get("parked_spot_id")
        )
    )

    conn.commit()
    conn.close()
# ============================================================
#                      APP
# ============================================================


@app.get("/spots")
def get_status():

    return {
        spot_id: {
            "physical_state":
                spot["physical_state"],

            "status":
                get_spot_status(spot_id),

            "reservation_id":
                spot["reservation_id"],

            "floor":
                layout_spots[spot_id]["floor"],

            "zone":
                layout_spots[spot_id]["zone"]
        }

        for spot_id, spot
        in spots.items()
    }


@app.post("/reserve")
def reserve(request: ReserveRequest):

    if request.spot_id not in spots:
        raise HTTPException(
            status_code=404,
            detail="Spot not found"
        )

    reservation_id = reserve_spot(request.spot_id)

    if reservation_id is None:
        raise HTTPException(
            status_code=400,
            detail="Spot is not available"
        )

    return {
        "reservation_id": reservation_id,
        "spot_id": request.spot_id,
        "status": ACTIVE
    }

@app.get("/reservation/{reservation_id}")
def get_reservation(reservation_id: str):

    if reservation_id not in reservations:
        raise HTTPException(
            status_code=404,
            detail="Reservation not found"
        )

    reservation = reservations[reservation_id]

    return {
        "reservation_id": reservation_id,
        "spot_id": reservation["spot_id"],
        "parked_spot_id": reservation.get("parked_spot_id"),
        "status": reservation["status"]
    }

@app.post("/reservation/{reservation_id}/confirm")
def confirm_reservation(reservation_id: str):

    if reservation_id not in reservations:
        raise HTTPException(
            status_code=404,
            detail="Reservation not found"
        )

    if not confirm_own_car(reservation_id):
        raise HTTPException(
            status_code=400,
            detail="Reservation cannot be confirmed"
        )

    return {
        "reservation_id": reservation_id,
        "status": COMPLETED
    }

@app.post("/reservation/{reservation_id}/move")
def move_reservation_api(
        reservation_id: str,
        request: MoveRequest
):

    if reservation_id not in reservations:
        raise HTTPException(
            status_code=404,
            detail="Reservation not found"
        )

    if request.new_spot_id not in spots:
        raise HTTPException(
            status_code=404,
            detail="Spot not found"
        )

    if not move_reservation(
            reservation_id,
            request.new_spot_id
    ):
        raise HTTPException(
            status_code=400,
            detail="Reservation cannot be moved"
        )

    return {
        "reservation_id": reservation_id,
        "spot_id": request.new_spot_id,
        "status": ACTIVE
    }


@app.post("/reservation/{reservation_id}/parked-elsewhere")
def parked_elsewhere_api(
        reservation_id: str,
        request: ParkedElsewhereRequest
):

    if reservation_id not in reservations:
        raise HTTPException(
            status_code=404,
            detail="Reservation not found"
        )

    if request.spot_id not in spots:
        raise HTTPException(
            status_code=404,
            detail="Spot not found"
        )

    if not confirm_parked_elsewhere(
            reservation_id,
            request.spot_id
    ):
        raise HTTPException(
            status_code=400,
            detail="This occupied spot cannot be linked to your car"
        )

    reservation = reservations[reservation_id]

    return {
        "reservation_id": reservation_id,
        "spot_id": reservation["spot_id"],
        "parked_spot_id": reservation.get("parked_spot_id"),
        "status": COMPLETED
    }


@app.post("/reservation/{reservation_id}/cancel")
def cancel_reservation_api(reservation_id: str):

    if reservation_id not in reservations:
        raise HTTPException(
            status_code=404,
            detail="Reservation not found"
        )

    if not cancel_reservation(reservation_id):
        raise HTTPException(
            status_code=400,
            detail="Reservation cannot be cancelled"
        )

    return {
        "reservation_id": reservation_id,
        "status": CANCELLED
    }
@app.post("/display/reserve")
def display_reserve(request: ReserveRequest):

    if request.spot_id not in spots:
        raise HTTPException(
            status_code=404,
            detail="Spot not found"
        )

    reservation_id = reserve_spot(
        request.spot_id
    )

    if reservation_id is None:
        raise HTTPException(
            status_code=400,
            detail="Spot is not available"
        )

    claim_token = str(uuid.uuid4())

    reservations[reservation_id][
        "claim_token"
    ] = claim_token

    save_reservation(reservation_id)

    return {
        "reservation_id": reservation_id,
        "spot_id": request.spot_id,
        "status": ACTIVE,
        "claim_token": claim_token,
        "claim_url":
            f"/claim/{claim_token}"
    }

@app.get(
    "/claim/{claim_token}",
    response_class=HTMLResponse
)
def claim_reservation(
        claim_token: str
):

    reservation_id = None

    for rid, reservation in reservations.items():

        if (
                reservation["claim_token"]
                == claim_token
        ):
            reservation_id = rid
            break

    if reservation_id is None:
        raise HTTPException(
            status_code=404,
            detail="Invalid or expired ticket"
        )

    reservation = reservations[
        reservation_id
    ]


    if reservation["status"] not in (
            ACTIVE,
            AWAITING_CONFIRMATION
    ):
        raise HTTPException(
            status_code=400,
            detail="Reservation is no longer active"
        )

    # Make QR one-time use
    reservation["claim_token"] = None

    save_reservation(
        reservation_id
    )

    return f"""
    <!DOCTYPE html>

    <html>
    <body>

    <script>

        localStorage.setItem(
            "reservation_id",
            "{reservation_id}"
        );

        window.location.href = "/";

    </script>

    </body>
    </html>
    """

# ============================================================
#                      HTML
# ============================================================

@app.get("/")
def parking_page():
    return FileResponse("frontend/index.html")

@app.get("/display")
def entrance_display():
    return FileResponse("frontend/display.html")

@app.get("/layout")
def get_layout():

    return parking_layout

@app.get("/simulator")
def simulator_page():
    return FileResponse("frontend/simulator.html")

# ============================================================
#                      SPOT STATUS
# ============================================================

def get_spot_status(spot_id):

    spot = spots[spot_id]

    # Physical sensor always has priority
    if spot["physical_state"] == "OCCUPIED":
        return "OCCUPIED"

    reservation_id = spot["reservation_id"]

    if reservation_id is not None:

        reservation = reservations[reservation_id]

        if reservation["status"] in (
                ACTIVE,
                AWAITING_CONFIRMATION
        ):
            return "RESERVED"

    return "FREE"



def check_zone_heartbeats():

    while True:

        now = time.monotonic()

        for zone_id, zone in zones.items():

            if (
                    zone["status"] == "ONLINE"
                    and now - zone["last_seen"] > ZONE_OFFLINE_TIMEOUT
            ):
                zone["status"] = "OFFLINE"

                print(f"[ZONE {zone_id}] OFFLINE")
                for spot_id, spot in spots.items():

                    if spot.get("zone_id") == zone_id:
                        spot["physical_state"] = "UNKNOWN"
                        save_spot(spot_id)

        time.sleep(1)

# ============================================================
#                      CREATE RESERVATION
# ============================================================

def reserve_spot(spot_id):

    if get_spot_status(spot_id) != "FREE":
        return None

    reservation_id = str(uuid.uuid4())

    reservations[reservation_id] = {
        "spot_id": spot_id,
        "status": ACTIVE,
        "created_at": time.time(),
        "claim_token":None,
        "parked_spot_id": None
    }

    spots[spot_id]["reservation_id"] = reservation_id
    save_reservation(reservation_id)
    save_spot(spot_id)

    print(
        f"[GATEWAY] {spot_id}: RESERVED "
        f"({reservation_id})"
    )

    return reservation_id


# ============================================================
#                      RESERVATION TIMEOUT
# ============================================================

def check_reservations():

    now = time.time()

    for reservation_id, reservation in reservations.items():

        if reservation["status"] not in (
                ACTIVE,
                AWAITING_CONFIRMATION
        ):
            continue

        if now - reservation["created_at"] >= RESERVATION_TIMEOUT:

            reservation["status"] = EXPIRED
            reservation["claim_token"] = None

            spot_id = reservation["spot_id"]

            # Make sure this spot still belongs to this reservation
            if spots[spot_id]["reservation_id"] == reservation_id:
                spots[spot_id]["reservation_id"] = None


            save_reservation(reservation_id)
            save_spot(spot_id)

            print(
                f"[GATEWAY] {reservation_id}: EXPIRED"
            )


def reservation_loop():

    while True:
        check_reservations()
        time.sleep(1)


# ============================================================
#                      USER CONFIRMATION
# ============================================================

def confirm_own_car(reservation_id):

    reservation = reservations[reservation_id]

    if reservation["status"] != AWAITING_CONFIRMATION:
        return False

    spot_id = reservation["spot_id"]

    reservation["status"] = COMPLETED
    reservation["parked_spot_id"] = spot_id


    save_reservation(reservation_id)
    save_spot(spot_id)

    print(
        f"[GATEWAY] {reservation_id}: COMPLETED"
    )

    return True


def confirm_parked_elsewhere(reservation_id, parked_spot_id):

    reservation = reservations[reservation_id]

    if reservation["status"] != AWAITING_CONFIRMATION:
        return False

    if parked_spot_id not in spots:
        return False

    # The user can only claim a bay where a car is physically present.
    if spots[parked_spot_id]["physical_state"] != "OCCUPIED":
        return False

    reserved_spot_id = reservation["spot_id"]

    # Saying "not my car" means the original reservation no longer
    # belongs to that occupied bay. Release it, but do NOT overwrite
    # parked_spot_id.reservation_id: that bay may be reserved by
    # somebody else, which is exactly the conflict this flow handles.
    if spots[reserved_spot_id]["reservation_id"] == reservation_id:
        spots[reserved_spot_id]["reservation_id"] = None
        save_spot(reserved_spot_id)

    reservation["status"] = COMPLETED
    reservation["parked_spot_id"] = parked_spot_id

    save_reservation(reservation_id)

    print(
        f"[GATEWAY] {reservation_id}: parked elsewhere "
        f"at {parked_spot_id}"
    )

    return True


def move_reservation(reservation_id, new_spot_id):

    reservation = reservations[reservation_id]

    # Only move when we're waiting for the user's answer
    if reservation["status"] != AWAITING_CONFIRMATION:
        return False

    # New spot must actually be available
    if get_spot_status(new_spot_id) != "FREE":
        return False

    old_spot_id = reservation["spot_id"]

    # Remove reservation from old spot
    if spots[old_spot_id]["reservation_id"] == reservation_id:
        spots[old_spot_id]["reservation_id"] = None

    # Attach same reservation to new spot
    spots[new_spot_id]["reservation_id"] = reservation_id

    reservation["spot_id"] = new_spot_id
    reservation["status"] = ACTIVE
    reservation["created_at"] = time.time()
    reservation["parked_spot_id"] = None


    save_reservation(reservation_id)
    save_spot(old_spot_id)
    save_spot(new_spot_id)

    print(
        f"[GATEWAY] Reservation {reservation_id}: "
        f"{old_spot_id} -> {new_spot_id}"
    )

    return True


def cancel_reservation(reservation_id):

    reservation = reservations[reservation_id]

    if reservation["status"] not in (
            ACTIVE,
            AWAITING_CONFIRMATION
    ):
        return False

    spot_id = reservation["spot_id"]

    reservation["status"] = CANCELLED
    reservation["claim_token"] = None
    reservation["parked_spot_id"] = None

    if spots[spot_id]["reservation_id"] == reservation_id:
        spots[spot_id]["reservation_id"] = None


    save_reservation(reservation_id)
    save_spot(spot_id)

    print(
        f"[GATEWAY] Reservation {reservation_id}: CANCELLED"
    )

    return True



# ============================================================
#                      MQTT CALLBACKS
# ============================================================

def on_connect(
        client,
        userdata,
        flags,
        reason_code,
        properties
):

    print(
        f"[GATEWAY] Connected to MQTT broker: "
        f"{reason_code}"
    )

    client.subscribe(TOPIC)

    print(
        f"[GATEWAY] Subscribed to: {TOPIC}"
    )


def on_message(client, userdata, msg):

    try:
        data = json.loads(msg.payload.decode("utf-8"))
    except json.JSONDecodeError:
        print("[GATEWAY] Invalid JSON")
        return

    parts = msg.topic.split("/")

    # =========================
    # HEARTBEAT
    # =========================
    # raslene/parking/zone-1/heartbeat
# raslene/parking/zone-1/heartbeat
    if len(parts) == 4 and parts[3] == "heartbeat":

        zone_id = data["zone_id"]

        previous_status = zones.get(zone_id, {}).get("status")

        zones[zone_id] = {
            "last_seen": time.monotonic(),
            "status": "ONLINE"
        }

        if previous_status != "ONLINE":
            print(f"[ZONE {zone_id}] ONLINE")

        return


    # =========================
    # SENSOR HEALTH
    # =========================
    # raslene/parking/zone-1/spot-4/health
    if len(parts) == 5 and parts[4] == "health":

        spot_id = data["spot_id"]
        health = data["sensor_health"]   # "OK" or "FAULT"

        if spot_id not in spots:
            return

        spots[spot_id]["sensor_health"] = health

        if health == "FAULT":
            spots[spot_id]["physical_state"] = "UNKNOWN"

        save_spot(spot_id)

        print(f"[{spot_id}] sensor health: {health}")
        return


    # =========================
    # NORMAL TELEMETRY
    # =========================
    # raslene/parking/zone-1/spot-4
    if len(parts) != 4:
        return

    spot_id = data["spot_id"]

    if spot_id not in spots:
        return

    spot = spots[spot_id]

    old_physical_state = spot["physical_state"]
    new_physical_state = data["status"]
    spot["zone_id"] = data["zone_id"]
    spot["distance"] = data["distance"]
    spot["physical_state"] = new_physical_state

    save_spot(spot_id)

    # --------------------------------------------------------
    # RESERVED SPOT BECAME PHYSICALLY OCCUPIED
    # --------------------------------------------------------

    reservation_id = spot["reservation_id"]

    if reservation_id is not None:

        reservation = reservations[reservation_id]

        # Reserved spot became occupied
        if (
                reservation["status"] == ACTIVE
                and old_physical_state == "FREE"
                and new_physical_state == "OCCUPIED"
        ):
            reservation["status"] = AWAITING_CONFIRMATION
            save_reservation(reservation_id)

            print(
                f"[GATEWAY] {spot_id}: "
                f"-> AWAITING_CONFIRMATION"
            )

            return

        # User didn't answer, but the spot became free again
        if (
                reservation["status"] == AWAITING_CONFIRMATION
                and old_physical_state == "OCCUPIED"
                and new_physical_state == "FREE"
        ):
            reservation["status"] = ACTIVE
            save_reservation(reservation_id)

            print(
                f"[GATEWAY] {spot_id}: "
                f"FREE again -> reservation ACTIVE"
            )

            return

        if reservation_id is not None:

            reservation = reservations[reservation_id]

            if (
                    reservation["status"] == COMPLETED
                    and old_physical_state == "OCCUPIED"
                    and new_physical_state == "FREE"
            ):
                spot["reservation_id"] = None
                save_spot(spot_id)

                print(
                    f"[GATEWAY] {spot_id}: "
                    f"car left -> completed reservation detached"
                )

                return


    print(
        f"[GATEWAY] {spot_id}: "
        f"{get_spot_status(spot_id)}"
    )


# ============================================================
#                          MAIN
# ============================================================

def main():
    init_db()
    load_state_from_db()

    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id="parking"
    )

    client.on_connect = on_connect
    client.on_message = on_message

    print("[GATEWAY] Starting")

    client.connect(
        BROKER_HOST,
        BROKER_PORT
    )

    threading.Thread(
        target=reservation_loop,
        daemon=True
    ).start()

    client.loop_start()
    threading.Thread(
        target=check_zone_heartbeats,
        daemon=True
    ).start()
    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()