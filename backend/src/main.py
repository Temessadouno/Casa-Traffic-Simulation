import asyncio
import socketio
import traci
import os
import traceback
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

from src.services.PersistenceService import PersistenceService
from src.services.SafetyAIService import SafetyAIService
from src.services.SumoEngineService import SumoEngineService
from src.api.routes import router as api_router

load_dotenv()

# ─────────────────────────────────────────────
# 1. APP SETUP
# ─────────────────────────────────────────────
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
fastapi_app = FastAPI(title="TMT Traffic Control — Casablanca")

fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

fastapi_app.include_router(api_router)

# ─────────────────────────────────────────────
# 2. MONGODB
# ─────────────────────────────────────────────
MONGO_URI     = os.getenv("MONGO_URI",     "mongodb://mongodb:27017")
DATABASE_NAME = os.getenv("DATABASE_NAME", "traffic_simulation")
client = AsyncIOMotorClient(MONGO_URI)
db     = client[DATABASE_NAME]

# ─────────────────────────────────────────────
# 3. SERVICES
# ─────────────────────────────────────────────
persistence = PersistenceService(db)
safety      = SafetyAIService(sio)
sumo_engine = SumoEngineService(persistence, safety)

# ─────────────────────────────────────────────
# 4. SUMO CONFIG
# ─────────────────────────────────────────────
SUMO_RUNNING     = False
SUMO_ORIGINAL_CWD = os.getcwd()

if os.path.exists("/app/data"):
    SUMO_DATA_DIR = "/app/data"
elif os.path.exists("data"):
    SUMO_DATA_DIR = os.path.abspath("data")
else:
    SUMO_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

SUMO_CONFIG_FILE = "casa.sumocfg"

# ─────────────────────────────────────────────
# 5. STARTUP
# ─────────────────────────────────────────────
@fastapi_app.on_event("startup")
async def startup_db_client():
    try:
        await db.list_collection_names()
        print("✅ Connexion MongoDB établie.")
        await db.traffic_logs.create_index([("timestamp", -1)])
    except Exception as e:
        print(f"❌ Erreur de connexion DB: {e}")

# ─────────────────────────────────────────────
# 6. STATUS
# ─────────────────────────────────────────────
@fastapi_app.get("/status")
async def status():
    is_loaded = False
    try:
        is_loaded = traci.isLoaded()
    except Exception:
        pass
    return {"sumo_running": SUMO_RUNNING, "sumo_loaded": is_loaded}

# ─────────────────────────────────────────────
# 7. START SIMULATION
# ─────────────────────────────────────────────
@fastapi_app.post("/simulation/start")
async def start_simulation():
    global SUMO_RUNNING, SUMO_ORIGINAL_CWD

    print(f"\n[DEBUG] Starting SUMO at {datetime.now()}")

    # Close previous instance
    try:
        if traci.isLoaded():
            traci.close()
            await asyncio.sleep(1)
    except Exception as e:
        print(f"Cleanup error: {e}")

    try:
        config_path = os.path.join(SUMO_DATA_DIR, SUMO_CONFIG_FILE)
        if not os.path.exists(config_path):
            raise FileNotFoundError(f"Config non trouvée: {config_path}")

        net_file   = os.path.join(SUMO_DATA_DIR, "casa.net.xml")
        route_file = os.path.join(SUMO_DATA_DIR, "casa.rou.xml")

        if not os.path.exists(net_file):
            raise FileNotFoundError(f"Network file not found: {net_file}")
        if not os.path.exists(route_file):
            raise FileNotFoundError(f"Route file not found: {route_file}")

        print(f"Using config : {config_path}")
        print(f"Network file : {net_file}")
        print(f"Route file   : {route_file}")

        SUMO_ORIGINAL_CWD = os.getcwd()
        os.chdir(SUMO_DATA_DIR)

        traci.start([
            "sumo",
            "-c", SUMO_CONFIG_FILE,
            "--step-length",      "0.1",
            "--time-to-teleport", "-1",
            "--no-warnings",
            "--no-step-log",
        ])

        await asyncio.sleep(2)

        if not traci.isLoaded():
            raise Exception("SUMO failed to load")

        # Warm-up steps
        for _ in range(3):
            traci.simulationStep()

        vehicles = traci.vehicle.getIDList()
        print(f"Vehicles in simulation: {vehicles}")

        SUMO_RUNNING = True
        print("✅ SUMO started successfully")

        await sio.emit("simulation_status", {"status": "started"})
        return {
            "message":  "SUMO démarré",
            "status":   "started",
            "vehicles": list(vehicles),
        }

    except Exception as e:
        print(f"[ERROR] {traceback.format_exc()}")
        try:
            os.chdir(SUMO_ORIGINAL_CWD)
        except Exception:
            pass
        SUMO_RUNNING = False
        raise HTTPException(status_code=500, detail=str(e))

# ─────────────────────────────────────────────
# 8. STOP SIMULATION
# ─────────────────────────────────────────────
@fastapi_app.post("/simulation/stop")
async def stop_simulation():
    global SUMO_RUNNING
    try:
        traci.close()
    except Exception:
        pass
    SUMO_RUNNING = False
    try:
        if os.getcwd() != SUMO_ORIGINAL_CWD:
            os.chdir(SUMO_ORIGINAL_CWD)
    except Exception:
        pass
    await sio.emit("simulation_status", {"status": "stopped"})
    return {"message": "Simulation arrêtée", "status": "stopped"}

# ─────────────────────────────────────────────
# 9. BROADCAST ALL VEHICLES (global view)
# ─────────────────────────────────────────────
async def broadcast_all_vehicles():
    """
    Emits all_vehicles_state every step so MapGlobal can display
    every vehicle in the SUMO simulation in real time.
    """
    try:
        if not traci.isLoaded():
            return

        vehicles = traci.vehicle.getIDList()
        snapshot = {}

        for vid in vehicles:
            try:
                x, y = traci.vehicle.getPosition(vid)
                try:
                    lon, lat = traci.simulation.convertGeo(x, y)
                except Exception:
                    lat = 33.5731 + (y / 111320)
                    lon = -7.5898 + (x / 111320)

                snapshot[vid] = {
                    "lat":     lat,
                    "lng":     lon,
                    "speed":   round(traci.vehicle.getSpeed(vid) * 3.6, 2),
                    "heading": traci.vehicle.getAngle(vid),
                }
            except Exception:
                continue

        await sio.emit("all_vehicles_state", {"vehicles": snapshot})

    except Exception as e:
        print(f"broadcast_all_vehicles error: {e}")

# ─────────────────────────────────────────────
# 10. BROADCAST NEARBY VEHICLES (solo view)
# ─────────────────────────────────────────────
async def broadcast_nearby_vehicles(ego_id: str, sid: str):
    """
    Finds vehicles on the same edge/route as ego and emits them
    so MapSolo can display them alongside the tracked vehicle.
    """
    try:
        if not traci.isLoaded():
            return

        if ego_id not in traci.vehicle.getIDList():
            return

        ego_edge    = traci.vehicle.getRoadID(ego_id)
        ego_route   = set(traci.vehicle.getRoute(ego_id))
        all_vehicles = traci.vehicle.getIDList()

        nearby = {}

        for vid in all_vehicles:
            if vid == ego_id:
                continue
            try:
                v_edge  = traci.vehicle.getRoadID(vid)
                v_route = set(traci.vehicle.getRoute(vid))

                # Same edge OR overlapping routes
                if v_edge != ego_edge and len(ego_route & v_route) == 0:
                    continue

                x, y = traci.vehicle.getPosition(vid)
                try:
                    lon, lat = traci.simulation.convertGeo(x, y)
                except Exception:
                    lat = 33.5731 + (y / 111320)
                    lon = -7.5898 + (x / 111320)

                nearby[vid] = {
                    "lat":     lat,
                    "lng":     lon,
                    "speed":   round(traci.vehicle.getSpeed(vid) * 3.6, 2),
                    "heading": traci.vehicle.getAngle(vid),
                }
            except Exception:
                continue

        await sio.emit("nearby_vehicles", {"vehicles": nearby}, room=sid)

    except Exception as e:
        print(f"broadcast_nearby_vehicles error: {e}")

# ─────────────────────────────────────────────
# 11. SOCKET — START JOURNEY
# ─────────────────────────────────────────────
@sio.on("start_journey")
async def handle_start(sid, data):
    global SUMO_RUNNING

    if not SUMO_RUNNING:
        await sio.emit(
            "system_error",
            {"msg": "Démarrez SUMO via le bouton Play d'abord."},
            room=sid,
        )
        return

    # ── FIX: always use "ego" ──
    journey_id  = f"trip_{int(datetime.now().timestamp())}"
    origin      = data.get("origin")      or {"lat": 33.5731, "lng": -7.5898}
    destination = data.get("destination") or {"lat": 33.5744, "lng": -7.5897}

    print(f"Starting journey: {journey_id}")
    await persistence.create_journey(journey_id, origin, destination)

    try:
        if not traci.isLoaded():
            await sio.emit(
                "system_error",
                {"msg": "SUMO n'est pas connecté"},
                room=sid,
            )
            return
    except Exception as e:
        await sio.emit("system_error", {"msg": f"Erreur TraCI: {e}"}, room=sid)
        return

    await asyncio.sleep(1)

    # Create ego vehicle — passe les coordonnées GPS pour le mapping edge SUMO
    route = sumo_engine.compute_and_set_route(origin, destination)
    print(f"Route result: {route}")
    if not route:
        await sio.emit(
            "system_error",
            {"msg": "Route introuvable. Utilisation d'une route par défaut."},
            room=sid,
        )

    await asyncio.sleep(1)

    try:
        steps_without_vehicle = 0
        max_steps             = 2000

        for step in range(max_steps):
            try:
                is_active = await sumo_engine.simulate_step(journey_id, sio, sid)

                if not is_active:
                    steps_without_vehicle += 1
                    if steps_without_vehicle > 100:
                        print("Vehicle lost, stopping simulation")
                        break
                else:
                    steps_without_vehicle = 0
                    if step % 100 == 0:
                        print(f"Step {step}: Simulation active")

                # Broadcast ALL vehicles for global map
                await broadcast_all_vehicles()

                # Broadcast nearby vehicles for solo map
                await broadcast_nearby_vehicles(sumo_engine.vehicle_id, sid)

                # Safety check
                await safety.check_proximity_risk(
                    sumo_engine.vehicle_id,
                    None,  # GeoPoint not needed; TraCI used internally
                )

                await asyncio.sleep(0.1)

            except Exception as step_error:
                print(f"Step error: {step_error}")
                break

        await persistence.finalize_journey(journey_id)
        await sio.emit("journey_end", {"msg": "Arrivée à destination !"}, room=sid)
        print(f"Journey {journey_id} completed")

    except Exception as e:
        print(f"Erreur simulation: {e}")
        traceback.print_exc()
        await sio.emit("system_error", {"msg": f"Erreur: {e}"}, room=sid)

# ─────────────────────────────────────────────
# 12. REST — JOURNEYS
# ─────────────────────────────────────────────
@fastapi_app.get("/journeys")
async def get_journeys():
    journeys = []
    async for doc in db.journeys.find({}, {"_id": 0}).sort("start_time", -1).limit(20):
        journeys.append(doc)
    return {"journeys": journeys}

@fastapi_app.get("/journeys/{journey_id}")
async def get_journey(journey_id: str):
    # Journey metadata
    doc = await db.journeys.find_one({"journey_id": journey_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Journey not found")

    # Trajectory steps
    steps = []
    async for s in db.traffic_logs.find(
        {"journey_id": journey_id},
        {"_id": 0}
    ).sort("timestamp", 1).limit(1000):
        steps.append(s)

    doc["steps"] = steps
    return doc

# ─────────────────────────────────────────────
# 13. ASGI APP
# ─────────────────────────────────────────────
app = socketio.ASGIApp(sio, fastapi_app)