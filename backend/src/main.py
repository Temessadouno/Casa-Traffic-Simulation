# /app/main.py  — VERSION CORRIGÉE
#
# Corrections appliquées :
#   FIX A — warm-up accidents : exclure les IDs "_b" de _acc_expected
#   FIX B — reset ACTIVE_JOURNEY_ID = None au démarrage
#   FIX C — guards "if ACTIVE_JOURNEY_ID" dans la boucle broadcast
#   FIX D — reset ACTIVE_JOURNEY_ID = None à l'arrêt
#

import asyncio
import socketio
import traci
import os
import sys
import traceback
from fastapi import FastAPI, HTTPException, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, timezone
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

load_dotenv()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ============================================================
# IMPORTS
# ============================================================
try:
    from src.services.PersistenceService import PersistenceService
    logger.info("✅ PersistenceService importé")
except ImportError as e:
    logger.error(f"❌ Erreur import PersistenceService: {e}")
    PersistenceService = None

try:
    from src.services.SafetyAIService import SafetyAIService
    logger.info("✅ SafetyAIService importé")
except ImportError as e:
    logger.error(f"❌ Erreur import SafetyAIService: {e}")
    SafetyAIService = None

try:
    from src.services.SumoEngineService import SumoEngineService, TrafficPredictionService
    logger.info("✅ SumoEngineService importé")
except ImportError as e:
    logger.error(f"❌ Erreur import SumoEngineService: {e}")
    SumoEngineService = None
    TrafficPredictionService = None

try:
    from src.api.routes import router as api_router
    logger.info("✅ API routes importées")
except ImportError as e:
    logger.error(f"❌ Erreur import routes: {e}")
    api_router = None

try:
    from src.services.GenerateService import GenerateService
    logger.info("✅ GenerateService importé")
except ImportError as e:
    logger.error(f"❌ Erreur import GenerateService: {e}")
    GenerateService = None

try:
    from src.services.ScenarioConfigService import ScenarioConfigService
    logger.info("✅ ScenarioConfigService importé")
except ImportError as e:
    logger.error(f"❌ Erreur import ScenarioConfigService: {e}")
    ScenarioConfigService = None

try:
    from src.services.LSTMTrainService import LSTMTrainService
    from src.services.LSTMPredictorService import LSTMPredictorService
    logger.info("✅ LSTM services importés")
except ImportError as e:
    logger.warning(f"⚠️ LSTM non disponible (tensorflow manquant ?): {e}")
    LSTMTrainService     = None
    LSTMPredictorService = None

# ============================================================
# 1. APP SETUP
# ============================================================
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    ping_timeout=60,       # 60s avant déconnexion (défaut=20s trop court)
    ping_interval=25,      # ping toutes les 25s
    max_http_buffer_size=1_000_000,
)
fastapi_app = FastAPI(title="TMT Traffic Control — Casablanca with AI Predictions")

fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if api_router:
    fastapi_app.include_router(api_router)

# ============================================================
# 2. MONGODB
# ============================================================
MONGO_URI     = os.getenv("MONGO_URI",     "mongodb://mongodb:27017")
DATABASE_NAME = os.getenv("DATABASE_NAME", "traffic_simulation")

db     = None
client = None

try:
    client = AsyncIOMotorClient(MONGO_URI)
    db     = client[DATABASE_NAME]
    client.admin.command('ping')
    logger.info("✅ Connexion MongoDB établie")
except Exception as e:
    logger.error(f"❌ Erreur configuration MongoDB: {e}")
    db     = None
    client = None

# ============================================================
# 3. SERVICES
# ============================================================
persistence = None
if db is not None and PersistenceService is not None:
    try:
        persistence = PersistenceService(db)
        logger.info("✅ PersistenceService initialisé")
    except Exception as e:
        logger.error(f"❌ Erreur initialisation PersistenceService: {e}")

safety = None
if SafetyAIService is not None:
    try:
        safety = SafetyAIService(sio, persistence)
        logger.info("✅ SafetyAIService initialisé")
    except Exception as e:
        logger.error(f"❌ Erreur initialisation SafetyAIService: {e}")

MODEL_PATH         = os.getenv("MODEL_PATH", None)
prediction_service = None
if MODEL_PATH and os.path.exists(MODEL_PATH) and TrafficPredictionService:
    try:
        prediction_service = TrafficPredictionService(MODEL_PATH, persistence)
        logger.info(f"✅ Modèle IA chargé depuis {MODEL_PATH}")
    except Exception as e:
        logger.warning(f"⚠️ Impossible de charger le modèle IA: {e}")

sumo_engine = None
if SumoEngineService is not None:
    try:
        sumo_engine = SumoEngineService(persistence, safety, prediction_service)
        logger.info("✅ SumoEngineService initialisé")
    except Exception as e:
        logger.error(f"❌ Erreur initialisation SumoEngineService: {e}")

# ── LSTM services ──────────────────────────────────────────────────────────
lstm_predictor = LSTMPredictorService() if LSTMPredictorService else None
lstm_training  = False
if lstm_predictor:
    logger.info("✅ LSTMPredictorService initialisé")

# ============================================================
# 4. SUMO CONFIG + ÉTAT GLOBAL
# ============================================================
SUMO_RUNNING      = False
SUMO_STEP_DELAY   = 0.0
SUMO_EXTRA_STEPS  = 0
SUMO_ORIGINAL_CWD = os.getcwd()

ACCIDENT_STATES: dict  = {}
BREAKDOWN_STATES: dict = {}
BREAKDOWN_THRESHOLD    = 40
SUMO_PAUSED            = False   # True = boucle tourne mais SUMO ne step plus

# FIX B + FIX D : toujours initialisé à None
ACTIVE_JOURNEY_ID  = None
ACTIVE_JOURNEY_SID = None

SUMO_DATA_DIR = os.getenv("SUMO_DATA_DIR", "/app/maps")
if not os.path.exists(SUMO_DATA_DIR):
    possible_paths = [
        "/app/maps",
        os.path.join(os.path.dirname(__file__), "maps"),
        os.path.join(os.path.dirname(__file__), "..", "maps"),
        os.path.join(os.getcwd(), "maps"),
    ]
    for path in possible_paths:
        if os.path.exists(path):
            SUMO_DATA_DIR = path
            break
    else:
        SUMO_DATA_DIR = os.path.join(os.path.dirname(__file__), "maps")
        os.makedirs(SUMO_DATA_DIR, exist_ok=True)

SUMO_CONFIG_FILE = os.getenv("SUMO_CONFIG_FILE", "casa.sumocfg")

logger.info(f"📁 SUMO data directory: {SUMO_DATA_DIR}")
logger.info(f"📄 SUMO config file: {SUMO_CONFIG_FILE}")

generate_service = None
if GenerateService is not None:
    try:
        generate_service = GenerateService(sumo_data_dir=SUMO_DATA_DIR)
        logger.info("✅ GenerateService initialisé")
    except Exception as e:
        logger.error(f"❌ Erreur initialisation GenerateService: {e}")

scenario_config = None
if ScenarioConfigService is not None:
    try:
        scenario_config = ScenarioConfigService(sumo_data_dir=SUMO_DATA_DIR)
        logger.info(f"✅ ScenarioConfigService initialisé — actif: {scenario_config.get_active_scenario_id() or 'défaut'}")
    except Exception as e:
        logger.error(f"❌ Erreur initialisation ScenarioConfigService: {e}")

# ============================================================
# 5. BROADCAST HELPERS
# ============================================================

async def broadcast_all_vehicles() -> dict:
    """
    Avance SUMO d'un step, émet all_vehicles_state.
    Retourne toujours un dict (jamais None).
    """
    try:
        if not traci.isLoaded():
            return {}

        vehicles   = traci.vehicle.getIDList()
        snapshot   = {}
        pedestrians = {}

        for vid in vehicles:
            try:
                is_accident = vid.startswith("accident_")

                if not hasattr(broadcast_all_vehicles, "_known"):
                    broadcast_all_vehicles._known = set()
                if vid not in broadcast_all_vehicles._known:
                    broadcast_all_vehicles._known.add(vid)
                    if not is_accident:
                        try:
                            traci.vehicle.setSpeedFactor(vid, 1.2)
                        except Exception:
                            pass

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

        # Piétons
        try:
            for pid in traci.person.getIDList():
                try:
                    px, py = traci.person.getPosition(pid)
                    try:
                        plon, plat = traci.simulation.convertGeo(px, py)
                    except Exception:
                        plat = 33.5731 + (py / 111320)
                        plon = -7.5898 + (px / 111320)
                    pedestrians[pid] = {
                        "lat":     plat,
                        "lng":     plon,
                        "speed":   round(traci.person.getSpeed(pid) * 3.6, 2),
                        "heading": traci.person.getAngle(pid),
                    }
                except Exception:
                    continue
        except Exception:
            pass

        await sio.emit("all_vehicles_state", {
            "vehicles":   snapshot,
            "pedestrians": pedestrians,
        })
        return snapshot

    except Exception as e:
        logger.warning(f"broadcast_all_vehicles error: {e}")
        return {}


async def broadcast_nearby_vehicles(ego_id: str, sid: str):
    try:
        if not traci.isLoaded():
            return
        if ego_id not in traci.vehicle.getIDList():
            return

        ego_edge  = traci.vehicle.getRoadID(ego_id)
        ego_route = set(traci.vehicle.getRoute(ego_id))
        nearby    = {}

        for vid in traci.vehicle.getIDList():
            if vid == ego_id:
                continue
            try:
                v_edge  = traci.vehicle.getRoadID(vid)
                v_route = set(traci.vehicle.getRoute(vid))
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
        logger.warning(f"broadcast_nearby_vehicles error: {e}")


# ============================================================
# 6. BOUCLE DE BROADCAST
# ============================================================

async def simulation_broadcast_loop():
    global SUMO_RUNNING, ACTIVE_JOURNEY_ID
    logger.info("🔄 Boucle broadcast démarrée")
    step_counter = 0

    while True:
        if SUMO_RUNNING:
            try:
                if not traci.isLoaded():
                    logger.warning("simulation_broadcast_loop: TraCI non connecté, arrêt.")
                    SUMO_RUNNING = False
                    BREAKDOWN_STATES.clear()
                    await sio.emit("simulation_status", {"status": "stopped"})
                    await asyncio.sleep(0.1)
                    continue

                # ── PAUSE : on diffuse l'état mais SUMO ne step pas ──────────
                if SUMO_PAUSED:
                    snapshot = await broadcast_all_vehicles()
                    await asyncio.sleep(0.1)
                    continue

                # Steps SUMO (accélération ×2 ×5)
                for _ in range(SUMO_EXTRA_STEPS):
                    traci.simulationStep()
                traci.simulationStep()
                step_counter += 1

                # Broadcast toujours défini
                snapshot = await broadcast_all_vehicles()
                vehicles = list(snapshot.keys())

                # ── ACCIDENTS : mise à jour positions + véhicules bloqués (1/step)
                if ACCIDENT_STATES and step_counter % 5 == 0:
                    try:
                        acc_update = []
                        for acc_id, acc_info in ACCIDENT_STATES.items():
                            acc_edge = acc_info.get("edge", "")
                            blocked  = []

                            # Essayer de récupérer la position GPS si pas encore connue
                            # FIX : vérifier que le véhicule est dans la sim avant tout appel TraCI
                            if acc_info.get("lat") is None and acc_id in traci.vehicle.getIDList():
                                try:
                                    x, y = traci.vehicle.getPosition(acc_id)
                                    lon, lat = traci.simulation.convertGeo(x, y)
                                    ACCIDENT_STATES[acc_id]["lat"]  = lat
                                    ACCIDENT_STATES[acc_id]["lng"]  = lon
                                    ACCIDENT_STATES[acc_id]["edge"] = traci.vehicle.getRoadID(acc_id)
                                    logger.info(f"📍 Accident {acc_id} localisé : {lat:.5f},{lon:.5f}")
                                except Exception:
                                    pass

                            # Véhicules bloqués — seulement si l'accident est localisé
                            if acc_info.get("edge"):
                                for vid in vehicles:
                                    if vid == acc_id or vid.startswith("accident_"):
                                        continue
                                    try:
                                        v_edge = traci.vehicle.getRoadID(vid)
                                        v_speed = traci.vehicle.getSpeed(vid)
                                        v_wait  = traci.vehicle.getWaitingTime(vid)
                                        if v_edge == acc_edge and (v_speed < 0.5 or v_wait > 5):
                                            blocked.append(vid)
                                    except Exception:
                                        continue

                            ACCIDENT_STATES[acc_id]["blocked"] = blocked
                            acc_update.append({
                                "id":            acc_id,
                                "lat":           acc_info.get("lat"),
                                "lng":           acc_info.get("lng"),
                                "cause":         acc_info.get("cause", "inconnu"),
                                "edge":          acc_info.get("edge", ""),
                                "blocked_count": len(blocked),
                                "blocked_ids":   blocked[:5],
                            })

                        # Émettre tous les accidents (y compris sans GPS pour l'instant)
                        if acc_update:
                            await sio.emit("accidents_state", {"accidents": acc_update})
                    except Exception as acc_err:
                        logger.debug(f"accident update error: {acc_err}")

                # ── PANNES : véhicules bloqués hors feu rouge ─────────────
                if step_counter % 3 == 0:
                    try:
                        for _vid in list(snapshot.keys()):
                            if _vid.startswith("accident_"):
                                continue
                            _v   = snapshot[_vid]
                            _spd = _v.get("speed", 999)

                            if _spd <= 0.5:
                                _at_tls = False
                                try:
                                    _next_tls = traci.vehicle.getNextTLS(_vid)
                                    if _next_tls:
                                        _dist_tls = _next_tls[0][2]
                                        _state    = _next_tls[0][3]
                                        if _dist_tls < 15 and _state.lower() in ("r", "y", "u"):
                                            _at_tls = True
                                except Exception:
                                    pass

                                if not _at_tls:
                                    if _vid not in BREAKDOWN_STATES:
                                        BREAKDOWN_STATES[_vid] = {
                                            "waiting_since": step_counter,
                                            "lat":           _v["lat"],
                                            "lng":           _v["lng"],
                                            "notified":      False,
                                        }
                                    elif not BREAKDOWN_STATES[_vid]["notified"]:
                                        waited = step_counter - BREAKDOWN_STATES[_vid]["waiting_since"]
                                        if waited >= BREAKDOWN_THRESHOLD:
                                            BREAKDOWN_STATES[_vid]["notified"] = True
                                            await sio.emit("emergency_alert", {
                                                "vehicle_id": _vid,
                                                "title":      "Panne détectée",
                                                "message":    f"Véhicule {_vid} immobilisé depuis {waited} steps (~{waited//2}s) hors feu rouge",
                                                "severity":   "warning",
                                                "risk_level": "warning",
                                                "lat":        _v["lat"],
                                                "lng":        _v["lng"],
                                                "event":      "BREAKDOWN",
                                                "timestamp":  datetime.utcnow().isoformat(),
                                            })
                                            logger.info(f"🔧 Panne : {_vid} bloqué {waited} steps")
                            else:
                                if _vid in BREAKDOWN_STATES:
                                    del BREAKDOWN_STATES[_vid]
                    except Exception as _bd_err:
                        logger.debug(f"breakdown detect: {_bd_err}")

                # ── PERSISTENCE : position ego ────────────────────────────
                # FIX C : guard ACTIVE_JOURNEY_ID is not None
                if ACTIVE_JOURNEY_ID and persistence and sumo_engine:
                    ego_id   = sumo_engine.vehicle_id
                    ego_data = snapshot.get(ego_id)
                    if ego_data:
                        try:
                            from src.models.trafficAiModels import TrajectoryPoint, GeoPoint
                            point = TrajectoryPoint(
                                timestamp=datetime.utcnow(),
                                coords=GeoPoint(lat=ego_data["lat"], lng=ego_data["lng"]),
                                speed=ego_data["speed"],
                                heading=ego_data["heading"],
                            )
                            # Fire-and-forget → ne bloque pas la boucle broadcast
                            asyncio.create_task(persistence.save_step(ACTIVE_JOURNEY_ID, point))
                            await sio.emit("vehicle_state", {
                                "id":      ego_id,
                                "lat":     ego_data["lat"],
                                "lng":     ego_data["lng"],
                                "speed":   ego_data["speed"],
                                "heading": ego_data["heading"],
                            })
                        except Exception as ego_err:
                            logger.debug(f"ego persist error: {ego_err}")

                # ── MÉTRIQUES + ANOMALIES (toutes les 10 steps) ──────────
                # FIX C : guard ACTIVE_JOURNEY_ID
                if step_counter % 20 == 0 and sumo_engine and ACTIVE_JOURNEY_ID:
                    try:
                        metrics = sumo_engine.collect_traffic_metrics()
                        for metric in metrics.values():
                            # Push LSTM (pas de DB — non bloquant)
                            if lstm_predictor:
                                lstm_predictor.push_metrics(metric.segment_id, {
                                    "average_speed": metric.average_speed,
                                    "vehicle_count": metric.vehicle_count,
                                    "density":       metric.density,
                                    "occupancy":     metric.occupancy,
                                })
                            anomaly = sumo_engine.detect_anomalies(metric)
                            if anomaly:
                                # Sauvegarder anomalie en fire-and-forget (pas d'await bloquant)
                                if persistence:
                                    asyncio.create_task(
                                        persistence.save_anomaly(ACTIVE_JOURNEY_ID, anomaly)
                                    )
                                await sio.emit("road_alert", {
                                    "segment_id":    anomaly.segment_id,
                                    "severity":      anomaly.severity,
                                    "deviation":     round(anomaly.deviation, 2),
                                    "anomaly_score": round(anomaly.anomaly_score, 2),
                                    "title":         f"Anomalie — {anomaly.segment_id[:12]}",
                                    "message":       f"Déviation {anomaly.deviation:.1f}σ sur {anomaly.segment_id}",
                                    "risk_level":    anomaly.severity,
                                    "timestamp":     datetime.utcnow().isoformat(),
                                })
                        # Sauvegarder métriques en batch toutes les 100 steps (fire-and-forget)
                        if step_counter % 100 == 0 and persistence:
                            batch = list(metrics.values())[:20]  # max 20 segments
                            async def _save_batch(b):
                                for m in b:
                                    try: await persistence.save_traffic_metrics(m)
                                    except: pass
                            asyncio.create_task(_save_batch(batch))
                    except Exception as metrics_err:
                        logger.debug(f"metrics error: {metrics_err}")

                # ── PRÉDICTIONS LSTM (toutes les 30 steps) ───────────────
                if step_counter % 30 == 0 and lstm_predictor and lstm_predictor.is_ready:
                    try:
                        lstm_preds = await lstm_predictor.predict_all(top_n=20)
                        if lstm_preds:
                            await sio.emit("lstm_predictions", {"predictions": lstm_preds})
                    except Exception as _lp_err:
                        logger.debug(f"lstm predict error: {_lp_err}")

                # ── PRÉDICTIONS SMA (toutes les 60 steps) ────────────────────
                # FIX C : guard ACTIVE_JOURNEY_ID
                if step_counter % 60 == 0 and sumo_engine and ACTIVE_JOURNEY_ID and persistence:
                    try:
                        active_segments = list(sumo_engine.segment_metrics.keys())[:10]
                        if active_segments:
                            preds = await sumo_engine.predict_traffic(active_segments)
                            for pred in preds:
                                await persistence.save_prediction(ACTIVE_JOURNEY_ID, pred)
                                await sio.emit("traffic_prediction", {
                                    "segment_id":            pred.segment_id,
                                    "predicted_speed":       pred.predicted_speed,
                                    "confidence_score":      pred.confidence_score,
                                    "prediction_horizon":    pred.prediction_horizon.value,
                                    "predicted_travel_time": pred.predicted_travel_time,
                                    "predicted_volume":      pred.predicted_volume,
                                    "confidence_lower":      pred.confidence_lower,
                                    "confidence_upper":      pred.confidence_upper,
                                })
                    except Exception as pred_err:
                        logger.debug(f"prediction error: {pred_err}")

                # ── SÉCURITÉ : détection collision ego (throttlé) ──────────────────────
                # FIX : check_proximity_risk ne tourne que si journey actif
                # Throttle 1/5 steps → évite assertion SUMO vNext >= vMin
                if safety and sumo_engine and ACTIVE_JOURNEY_ID and step_counter % 20 == 0:
                    ego_id   = sumo_engine.vehicle_id
                    ego_data = snapshot.get(ego_id)
                    if ego_data:
                        try:
                            from src.models.trafficAiModels import GeoPoint as _GP
                            _pos = _GP(lat=ego_data["lat"], lng=ego_data["lng"])
                        except Exception:
                            _pos = None
                        # Fire-and-forget → ne bloque pas la boucle
                        asyncio.create_task(safety.check_proximity_risk(ego_id, _pos))

            except Exception as e:
                err_str = str(e)
                if "Connection closed" in err_str or "not connected" in err_str.lower():
                    logger.warning("⚠️ SUMO fermé (fin de simulation) — arrêt propre")
                else:
                    logger.error(f"❌ simulation_broadcast_loop error: {e}")
                SUMO_RUNNING = False
                BREAKDOWN_STATES.clear()
                try:
                    traci.close()
                except Exception:
                    pass
                await sio.emit("simulation_status", {"status": "stopped", "reason": err_str[:80]})

        await asyncio.sleep(0.05)  # 20fps → mouvement fluide comme SUMO-GUI


# ============================================================
# 7. STARTUP / SHUTDOWN
# ============================================================

@fastapi_app.on_event("startup")
async def startup_db_client():
    global db, client
    if client is not None and db is not None:
        try:
            await db.list_collection_names()
            logger.info("✅ Connexion MongoDB vérifiée")
            if persistence:
                try:
                    await persistence.create_indexes()
                except Exception as e:
                    logger.warning(f"⚠️ Erreur création index: {e}")
        except Exception as e:
            logger.error(f"❌ Erreur de connexion DB: {e}")
    else:
        logger.warning("⚠️ MongoDB non configuré")

    asyncio.create_task(simulation_broadcast_loop())
    logger.info("✅ Boucle broadcast planifiée")


@fastapi_app.on_event("shutdown")
async def shutdown_event():
    logger.info("Arrêt de l'application...")
    if sumo_engine:
        try:
            sumo_engine.cleanup()
        except Exception as e:
            logger.warning(f"Erreur cleanup sumo_engine: {e}")
    try:
        if traci.isLoaded():
            traci.close()
    except Exception as e:
        logger.warning(f"Erreur fermeture traci: {e}")
    if client:
        client.close()
    logger.info("✅ Application arrêtée")


# ============================================================
# 8. HEALTH CHECK
# ============================================================

@fastapi_app.get("/")
async def root():
    return {
        "message": "TMT Traffic Control API",
        "version": "2.1.0",
        "status":  "running",
        "services": {
            "persistence": persistence is not None,
            "safety":      safety is not None,
            "sumo_engine": sumo_engine is not None,
            "ai_enabled":  prediction_service is not None,
            "mongodb":     db is not None,
        }
    }


@fastapi_app.get("/health")
async def health_check():
    mongodb_status = False
    if db is not None:
        try:
            await db.command("ping")
            mongodb_status = True
        except Exception:
            pass
    return {
        "status":      "healthy",
        "timestamp":   datetime.utcnow().isoformat(),
        "mongodb":     mongodb_status,
        "sumo_loaded": traci.isLoaded() if sumo_engine else False,
    }


@fastapi_app.get("/status")
async def status():
    is_loaded = False
    try:
        is_loaded = traci.isLoaded()
    except Exception:
        pass
    engine_stats = {}
    if sumo_engine is not None and SUMO_RUNNING:
        try:
            engine_stats = sumo_engine.get_traffic_statistics()
        except Exception as e:
            logger.error(f"Erreur stats: {e}")
    return {
        "sumo_running":      SUMO_RUNNING,
        "sumo_loaded":       is_loaded,
        "ai_enabled":        prediction_service is not None,
        "active_journey_id": ACTIVE_JOURNEY_ID,
        "engine_stats":      engine_stats,
    }


# ============================================================
# 9. SIMULATION ENDPOINTS
# ============================================================

@fastapi_app.post("/simulation/start")
async def start_simulation():
    # FIX B : déclarer ACTIVE_JOURNEY_ID global et le remettre à None
    global SUMO_RUNNING, SUMO_ORIGINAL_CWD, ACTIVE_JOURNEY_ID, SUMO_PAUSED

    logger.info(f"Starting SUMO at {datetime.now()}")

    if sumo_engine is None:
        raise HTTPException(status_code=500, detail="SumoEngineService non disponible")

    # FIX B : reset du journey pour éviter pollution entre sessions
    ACTIVE_JOURNEY_ID = None

    # Fermer l'instance précédente si nécessaire
    try:
        if traci.isLoaded():
            traci.close()
            await asyncio.sleep(1.5)
    except Exception as e:
        logger.warning(f"Cleanup error: {e}")
    # FIX : forcer la fermeture de toute connexion TraCI résiduelle
    try:
        import traci.connection as _tc
        for label in list(traci._connections.keys()):
            try:
                traci.switch(label)
                traci.close()
            except Exception:
                pass
    except Exception:
        pass
    await asyncio.sleep(0.5)

    try:
        # Résolution du chemin via ScenarioConfigService
        if scenario_config is not None:
            validation = scenario_config.validate()
            active_dir = scenario_config.get_active_dir()
            if not validation["valid"]:
                raise FileNotFoundError(
                    f"Fichiers manquants dans '{active_dir}': {validation['missing']}"
                )
            config_path = scenario_config.get_config_path()
            net_file    = scenario_config.get_net_path()
            route_file  = scenario_config.get_rou_path()
            logger.info(f"Scénario actif : {scenario_config.get_active_scenario_id() or 'défaut'}")
        else:
            config_path = os.path.join(SUMO_DATA_DIR, SUMO_CONFIG_FILE)
            net_file    = os.path.join(SUMO_DATA_DIR, "casa.net.xml")
            route_file  = os.path.join(SUMO_DATA_DIR, "casa.rou.xml")

        if not os.path.exists(config_path):
            raise FileNotFoundError(f"Config non trouvée: {config_path}")
        if not os.path.exists(net_file):
            raise FileNotFoundError(f"Network file not found: {net_file}")
        if not os.path.exists(route_file):
            raise FileNotFoundError(f"Route file not found: {route_file}")

        active_dir = os.path.dirname(config_path)
        logger.info(f"Using config : {config_path}")

        # Patcher le sumocfg (uniquement pour les scénarios générés)
        if scenario_config is not None:
            scenario_config.patch_sumocfg(config_path)

        try:
            SUMO_ORIGINAL_CWD = os.getcwd()
        except FileNotFoundError:
            SUMO_ORIGINAL_CWD = os.path.dirname(os.path.abspath(__file__))
            logger.warning(f"CWD introuvable, fallback: {SUMO_ORIGINAL_CWD}")

        os.chdir(active_dir)

        cfg_name = os.path.basename(config_path)
        # SUMO_GUI=1 dans docker-compose pour activer sumo-gui
        sumo_binary = "sumo-gui" if os.getenv("SUMO_GUI", "0") == "1" else "sumo"
        logger.info(f"Lancement SUMO : {sumo_binary}")
        traci.start([
            sumo_binary,
            "-c",                          cfg_name,
            "--step-length",               "0.1",   # 0.1s = 10 positions/sec comme SUMO-GUI
            "--default.speeddev",          "0.1",
            "--time-to-teleport",          "30",    # 30s max bloqué → téléport rapide
            "--time-to-teleport.highways", "-1",
            "--ignore-route-errors",       "true",
            "--collision.action",          "warn",  # warn = pas de téléport brutal
            "--end",                       "86400",
            "--no-warnings",
            "--no-step-log",
            "--error-log",                 "/tmp/sumo_errors.log",
        ])

        await asyncio.sleep(2)

        if not traci.isLoaded():
            raise Exception("SUMO failed to load")

        # ── FIX A : lire les accidents PRINCIPAUX uniquement ────────────────
        # Les véhicules "_b" (secondaires) sont exclus de _acc_expected
        # pour que la condition _acc_seen >= _acc_expected soit correcte.
        global ACCIDENT_STATES
        ACCIDENT_STATES = {}

        try:
            import xml.etree.ElementTree as _ET
            _rou_path = scenario_config.get_rou_path() if scenario_config else route_file
            _rou_tree = _ET.parse(_rou_path)

            for _veh in _rou_tree.getroot().findall(".//vehicle"):
                _vid = _veh.get("id", "")
                # FIX A : exclure les ID secondaires "_b"
                if not _vid.startswith("accident_") or _vid.endswith("_b"):
                    continue
                _parts = _vid.split("_")
                _cause = _parts[1] if len(_parts) >= 3 else "inconnu"
                _route_id = _veh.get("route", "")
                _edge = ""
                for _r in _rou_tree.getroot().findall(".//route"):
                    if _r.get("id") == _route_id:
                        _edge = (_r.get("edges") or "").split()[0]
                        break
                ACCIDENT_STATES[_vid] = {
                    "id":            _vid,
                    "lat":           None,
                    "lng":           None,
                    "cause":         _cause,
                    "blocked":       [],
                    "blocked_count": 0,
                    "edge":          _edge,
                }
            logger.info(f"📋 {len(ACCIDENT_STATES)} accident(s) principaux lus depuis {_rou_path}")
        except Exception as _xml_err:
            logger.warning(f"Lecture .rou.xml accidents: {_xml_err}")

        # ── Warm-up : attendre que les accidents principaux entrent ─────────
        _acc_expected = set(ACCIDENT_STATES.keys())
        _acc_seen     = set()

        for _step in range(150):  # 150 steps × 0.5s = 75s simulées → accidents depart≤15s
            traci.simulationStep()
            _vids = set(traci.vehicle.getIDList())

            for _vid in (_vids & _acc_expected) - _acc_seen:
                _acc_seen.add(_vid)
                try:
                    _x, _y = traci.vehicle.getPosition(_vid)
                    try:
                        _lon, _lat = traci.simulation.convertGeo(_x, _y)
                    except Exception:
                        _lat = 33.5731 + (_y / 111320)
                        _lon = -7.5898 + (_x / 111320)
                    ACCIDENT_STATES[_vid]["lat"]  = _lat
                    ACCIDENT_STATES[_vid]["lng"]  = _lon
                    ACCIDENT_STATES[_vid]["edge"] = traci.vehicle.getRoadID(_vid)
                    logger.info(
                        f"  ✅ Accident : {_vid} ({ACCIDENT_STATES[_vid]['cause']}) "
                        f"@ {_lat:.5f},{_lon:.5f}"
                    )
                except Exception as _pe:
                    logger.warning(f"Position accident {_vid}: {_pe}")

            if _acc_seen >= _acc_expected and _acc_expected:
                logger.info(f"Tous les accidents ({len(_acc_seen)}) entrés après {_step + 1} steps")
                break

            # Pour les scénarios sans accident, 5 steps suffisent
            if _step >= 4 and not _acc_expected:
                break

        # Émettre l'état initial des accidents (avec GPS)
        # FIX : émettre TOUS les accidents, même sans GPS (le frontend les ignorera
        # s'ils n'ont pas de lat/lng, mais ceux qui en ont seront visibles)
        acc_emit = [
            {**info, "id": vid, "blocked_count": 0, "blocked_ids": []}
            for vid, info in ACCIDENT_STATES.items()
        ]
        acc_with_gps = [a for a in acc_emit if a.get("lat") is not None]
        if acc_emit:
            await sio.emit("accidents_state", {"accidents": acc_emit})
            logger.info(f"🚨 {len(acc_with_gps)}/{len(ACCIDENT_STATES)} accidents émis ({len(acc_with_gps)} avec GPS)")
        if len(acc_with_gps) == 0 and ACCIDENT_STATES:
            logger.warning("⚠️ Aucun accident avec GPS — depart trop tardif ou edge introuvable")

        # Appliquer speedFactor sur les véhicules normaux
        vehicles = traci.vehicle.getIDList()
        for vid in vehicles:
            try:
                if not vid.startswith("accident_"):
                    traci.vehicle.setSpeedFactor(vid, 1.2)
            except Exception:
                pass

        SUMO_PAUSED = False
        SUMO_RUNNING = True
        logger.info("✅ SUMO démarré")

        await sio.emit("simulation_status", {"status": "started"})
        return {
            "message":    "SUMO démarré",
            "status":     "started",
            "vehicles":   list(vehicles),
            "accidents":  list(ACCIDENT_STATES.keys()),
            "ai_enabled": prediction_service is not None,
        }

    except Exception as e:
        logger.error(f"Error: {traceback.format_exc()}")
        try:
            if SUMO_ORIGINAL_CWD and os.path.exists(SUMO_ORIGINAL_CWD):
                os.chdir(SUMO_ORIGINAL_CWD)
        except Exception:
            pass
        SUMO_RUNNING      = False
        ACTIVE_JOURNEY_ID = None   # FIX B
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/simulation/step-delay")
async def set_step_delay(factor: int = Body(..., embed=True)):
    global SUMO_STEP_DELAY, SUMO_EXTRA_STEPS
    delays = {1: 0.1, 2: 0.0, 5: 0.0}
    extra  = {1: 0,   2: 1,   5: 4}
    SUMO_STEP_DELAY  = delays.get(factor, 0.0)
    SUMO_EXTRA_STEPS = extra.get(factor, 0)
    logger.info(f"Vitesse simulation ×{factor} (delay={SUMO_STEP_DELAY}s, extra_steps={SUMO_EXTRA_STEPS})")
    return {"status": "ok", "factor": factor}


@fastapi_app.post("/simulation/stop")
async def stop_simulation():
    # FIX D : déclarer ACTIVE_JOURNEY_ID global
    global SUMO_RUNNING, ACTIVE_JOURNEY_ID

    SUMO_RUNNING = False
    await asyncio.sleep(0.2)

    # Finaliser le journey avant de fermer
    if ACTIVE_JOURNEY_ID and persistence:
        try:
            await persistence.finalize_journey(ACTIVE_JOURNEY_ID)
            logger.info(f"✅ Journey finalisé : {ACTIVE_JOURNEY_ID}")
        except Exception as e:
            logger.warning(f"Erreur finalisation journey: {e}")

    # FIX D : reset APRÈS finalisation
    ACTIVE_JOURNEY_ID = None

    try:
        traci.close()
        logger.info("SUMO fermé")
    except Exception as e:
        logger.warning(f"Erreur fermeture SUMO: {e}")

    if sumo_engine:
        try:
            sumo_engine.cleanup()
        except Exception as e:
            logger.warning(f"Erreur cleanup: {e}")

    try:
        if SUMO_ORIGINAL_CWD and os.path.exists(SUMO_ORIGINAL_CWD):
            os.chdir(SUMO_ORIGINAL_CWD)
    except Exception:
        pass

    BREAKDOWN_STATES.clear()
    ACCIDENT_STATES.clear()

    await sio.emit("simulation_status", {"status": "stopped"})
    return {"message": "Simulation arrêtée", "status": "stopped"}


@fastapi_app.post("/simulation/pause")
async def pause_simulation():
    """Met la simulation en pause — SUMO ne step plus, les véhicules restent visibles."""
    global SUMO_PAUSED
    if not SUMO_RUNNING:
        raise HTTPException(status_code=400, detail="Simulation non démarrée")
    SUMO_PAUSED = True
    await sio.emit("simulation_status", {"status": "paused"})
    logger.info("⏸️  Simulation en pause")
    return {"status": "paused", "message": "Simulation en pause"}


@fastapi_app.post("/simulation/resume")
async def resume_simulation():
    """Reprend la simulation après une pause."""
    global SUMO_PAUSED
    if not SUMO_RUNNING:
        raise HTTPException(status_code=400, detail="Simulation non démarrée")
    SUMO_PAUSED = False
    await sio.emit("simulation_status", {"status": "resumed"})
    logger.info("▶️  Simulation reprise")
    return {"status": "running", "message": "Simulation reprise"}


@fastapi_app.post("/lstm/train")
async def train_lstm_endpoint():
    global lstm_training
    if LSTMTrainService is None:
        raise HTTPException(status_code=503, detail="TensorFlow non disponible — installez tensorflow dans le container")
    if lstm_training:
        return {"status": "already_running", "message": "Entraînement déjà en cours"}
    lstm_training = True
    asyncio.create_task(_run_lstm_training())
    return {"status": "started", "message": "Entraînement LSTM lancé"}

async def _run_lstm_training():
    global lstm_training
    try:
        service = LSTMTrainService(sio=sio, db=db)
        await service.run()
        if lstm_predictor:
            lstm_predictor._load()
            logger.info("✅ Modèle LSTM rechargé dans LSTMPredictorService")
    except Exception as e:
        logger.error(f"LSTM training error: {e}")
        await sio.emit("lstm_train_status", {"status": "error", "message": str(e)})
    finally:
        lstm_training = False


# ============================================================
# 10. JOURNEY ENDPOINTS
# ============================================================

@fastapi_app.post("/journey/start")
async def rest_start_journey(request: Request):
    global ACTIVE_JOURNEY_ID

    if not SUMO_RUNNING:
        raise HTTPException(status_code=400, detail="SUMO n'est pas démarré")
    if persistence is None:
        raise HTTPException(status_code=500, detail="Persistence non disponible (MongoDB ?)")

    # Finaliser le journey précédent s'il existe
    if ACTIVE_JOURNEY_ID:
        try:
            await persistence.finalize_journey(ACTIVE_JOURNEY_ID)
            logger.info(f"Journey précédent finalisé: {ACTIVE_JOURNEY_ID}")
        except Exception:
            pass

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    origin      = payload.get("origin")      or {"lat": 33.5731, "lng": -7.5898}
    destination = payload.get("destination") or {"lat": 33.5785, "lng": -7.6185}
    journey_id  = f"trip_{int(datetime.now().timestamp())}"

    doc = await persistence.create_journey(journey_id, origin, destination)
    if doc is None:
        raise HTTPException(status_code=500, detail="Erreur création journey en DB")

    ACTIVE_JOURNEY_ID = journey_id
    logger.info(f"✅ Journey actif: {journey_id}")

    if sumo_engine and traci.isLoaded():
        sumo_engine.compute_and_set_route(origin, destination)

    return {
        "journey_id":  journey_id,
        "status":      "created",
        "origin":      origin,
        "destination": destination,
    }


@fastapi_app.get("/journeys")
async def get_journeys():
    if db is None:
        return {"journeys": []}
    journeys = []
    try:
        async for doc in db.journeys.find({}, {"_id": 0}).sort("start_time", -1).limit(50):
            if "anomalies_detected" not in doc:
                doc["anomalies_detected"] = 0
            journeys.append(doc)
    except Exception as e:
        logger.error(f"Erreur get_journeys: {e}")
    return {"journeys": journeys}


@fastapi_app.get("/journeys/{journey_id}")
async def get_journey(journey_id: str):
    if db is None:
        raise HTTPException(status_code=500, detail="Database not available")

    doc = await db.journeys.find_one({"journey_id": journey_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Journey not found")

    steps = []
    try:
        async for s in db.traffic_logs.find(
            {"journey_id": journey_id}, {"_id": 0}
        ).sort("timestamp", 1).limit(1000):
            steps.append(s)
    except Exception as e:
        logger.error(f"Erreur get_steps: {e}")
    doc["steps"] = steps

    anomalies = []
    try:
        async for a in db.anomalies.find(
            {"journey_id": journey_id}, {"_id": 0}
        ).sort("timestamp", 1).limit(200):
            anomalies.append(a)
    except Exception as e:
        logger.error(f"Erreur get_anomalies for journey: {e}")
    doc["anomalies"] = anomalies

    predictions = []
    try:
        async for p in db.predictions.find(
            {"journey_id": journey_id}, {"_id": 0}
        ).sort("timestamp", 1).limit(200):
            predictions.append(p)
    except Exception as e:
        logger.error(f"Erreur get_predictions for journey: {e}")
    doc["predictions"] = predictions

    return doc


# ============================================================
# 11. TRAFFIC ENDPOINTS
# ============================================================

@fastapi_app.get("/traffic/statistics")
async def get_traffic_statistics():
    if sumo_engine is None or not SUMO_RUNNING:
        return {"status": "simulation_not_running"}
    try:
        stats             = sumo_engine.get_traffic_statistics()
        stats["status"]   = "active"
        stats["ai_enabled"] = prediction_service is not None
        return stats
    except Exception as e:
        logger.error(f"Erreur traffic stats: {e}")
        return {"status": "error", "message": str(e)}


@fastapi_app.get("/api/simulation/vehicles")
async def get_vehicles():
    try:
        if not traci.isLoaded():
            return {"count": 0, "vehicles": []}
        vehicles = traci.vehicle.getIDList()
        return {"count": len(vehicles), "vehicles": list(vehicles)}
    except Exception as e:
        logger.error(f"Error getting vehicles: {e}")
        return {"count": 0, "vehicles": []}


@fastapi_app.get("/traffic/anomalies")
async def get_anomalies(limit: int = 100):
    if db is None:
        return {"anomalies": [], "count": 0}
    anomalies = []
    try:
        async for a in db.anomalies.find({}, {"_id": 0}).sort("timestamp", -1).limit(limit):
            anomalies.append(a)
    except Exception as e:
        logger.error(f"Erreur get_anomalies: {e}")
    return {"anomalies": anomalies, "count": len(anomalies)}


@fastapi_app.get("/ai/info")
async def get_ai_info():
    if prediction_service:
        return {
            "enabled":             True,
            "model_type":          "TrafficPredictionService",
            "features":            ["time_features", "historical_data", "current_metrics"],
            "prediction_horizons": ["short", "medium", "long"],
        }
    return {
        "enabled":  False,
        "fallback": "simple_moving_average",
        "message":  "No ML model loaded. Using simple moving average for predictions.",
    }


# ============================================================
# 12. SOCKET.IO EVENTS
# ============================================================

@sio.on("start_journey")
async def handle_start(sid, data):
    global ACTIVE_JOURNEY_ID

    if not SUMO_RUNNING:
        await sio.emit("system_error",
                       {"msg": "Démarrez SUMO via le bouton Play d'abord."},
                       room=sid)
        return

    if persistence is None:
        await sio.emit("system_error", {"msg": "MongoDB non disponible."}, room=sid)
        return

    origin      = data.get("origin")      or {"lat": 33.5731, "lng": -7.5898}
    destination = data.get("destination") or {"lat": 33.5785, "lng": -7.6185}
    journey_id  = f"trip_{int(datetime.now().timestamp())}"

    if ACTIVE_JOURNEY_ID:
        try:
            await persistence.finalize_journey(ACTIVE_JOURNEY_ID)
        except Exception:
            pass

    await persistence.create_journey(journey_id, origin, destination)
    ACTIVE_JOURNEY_ID = journey_id
    logger.info(f"✅ Journey actif (socket): {journey_id}")

    if sumo_engine and traci.isLoaded():
        sumo_engine.compute_and_set_route(origin, destination)

    await sio.emit("journey_started", {"journey_id": journey_id}, room=sid)


@sio.on("get_traffic_prediction")
async def handle_prediction(sid, data):
    if prediction_service is None or sumo_engine is None:
        await sio.emit("prediction_response",
                       {"error": "AI predictions not available"}, room=sid)
        return
    segment_id = data.get("segment_id")
    if not segment_id:
        await sio.emit("prediction_response", {"error": "segment_id required"}, room=sid)
        return
    predictions = await sumo_engine.predict_traffic([segment_id])
    if predictions:
        pred = predictions[0]
        await sio.emit("prediction_response", pred.dict(), room=sid)


# ============================================================
# 13. SCENARIO ENDPOINTS
# ============================================================

@fastapi_app.post("/scenario/generate")
async def scenario_generate(request: Request):
    if generate_service is None:
        raise HTTPException(status_code=500, detail="GenerateService non disponible")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON invalide")

    bbox             = body.get("bbox", {})
    vehicle_count    = int(body.get("vehicle_count",    50))
    pedestrian_count = int(body.get("pedestrian_count", 20))
    accidents_list   = body.get("accidents",            [])
    sim_duration     = int(body.get("sim_duration",   3600))
    scenario_name    = str(body.get("scenario_name",    "")).strip()

    for key in ("min_lat", "max_lat", "min_lng", "max_lng"):
        if bbox.get(key) is None:
            raise HTTPException(status_code=400, detail=f"bbox.{key} requis")

    dlat = abs(bbox["max_lat"] - bbox["min_lat"])
    dlng = abs(bbox["max_lng"] - bbox["min_lng"])
    if dlat < 0.001 or dlng < 0.001:
        raise HTTPException(
            status_code=400,
            detail="Zone trop petite — agrandissez le rectangle sur la carte"
        )

    try:
        result = await generate_service.generate(
            bbox=bbox,
            vehicle_count=vehicle_count,
            pedestrian_count=pedestrian_count,
            accidents=accidents_list,
            sim_duration=sim_duration,
            scenario_name=scenario_name,
        )
        return result
    except Exception as e:
        logger.error(f"generate_scenario error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.get("/scenario/list")
async def scenario_list():
    if scenario_config is not None:
        return {"scenarios": scenario_config.list_scenarios()}
    if generate_service is not None:
        return {"scenarios": generate_service.list_scenarios()}
    return {"scenarios": []}


@fastapi_app.get("/scenario/config")
async def scenario_get_config():
    if scenario_config is None:
        return {"error": "ScenarioConfigService non disponible"}
    info       = scenario_config.get_active_scenario_info()
    validation = scenario_config.validate()
    return {**info, "validation": validation}


@fastapi_app.post("/scenario/select/{scenario_id}")
async def scenario_select(scenario_id: str):
    if scenario_config is None:
        raise HTTPException(status_code=500, detail="ScenarioConfigService non disponible")
    if SUMO_RUNNING:
        raise HTTPException(
            status_code=400,
            detail="Arrêtez la simulation avant de changer de scénario"
        )
    result = scenario_config.select_scenario(scenario_id)
    if not result["success"]:
        raise HTTPException(status_code=404, detail=result["message"])
    return result


@fastapi_app.post("/scenario/select-default")
async def scenario_select_default():
    if scenario_config is None:
        raise HTTPException(status_code=500, detail="ScenarioConfigService non disponible")
    if SUMO_RUNNING:
        raise HTTPException(status_code=400, detail="Arrêtez la simulation d'abord")
    return scenario_config.select_default()


@fastapi_app.post("/scenario/fix-routes")
async def scenario_fix_routes():
    import shutil, tempfile

    if SUMO_RUNNING:
        raise HTTPException(
            status_code=400,
            detail="Arrêtez la simulation avant de corriger les routes"
        )

    if scenario_config is not None:
        net_file = scenario_config.get_net_path()
        rou_file = scenario_config.get_rou_path()
        cfg_file = scenario_config.get_config_path()
    else:
        net_file = os.path.join(SUMO_DATA_DIR, "casa.net.xml")
        rou_file = os.path.join(SUMO_DATA_DIR, "casa.rou.xml")
        cfg_file = os.path.join(SUMO_DATA_DIR, "casa.sumocfg")

    if not os.path.exists(net_file):
        raise HTTPException(status_code=404, detail=f"casa.net.xml introuvable : {net_file}")

    patched_cfg = False
    if scenario_config is not None and os.path.exists(cfg_file):
        patched_cfg = scenario_config.patch_sumocfg(cfg_file)

    try:
        from src.services.GenerateService import (
            _build_adjacency, _generate_minimal_routes,
            _find_random_trips, _generate_routes_random_trips,
        )
        import json as _json

        vehicle_count = 50
        if scenario_config is not None:
            sc_id = scenario_config.get_active_scenario_id()
            if sc_id:
                meta_path = os.path.join(SUMO_DATA_DIR, sc_id, "metadata.json")
                if os.path.exists(meta_path):
                    try:
                        with open(meta_path) as _f:
                            _meta = _json.load(_f)
                        vehicle_count = int(_meta.get("vehicle_count", 50))
                    except Exception:
                        pass

        random_trips = _find_random_trips()
        if random_trips:
            tmpdir = tempfile.mkdtemp(prefix="sumo_fix_")
            try:
                trips_tmp = os.path.join(tmpdir, "trips.xml")
                rou_tmp   = os.path.join(tmpdir, "routes.xml")
                ok = _generate_routes_random_trips(
                    random_trips, net_file, trips_tmp, rou_tmp,
                    count=vehicle_count, end=3600,
                )
                if ok:
                    shutil.copy2(rou_tmp, rou_file)
                    size = os.path.getsize(rou_file)
                    return {
                        "status":        "fixed",
                        "method":        "randomTrips",
                        "vehicle_count": vehicle_count,
                        "patched_cfg":   patched_cfg,
                        "message":       f"{vehicle_count} routes validées ({size:,} bytes) — relancez la simulation",
                    }
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)

        _generate_minimal_routes(rou_file, net_file, count=vehicle_count)
        size = os.path.getsize(rou_file)
        return {
            "status":        "fixed",
            "method":        "bfs_topology",
            "vehicle_count": vehicle_count,
            "patched_cfg":   patched_cfg,
            "message":       f"{vehicle_count} routes BFS générées ({size:,} bytes) — relancez la simulation",
        }

    except Exception as e:
        logger.error(f"fix-routes error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.get("/scenario/active")
async def scenario_active():
    if scenario_config is not None:
        return {
            "active": scenario_config.get_active_scenario_id(),
            "info":   scenario_config.get_active_scenario_info(),
        }
    if generate_service is not None:
        return {"active": generate_service.get_active_scenario()}
    return {"active": None}


@fastapi_app.delete("/scenario/{scenario_id}")
async def scenario_delete(scenario_id: str):
    import shutil

    if SUMO_RUNNING:
        raise HTTPException(
            status_code=400,
            detail="Arrêtez la simulation avant de supprimer un scénario"
        )

    sc_dir = os.path.join(SUMO_DATA_DIR, scenario_id)
    if os.path.abspath(sc_dir) == os.path.abspath(SUMO_DATA_DIR):
        raise HTTPException(
            status_code=403,
            detail="Impossible de supprimer les fichiers par défaut"
        )
    if not sc_dir.startswith(os.path.abspath(SUMO_DATA_DIR)):
        raise HTTPException(status_code=403, detail="Chemin non autorisé")
    if not os.path.isdir(sc_dir):
        raise HTTPException(status_code=404, detail=f"Scénario introuvable : {scenario_id}")

    if scenario_config is not None and scenario_config.get_active_scenario_id() == scenario_id:
        scenario_config.select_default()
        logger.info("Scénario actif supprimé → retour au défaut")

    try:
        shutil.rmtree(sc_dir)
        logger.info(f"✅ Scénario supprimé : {scenario_id}")
        return {"status": "deleted", "scenario_id": scenario_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur suppression : {e}")


@fastapi_app.post("/scenario/deploy/{scenario_id}")
async def scenario_deploy(scenario_id: str):
    if SUMO_RUNNING:
        raise HTTPException(
            status_code=400,
            detail="Arrêtez la simulation avant de changer de scénario"
        )

    if scenario_config is not None:
        result = scenario_config.select_scenario(scenario_id)
        if not result["success"]:
            raise HTTPException(status_code=404, detail=result["message"])
        return {"status": "selected", "scenario_id": scenario_id, **result}

    if generate_service is not None:
        ok = generate_service.deploy_scenario(scenario_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Scénario introuvable : {scenario_id}")
        return {"status": "deployed", "scenario_id": scenario_id}

    raise HTTPException(status_code=500, detail="Aucun service de scénario disponible")


# ============================================================
# 14. ASGI APP
# ============================================================
app = socketio.ASGIApp(sio, fastapi_app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )