from fastapi import APIRouter, HTTPException
import traci
import logging

router = APIRouter(prefix="/api", tags=["simulation"])
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# HELPER — safe SUMO check
# ─────────────────────────────────────────────
def is_sumo_running() -> bool:
    """
    Vérifie si SUMO est actif sans lever d'exception.
    traci.isLoaded() est plus fiable que getMinExpectedNumber()
    qui plante si SUMO n'est pas encore démarré.
    """
    try:
        return traci.isLoaded()
    except Exception:
        return False


# ─────────────────────────────────────────────
# HEALTH
# ─────────────────────────────────────────────
@router.get("/health")
async def health():
    return {
        "status":      "OK",
        "sumo_loaded": is_sumo_running(),
    }


# ─────────────────────────────────────────────
# ALL VEHICLES
# ─────────────────────────────────────────────
@router.get("/simulation/vehicles")
async def get_vehicles():
    """
    Retourne la liste des véhicules actifs dans SUMO.
    Retourne count=0 si SUMO n'est pas démarré (pas de 500).
    """
    if not is_sumo_running():
        # SUMO pas encore démarré — réponse vide, pas d'erreur
        return {"vehicles": [], "count": 0, "sumo_running": False}

    try:
        vehicles = list(traci.vehicle.getIDList())
        return {
            "vehicles":     vehicles,
            "count":        len(vehicles),
            "sumo_running": True,
        }
    except Exception as e:
        logger.error(f"get_vehicles error: {e}")
        # Ne pas lever 500 — retourner vide pour ne pas spammer Diagnostic
        return {"vehicles": [], "count": 0, "sumo_running": False}


# ─────────────────────────────────────────────
# SINGLE VEHICLE
# ─────────────────────────────────────────────
@router.get("/simulation/vehicle/{vehicle_id}")
async def get_vehicle(vehicle_id: str):
    if not is_sumo_running():
        raise HTTPException(status_code=503, detail="SUMO non démarré")

    try:
        if vehicle_id not in traci.vehicle.getIDList():
            raise HTTPException(status_code=404, detail=f"Véhicule '{vehicle_id}' non trouvé")

        x, y   = traci.vehicle.getPosition(vehicle_id)
        speed  = traci.vehicle.getSpeed(vehicle_id)
        angle  = traci.vehicle.getAngle(vehicle_id)

        # Convertir en GPS si possible
        try:
            lon, lat = traci.simulation.convertGeo(x, y)
        except Exception:
            lat, lon = None, None

        return {
            "id":       vehicle_id,
            "position": {"x": round(x, 2), "y": round(y, 2)},
            "gps":      {"lat": lat, "lng": lon} if lat is not None else None,
            "speed":    round(speed * 3.6, 2),
            "heading":  round(angle, 1),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"get_vehicle error: {e}")
        raise HTTPException(status_code=500, detail=str(e))