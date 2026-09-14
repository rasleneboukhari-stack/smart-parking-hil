import time
from typing import Dict

from fastapi import APIRouter
from pydantic import BaseModel


router = APIRouter()


# ============================================================
#                 DATA SENT BY THE SIMULATOR
# ============================================================

class HILDistanceFrame(BaseModel):
    version: int = 1
    zone_id: int
    sequence: int
    sent_at_ms: int
    distances_cm: Dict[str, float]


# ============================================================
#                 LATEST DISTANCE FRAME
# ============================================================

latest_distances = {
    "ready": False,
    "version": 1,
    "zone_id": None,
    "sequence": 0,
    "sent_at_ms": 0,
    "received_at": 0,
    "distances_cm": {}
}


# ============================================================
#           FRONTEND -> GATEWAY
# ============================================================

@router.post("/simulator/hil/distances")
def receive_distances(frame: HILDistanceFrame):

    latest_distances["ready"] = True
    latest_distances["version"] = frame.version
    latest_distances["zone_id"] = frame.zone_id
    latest_distances["sequence"] = frame.sequence
    latest_distances["sent_at_ms"] = frame.sent_at_ms

    latest_distances["received_at"] = time.time()

    latest_distances["distances_cm"] = (
        frame.distances_cm.copy()
    )

    return {
        "ok": True,
        "sequence": frame.sequence
    }


# ============================================================
#           GATEWAY -> HIL BRIDGE
# ============================================================

@router.get("/simulator/hil/distances")
def get_distances():

    return latest_distances