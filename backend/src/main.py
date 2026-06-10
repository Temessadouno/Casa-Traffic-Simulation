# /app/main.py
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

# ============================================================
# 1. APP SETUP
# ============================================================
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
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
MONGO_URI = os.getenv("MONGO_URI", "mongodb://mongodb:27017")
DATABASE_NAME = os.getenv("DATABASE_NAME", "traffic_simulation")

db = None
client = None

try:
    client = AsyncIOMotorClient(MONGO_URI)
    db = client[DATABASE_NAME]
    client.admin.command('ping')
    logger.info("✅ Connexion MongoDB établie")
except Exception as e:
    logger.error(f"❌ Erreur configuration MongoDB: {e}")
    db = None
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
else:
    logger.warning("⚠️ PersistenceService non disponible")

safety = None
if SafetyAIService is not None:
    try:
        safety = SafetyAIService(sio, persistence)
        logger.info("✅ SafetyAIService initialisé")
    except Exception as e:
        logger.error(f"❌ Erreur initialisation SafetyAIService: {e}")
else:
    logger.warning("⚠️ SafetyAIService non disponible")

MODEL_PATH = os.getenv("MODEL_PATH", None)
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
else:
    logger.warning("⚠️ SumoEngineService non disponible")

# ============================================================
# 4. SUMO CONFIG + JOURNEY STATE
# ============================================================
SUMO_RUNNING     = False
SUMO_STEP_DELAY  = 0.0   # délai entre steps (0 = max vitesse)
SUMO_EXTRA_STEPS = 0     # steps supplémentaires par tick (×2=1, ×5=4)
SUMO_ORIGINAL_CWD = os.getcwd()

# Accidents : {vehicle_id: {"lat": ..., "lng": ..., "cause": ..., "blocked": []}}
ACCIDENT_STATES: dict = {}

# Détection pannes : {vehicle_id: {"waiting_since": step, "lat":..., "lng":..., "notified": bool}}
BREAKDOWN_STATES: dict = {}
BREAKDOWN_THRESHOLD = 40   # steps à l'arrêt hors feu = ~20s simulées → panne

# Journey actif géré par la boucle broadcast
ACTIVE_JOURNEY_ID = None       # ID du journey en cours
ACTIVE_JOURNEY_SID = None      # SID socket du client (optionnel)

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

# Instanciation du service de génération
generate_service = None
if GenerateService is not None:
    try:
        generate_service = GenerateService(sumo_data_dir=SUMO_DATA_DIR)
        logger.info("✅ GenerateService initialisé")
    except Exception as e:
        logger.error(f"❌ Erreur initialisation GenerateService: {e}")
else:
    logger.warning("⚠️ GenerateService non disponible")

# Instanciation du service de configuration de scénario
scenario_config = None
if ScenarioConfigService is not None:
    try:
        scenario_config = ScenarioConfigService(sumo_data_dir=SUMO_DATA_DIR)
        logger.info(f"✅ ScenarioConfigService initialisé — actif: {scenario_config.get_active_scenario_id() or 'défaut'}")
    except Exception as e:
        logger.error(f"❌ Erreur initialisation ScenarioConfigService: {e}")
else:
    logger.warning("⚠️ ScenarioConfigService non disponible")

# ============================================================
# 5. BROADCAST HELPERS
# ============================================================

async def broadcast_all_vehicles() -> dict:
    """
    Avance SUMO, émet all_vehicles_state et retourne le snapshot.
    Retourne toujours un dict (vide si SUMO non connecté).
    """
    try:
        if not traci.isLoaded():
            return {}

        vehicles = traci.vehicle.getIDList()
        snapshot = {}

        for vid in vehicles:
            try:
                # Appliquer speedFactor aux nouveaux véhicules
                if not hasattr(broadcast_all_vehicles, "_known") :
                    broadcast_all_vehicles._known = set()
                if vid not in broadcast_all_vehicles._known:
                    broadcast_all_vehicles._known.add(vid)
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

        # ── Piétons (persons SUMO) ──────────────────────────────────
        pedestrians = {}
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
            pass  # traci.person non disponible (réseau sans piétons)

        await sio.emit("all_vehicles_state", {"vehicles": snapshot, "pedestrians": pedestrians})
        return snapshot                          # ← toujours retourné

    except Exception as e:
        logger.warning(f"broadcast_all_vehicles error: {e}")
        return {}                               # ← jamais None


async def broadcast_nearby_vehicles(ego_id: str, sid: str):
    """Émet les véhicules proches de l'ego à un client spécifique."""
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
# 6. BOUCLE DE BROADCAST INDÉPENDANTE
# ============================================================

async def simulation_broadcast_loop():
    """
    Tâche de fond principale :
    - Avance SUMO d'un step
    - Broadcast tous les véhicules (MapGlobal / MapSolo)
    - Persiste les données du journey actif en MongoDB
    - Détecte les anomalies et émet les alertes
    """
    global SUMO_RUNNING, ACTIVE_JOURNEY_ID
    logger.info("🔄 Boucle broadcast démarrée")

    step_counter = 0

    while True:
        if SUMO_RUNNING:
            try:
                # Guard : SUMO peut être fermé entre deux itérations
                if not traci.isLoaded():
                    logger.warning("simulation_broadcast_loop: TraCI non connecté, pause.")
                    SUMO_RUNNING = False
                    BREAKDOWN_STATES.clear()
                    await sio.emit("simulation_status", {"status": "stopped"})
                    await asyncio.sleep(0.1)
                    continue

                # Steps supplémentaires pour accélération ×2 ×5
                for _ in range(SUMO_EXTRA_STEPS):
                    traci.simulationStep()
                traci.simulationStep()
                step_counter += 1

                # snapshot est TOUJOURS défini avant d'être utilisé
                snapshot = await broadcast_all_vehicles()   # retourne dict {vid: {...}}
                vehicles = list(snapshot.keys())

                # ── ACCIDENTS : détection véhicules bloqués ──────────────────
                if ACCIDENT_STATES and step_counter % 5 == 0:
                    try:
                        acc_update = []
                        for acc_id, acc_info in ACCIDENT_STATES.items():
                            acc_edge = acc_info.get("edge", "")
                            blocked = []
                            for vid in vehicles:
                                if vid == acc_id or vid.startswith("accident_"):
                                    continue
                                try:
                                    v_edge = traci.vehicle.getRoadID(vid)
                                    v_speed = traci.vehicle.getSpeed(vid)
                                    v_wait  = traci.vehicle.getWaitingTime(vid)
                                    # Bloqué = même edge OU vitesse < 2 km/h depuis >5s
                                    if v_edge == acc_edge and (v_speed < 0.5 or v_wait > 5):
                                        blocked.append(vid)
                                except Exception:
                                    continue
                            ACCIDENT_STATES[acc_id]["blocked"] = blocked
                            # Mettre à jour la position GPS (le véhicule peut légèrement dériver)
                            try:
                                x, y = traci.vehicle.getPosition(acc_id)
                                lon, lat = traci.simulation.convertGeo(x, y)
                                ACCIDENT_STATES[acc_id]["lat"] = lat
                                ACCIDENT_STATES[acc_id]["lng"] = lon
                            except Exception:
                                pass
                            acc_update.append({
                                "id":            acc_id,
                                "lat":           acc_info.get("lat"),
                                "lng":           acc_info.get("lng"),
                                "cause":         acc_info.get("cause", "inconnu"),
                                "edge":          acc_info.get("edge", ""),
                                "blocked_count": len(blocked),
                                "blocked_ids":   blocked[:5],
                            })
                        if acc_update:
                            await sio.emit("accidents_state", {"accidents": acc_update})
                    except Exception as acc_err:
                        logger.debug(f"accident update error: {acc_err}")

                # ── PANNES : véhicules bloqués hors feu rouge ────────────────
                if step_counter % 3 == 0:
                    try:
                        _all_vids = list(snapshot.keys())
                        for _vid in _all_vids:
                            if _vid.startswith("accident_"):
                                continue
                            _v   = snapshot[_vid]
                            _spd = _v.get("speed", 999)

                            if _spd <= 0.5:
                                # Vérifier si c'est un feu rouge
                                _at_tls = False
                                try:
                                    _next_tls = traci.vehicle.getNextTLS(_vid)
                                    # Si un feu est à < 15m et rouge/jaune → pas une panne
                                    if _next_tls:
                                        _dist_tls, _state = _next_tls[0][2], _next_tls[0][3]
                                        if _dist_tls < 15 and _state.lower() in ("r","y","u"):
                                            _at_tls = True
                                except Exception:
                                    pass

                                if not _at_tls:
                                    if _vid not in BREAKDOWN_STATES:
                                        BREAKDOWN_STATES[_vid] = {
                                            "waiting_since": step_counter,
                                            "lat": _v["lat"], "lng": _v["lng"],
                                            "notified": False,
                                        }
                                    elif not BREAKDOWN_STATES[_vid]["notified"]:
                                        waited = step_counter - BREAKDOWN_STATES[_vid]["waiting_since"]
                                        if waited >= BREAKDOWN_THRESHOLD:
                                            # Émettre alerte panne
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
                                # Véhicule repart → effacer son état
                                if _vid in BREAKDOWN_STATES:
                                    del BREAKDOWN_STATES[_vid]
                    except Exception as _bd_err:
                        logger.debug(f"breakdown detect: {_bd_err}")

                # ── PERSISTENCE : position ego ───────────────────────────────
                if ACTIVE_JOURNEY_ID and persistence and sumo_engine:
                    ego_id = sumo_engine.vehicle_id
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
                            await persistence.save_step(ACTIVE_JOURNEY_ID, point)
                            await sio.emit("vehicle_state", {
                                "id":      ego_id,
                                "lat":     ego_data["lat"],
                                "lng":     ego_data["lng"],
                                "speed":   ego_data["speed"],
                                "heading": ego_data["heading"],
                            })
                        except Exception as ego_err:
                            logger.debug(f"ego persist error: {ego_err}")

                # ── MÉTRIQUES + ANOMALIES (toutes les 10 steps) ─────────────
                if step_counter % 10 == 0 and sumo_engine and ACTIVE_JOURNEY_ID and persistence:
                    try:
                        metrics = sumo_engine.collect_traffic_metrics()
                        for metric in metrics.values():
                            anomaly = sumo_engine.detect_anomalies(metric)
                            if anomaly:
                                await persistence.save_anomaly(ACTIVE_JOURNEY_ID, anomaly)
                                await sio.emit("emergency_alert", {
                                    "vehicle_id":      sumo_engine.vehicle_id,
                                    "nearest_vehicle": None,
                                    "distance":        None,
                                    "segment_id":      anomaly.segment_id,
                                    "severity":        anomaly.severity,
                                    "deviation":       round(anomaly.deviation, 2),
                                    "anomaly_score":   round(anomaly.anomaly_score, 2),
                                    "title":           f"Anomalie trafic — {anomaly.segment_id[:12]}",
                                    "message":         f"Déviation {anomaly.deviation:.1f}σ sur segment {anomaly.segment_id}",
                                    "risk_level":      anomaly.severity,
                                    "timestamp":       datetime.utcnow().isoformat(),
                                })
                    except Exception as metrics_err:
                        logger.debug(f"metrics error: {metrics_err}")

                # ── PRÉDICTIONS (toutes les 60 steps) ───────────────────────
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

                # ── SÉCURITÉ : détection collision sur ego ───────────────────
                if safety and sumo_engine:
                    ego_id   = sumo_engine.vehicle_id
                    ego_data = snapshot.get(ego_id)   # snapshot est garanti défini ici
                    if ego_data:
                        try:
                            from src.models.trafficAiModels import GeoPoint as _GP
                            _pos = _GP(lat=ego_data["lat"], lng=ego_data["lng"])
                        except Exception:
                            _pos = None
                        await safety.check_proximity_risk(ego_id, _pos)

            except Exception as e:
                err_str = str(e)
                if "Connection closed" in err_str or "not connected" in err_str.lower():
                    logger.warning(f"⚠️ SUMO fermé (fin de simulation) — arrêt propre")
                    # Tentative de redémarrage automatique si des scénarios sont disponibles
                    # Pour l'instant, arrêt propre
                else:
                    logger.error(f"❌ simulation_broadcast_loop error: {e}")
                SUMO_RUNNING = False
                BREAKDOWN_STATES.clear()
                try:
                    traci.close()
                except Exception:
                    pass
                await sio.emit("simulation_status", {"status": "stopped", "reason": err_str[:80]})

        await asyncio.sleep(0.1)  # 10 fps

# ============================================================
# 7. STARTUP / SHUTDOWN
# ============================================================

@fastapi_app.on_event("startup")
async def startup_db_client():
    global db, client

    # Vérification MongoDB
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

    # Démarrage de la boucle broadcast en tâche de fond
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
# 8. HEALTH CHECK ENDPOINTS
# ============================================================

@fastapi_app.get("/")
async def root():
    return {
        "message": "TMT Traffic Control API",
        "version": "2.0.0",
        "status": "running",
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
        "sumo_running": SUMO_RUNNING,
        "sumo_loaded":  is_loaded,
        "ai_enabled":   prediction_service is not None,
        "engine_stats": engine_stats,
    }

# ============================================================
# 9. SIMULATION ENDPOINTS
# ============================================================

@fastapi_app.post("/simulation/start")
async def start_simulation():
    global SUMO_RUNNING, SUMO_ORIGINAL_CWD

    logger.info(f"Starting SUMO at {datetime.now()}")

    if sumo_engine is None:
        raise HTTPException(status_code=500, detail="SumoEngineService non disponible")

    # Fermer l'instance précédente si nécessaire
    try:
        if traci.isLoaded():
            traci.close()
            await asyncio.sleep(1)
    except Exception as e:
        logger.warning(f"Cleanup error: {e}")

    try:
        # ── Résolution du chemin via ScenarioConfigService ──
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
            # Fallback legacy
            config_path = os.path.join(SUMO_DATA_DIR, SUMO_CONFIG_FILE)
            net_file    = os.path.join(SUMO_DATA_DIR, "casa.net.xml")
            route_file  = os.path.join(SUMO_DATA_DIR, "casa.rou.xml")

        if not os.path.exists(config_path):
            raise FileNotFoundError(f"Config non trouvée: {config_path}")
        if not os.path.exists(net_file):
            raise FileNotFoundError(f"Network file not found: {net_file}")
        if not os.path.exists(route_file):
            raise FileNotFoundError(f"Route file not found: {route_file}")

        # Le CWD doit être le dossier contenant les fichiers
        active_dir = os.path.dirname(config_path)
        logger.info(f"Using config : {config_path}")

        # ── Patcher le sumocfg pour ignorer les erreurs de routes ──
        if scenario_config is not None:
            scenario_config.patch_sumocfg(config_path)

        # Sauvegarder le CWD AVANT tout chdir — os.getcwd() échoue si
        # le dossier courant a été supprimé depuis le dernier chdir
        try:
            SUMO_ORIGINAL_CWD = os.getcwd()
        except FileNotFoundError:
            SUMO_ORIGINAL_CWD = os.path.dirname(os.path.abspath(__file__))
            logger.warning(f"CWD introuvable, fallback: {SUMO_ORIGINAL_CWD}")
        os.chdir(active_dir)

        # Nom du fichier sumocfg (relatif au active_dir)
        cfg_name = os.path.basename(config_path)
        traci.start([
            "sumo",
            "-c",                     cfg_name,
            "--step-length",          "0.5",
            "--default.speeddev",     "0.1",
            "--time-to-teleport",     "60",    # téléporte plus vite les véhicules bloqués
            "--time-to-teleport.highways", "-1",
            "--ignore-route-errors",  "true",
            "--collision.action",     "warn",
            "--end",                  "86400", # 24h — SUMO ne se ferme jamais avant qu'on le stop
            "--no-warnings",
            "--no-step-log",
            "--error-log",            "/tmp/sumo_errors.log",
        ])

        await asyncio.sleep(2)

        if not traci.isLoaded():
            raise Exception("SUMO failed to load")

        # ── Lire les accidents depuis le .rou.xml AVANT le warm-up ──
        # Les véhicules accident_* ont depart=5,7,9… ils n'entrent pas
        # dans la simulation pendant les 3 premiers steps (1.5s simulées).
        # On lit directement le fichier XML pour pré-charger leurs métadonnées.
        global ACCIDENT_STATES
        ACCIDENT_STATES = {}

        try:
            import xml.etree.ElementTree as _ET
            _rou_path = scenario_config.get_rou_path() if scenario_config else route_file
            _rou_tree = _ET.parse(_rou_path)
            for _veh in _rou_tree.getroot().findall(".//vehicle"):
                _vid = _veh.get("id", "")
                if not _vid.startswith("accident_"):
                    continue
                # Cause encodée dans l'ID : accident_<cause>_<N>
                # ex: accident_collision_0, accident_panne_1
                _parts = _vid.split("_")
                _cause = _parts[1] if len(_parts) >= 3 else "inconnu"
                # Trouver l'edge depuis la route
                _route_id = _veh.get("route", "")
                _edge = ""
                for _r in _rou_tree.getroot().findall(".//route"):
                    if _r.get("id") == _route_id:
                        _edge = (_r.get("edges") or "").split()[0]
                        break
                ACCIDENT_STATES[_vid] = {
                    "id": _vid,
                    "lat": None, "lng": None,    # GPS rempli après warm-up
                    "cause": _cause, "blocked": [], "blocked_count": 0,
                    "edge": _edge,
                }
            logger.info(f"📋 {len(ACCIDENT_STATES)} accident(s) lus depuis {_rou_path}")
        except Exception as _xml_err:
            logger.warning(f"Lecture .rou.xml accidents: {_xml_err}")

        # ── Warm-up : avancer jusqu'à ce que les accidents entrent (max 60 steps) ──
        # Les accidents ont depart=5+(i*2), donc le dernier entre à ~5+N*2 secondes.
        # step-length=0.5s → max 60 steps = 30s simulées.
        _acc_expected = set(ACCIDENT_STATES.keys())
        _acc_seen     = set()

        for _step in range(60):
            traci.simulationStep()
            _vids = set(traci.vehicle.getIDList())
            # Dès qu'un accident apparaît, récupérer sa position GPS
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
                    logger.info(f"  ✅ Accident entré : {_vid} ({ACCIDENT_STATES[_vid]['cause']}) @ {_lat:.5f},{_lon:.5f}")
                except Exception as _pe:
                    logger.warning(f"Position accident {_vid}: {_pe}")
            # Sortir dès que tous les accidents attendus sont entrés
            if _acc_seen >= _acc_expected and len(_acc_expected) > 0:
                logger.info(f"Tous les accidents entrés après {_step + 1} steps")
                break
            # Sortir aussi si au moins 3 véhicules normaux sont présents (simulation active)
            _normal = [v for v in _vids if not v.startswith("accident_")]
            if _step >= 3 and not _acc_expected:
                break  # pas d'accidents attendus → 3 steps suffisent

        vehicles = traci.vehicle.getIDList()
        logger.info(f"Vehicles in simulation: {vehicles}")

        # Appliquer speedFactor sur les véhicules normaux
        for vid in vehicles:
            try:
                if not vid.startswith("accident_"):
                    traci.vehicle.setSpeedFactor(vid, 1.2)
            except Exception:
                pass

        # Émettre l'état initial des accidents (avec GPS rempli)
        acc_with_gps = [
            {**info, "id": vid, "blocked_count": 0, "blocked_ids": []}
            for vid, info in ACCIDENT_STATES.items()
            if info.get("lat") is not None
        ]
        if acc_with_gps:
            await sio.emit("accidents_state", {"accidents": acc_with_gps})
            logger.info(f"🚨 {len(acc_with_gps)}/{len(ACCIDENT_STATES)} accidents émis avec GPS")
        elif ACCIDENT_STATES:
            logger.warning(f"⚠️ {len(ACCIDENT_STATES)} accidents lus mais GPS non disponible (depart trop tardif ?)")

        # Active la boucle broadcast
        SUMO_RUNNING = True
        logger.info("✅ SUMO started successfully")

        await sio.emit("simulation_status", {"status": "started"})
        return {
            "message":    "SUMO démarré",
            "status":     "started",
            "vehicles":   list(vehicles),
            "ai_enabled": prediction_service is not None,
        }

    except Exception as e:
        logger.error(f"Error: {traceback.format_exc()}")
        try:
            if SUMO_ORIGINAL_CWD and os.path.exists(SUMO_ORIGINAL_CWD):
                os.chdir(SUMO_ORIGINAL_CWD)
        except Exception:
            pass
        SUMO_RUNNING = False
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.post("/simulation/step-delay")
async def set_step_delay(factor: int = Body(..., embed=True)):
    """
    Ajuste la vitesse de simulation.
    factor=1 → vitesse normale, factor=2 → 2x plus vite, factor=5 → 5x plus vite.
    """
    global SUMO_STEP_DELAY
    delays = {1: 0.1, 2: 0.0, 5: 0.0}
    SUMO_STEP_DELAY = delays.get(factor, 0.0)

    # En plus, injecter des steps SUMO supplémentaires pour les facteurs élevés
    global SUMO_EXTRA_STEPS
    extra = {1: 0, 2: 1, 5: 4}
    SUMO_EXTRA_STEPS = extra.get(factor, 0)

    logger.info(f"Vitesse simulation ×{factor} (delay={SUMO_STEP_DELAY}s, extra_steps={SUMO_EXTRA_STEPS})")
    return {"status": "ok", "factor": factor}


@fastapi_app.post("/simulation/stop")
async def stop_simulation():
    global SUMO_RUNNING, ACTIVE_JOURNEY_ID

    # Désactiver la boucle en premier pour éviter les conflits traci
    SUMO_RUNNING = False
    await asyncio.sleep(0.2)

    # Finaliser le journey actif avant de fermer
    if ACTIVE_JOURNEY_ID and persistence:
        try:
            await persistence.finalize_journey(ACTIVE_JOURNEY_ID)
            logger.info(f"✅ Journey finalisé à l'arrêt: {ACTIVE_JOURNEY_ID}")
        except Exception as e:
            logger.warning(f"Erreur finalisation journey: {e}")
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

    await sio.emit("simulation_status", {"status": "stopped"})
    return {"message": "Simulation arrêtée", "status": "stopped"}

# ============================================================
# 10. JOURNEY ENDPOINTS
# ============================================================

@fastapi_app.post("/journey/start")
async def rest_start_journey(request: Request):
    """
    Crée un journey en DB et active la persistence dans la boucle broadcast.
    Appelé automatiquement par MapSolo 2s après le démarrage de la simulation.
    """
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

    # Body JSON optionnel
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

    ACTIVE_JOURNEY_ID = journey_id          # ← Active la persistence dans la boucle
    logger.info(f"✅ Journey actif: {journey_id}")

    # Créer le véhicule ego dans SUMO
    if sumo_engine and traci.isLoaded():
        sumo_engine.compute_and_set_route(origin, destination)

    return {"journey_id": journey_id, "status": "created", "origin": origin, "destination": destination}


@fastapi_app.get("/journeys")
async def get_journeys():
    if db is None:
        return {"journeys": []}
    journeys = []
    try:
        async for doc in db.journeys.find({}, {"_id": 0}).sort("start_time", -1).limit(50):
            # Normaliser : finalize_journey sauvegarde "anomalies_detected"
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

    # Steps (positions GPS)
    steps = []
    try:
        async for s in db.traffic_logs.find(
            {"journey_id": journey_id}, {"_id": 0}
        ).sort("timestamp", 1).limit(1000):
            steps.append(s)
    except Exception as e:
        logger.error(f"Erreur get_steps: {e}")
    doc["steps"] = steps

    # Anomalies du journey
    anomalies = []
    try:
        async for a in db.anomalies.find(
            {"journey_id": journey_id}, {"_id": 0}
        ).sort("timestamp", 1).limit(200):
            anomalies.append(a)
    except Exception as e:
        logger.error(f"Erreur get_anomalies for journey: {e}")
    doc["anomalies"] = anomalies

    # Prédictions du journey
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
        stats = sumo_engine.get_traffic_statistics()
        stats["status"]     = "active"
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
            "enabled":              True,
            "model_type":           "TrafficPredictionService",
            "features":             ["time_features", "historical_data", "current_metrics"],
            "prediction_horizons":  ["short", "medium", "long"],
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
    """
    Événement Socket.IO start_journey.
    Délègue à l'endpoint REST /journey/start via ACTIVE_JOURNEY_ID.
    La persistence est gérée par simulation_broadcast_loop.
    """
    global ACTIVE_JOURNEY_ID

    if not SUMO_RUNNING:
        await sio.emit(
            "system_error",
            {"msg": "Démarrez SUMO via le bouton Play d'abord."},
            room=sid,
        )
        return

    if persistence is None:
        await sio.emit("system_error", {"msg": "MongoDB non disponible."}, room=sid)
        return

    origin      = data.get("origin")      or {"lat": 33.5731, "lng": -7.5898}
    destination = data.get("destination") or {"lat": 33.5785, "lng": -7.6185}
    journey_id  = f"trip_{int(datetime.now().timestamp())}"

    # Finaliser l'éventuel journey précédent
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
        await sio.emit("prediction_response", {"error": "AI predictions not available"}, room=sid)
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
# 13. ASGI APP
# ============================================================
# ============================================================
# SCENARIO ENDPOINTS  (délèguent à GenerateService)
# ============================================================

@fastapi_app.post("/scenario/generate")
async def scenario_generate(request: Request):
    """
    Génère un scénario SUMO complet depuis une bounding box OSM.
    Délègue toute la logique à GenerateService.
    """
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

    # Validations
    for key in ("min_lat", "max_lat", "min_lng", "max_lng"):
        if bbox.get(key) is None:
            raise HTTPException(status_code=400, detail=f"bbox.{key} requis")

    dlat = abs(bbox["max_lat"] - bbox["min_lat"])
    dlng = abs(bbox["max_lng"] - bbox["min_lng"])
    if dlat < 0.001 or dlng < 0.001:
        raise HTTPException(status_code=400, detail="Zone trop petite — agrandissez le rectangle sur la carte")

    scenario_name = str(body.get("scenario_name", "")).strip()

    try:
        result = await generate_service.generate(
            bbox             = bbox,
            vehicle_count    = vehicle_count,
            pedestrian_count = pedestrian_count,
            accidents        = accidents_list,
            sim_duration     = sim_duration,
            scenario_name    = scenario_name,
        )
        return result
    except Exception as e:
        logger.error(f"generate_scenario error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@fastapi_app.get("/scenario/list")
async def scenario_list():
    """Liste tous les scénarios archivés avec marquage du scénario actif."""
    if scenario_config is not None:
        return {"scenarios": scenario_config.list_scenarios()}
    if generate_service is not None:
        return {"scenarios": generate_service.list_scenarios()}
    return {"scenarios": []}


@fastapi_app.get("/scenario/config")
async def scenario_get_config():
    """Retourne la configuration du scénario actif (chemins, validation)."""
    if scenario_config is None:
        return {"error": "ScenarioConfigService non disponible"}
    info       = scenario_config.get_active_scenario_info()
    validation = scenario_config.validate()
    return {**info, "validation": validation}


@fastapi_app.post("/scenario/select/{scenario_id}")
async def scenario_select(scenario_id: str):
    """
    Sélectionne un scénario sans copier les fichiers.
    La simulation utilisera directement maps/<scenario_id>/.
    """
    if scenario_config is None:
        raise HTTPException(status_code=500, detail="ScenarioConfigService non disponible")
    if SUMO_RUNNING:
        raise HTTPException(status_code=400, detail="Arrêtez la simulation avant de changer de scénario")

    result = scenario_config.select_scenario(scenario_id)
    if not result["success"]:
        raise HTTPException(status_code=404, detail=result["message"])
    return result


@fastapi_app.post("/scenario/select-default")
async def scenario_select_default():
    """Revient aux fichiers par défaut de maps/."""
    if scenario_config is None:
        raise HTTPException(status_code=500, detail="ScenarioConfigService non disponible")
    if SUMO_RUNNING:
        raise HTTPException(status_code=400, detail="Arrêtez la simulation d'abord")
    return scenario_config.select_default()


@fastapi_app.post("/scenario/fix-routes")
async def scenario_fix_routes():
    """
    Regenere les routes valides depuis le casa.net.xml actif
    en filtrant les edges piétons/cyclistes.
    Patche aussi le casa.sumocfg pour ignorer les erreurs résiduelles.
    """
    import shutil, tempfile

    if SUMO_RUNNING:
        raise HTTPException(status_code=400, detail="Arretez la simulation avant de corriger les routes")

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

    # Patcher le sumocfg d'abord (ignore-route-errors)
    patched_cfg = False
    if scenario_config is not None and os.path.exists(cfg_file):
        patched_cfg = scenario_config.patch_sumocfg(cfg_file)

    try:
        from src.services.GenerateService import (
            _build_adjacency, _generate_minimal_routes,
            _find_random_trips, _generate_routes_random_trips,
        )
        import json as _json

        # Lire les métadonnées pour récupérer le nb de véhicules d'origine
        vehicle_count = 50  # défaut
        if scenario_config is not None:
            sc_id = scenario_config.get_active_scenario_id()
            if sc_id:
                meta_path = os.path.join(SUMO_DATA_DIR, sc_id, "metadata.json")
                if os.path.exists(meta_path):
                    try:
                        with open(meta_path) as _f:
                            _meta = _json.load(_f)
                        vehicle_count = int(_meta.get("vehicle_count", 50))
                        logger.info(f"fix-routes: {vehicle_count} véhicules depuis metadata")
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
                    logger.info(f"Routes régénérées via randomTrips ({size} bytes, {vehicle_count} véhicules)")
                    return {
                        "status":        "fixed",
                        "method":        "randomTrips",
                        "vehicle_count": vehicle_count,
                        "patched_cfg":   patched_cfg,
                        "message":       f"{vehicle_count} routes validées ({size:,} bytes) — relancez la simulation",
                    }
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)

        # Fallback BFS
        logger.info("randomTrips indisponible — BFS topologie réseau")
        _generate_minimal_routes(rou_file, net_file, count=vehicle_count)
        size = os.path.getsize(rou_file)
        logger.info(f"Routes BFS générées ({size} bytes, {vehicle_count} véhicules)")
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
    """Retourne le scénario actif avec ses informations."""
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
    """
    Supprime définitivement un dossier de scénario archivé.
    Interdit sur les fichiers par défaut (racine maps/).
    """
    import shutil

    if SUMO_RUNNING:
        raise HTTPException(status_code=400, detail="Arrêtez la simulation avant de supprimer un scénario")

    # Sécurité : interdire la suppression de la racine maps/
    sc_dir = os.path.join(SUMO_DATA_DIR, scenario_id)
    if os.path.abspath(sc_dir) == os.path.abspath(SUMO_DATA_DIR):
        raise HTTPException(status_code=403, detail="Impossible de supprimer les fichiers par défaut")

    # Vérifier que c'est bien un sous-dossier de SUMO_DATA_DIR
    if not sc_dir.startswith(os.path.abspath(SUMO_DATA_DIR)):
        raise HTTPException(status_code=403, detail="Chemin non autorisé")

    if not os.path.isdir(sc_dir):
        raise HTTPException(status_code=404, detail=f"Scénario introuvable : {scenario_id}")

    # Si c'est le scénario actif, revenir au défaut
    if scenario_config is not None and scenario_config.get_active_scenario_id() == scenario_id:
        scenario_config.select_default()
        logger.info(f"Scénario actif supprimé → retour au défaut")

    try:
        shutil.rmtree(sc_dir)
        logger.info(f"✅ Scénario supprimé : {scenario_id}")
        return {"status": "deleted", "scenario_id": scenario_id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur suppression : {e}")


@fastapi_app.post("/scenario/deploy/{scenario_id}")
async def scenario_deploy(scenario_id: str):
    """
    Sélectionne un scénario (sans copier les fichiers).
    Utilise ScenarioConfigService si disponible.
    """
    if SUMO_RUNNING:
        raise HTTPException(status_code=400, detail="Arrêtez la simulation avant de changer de scénario")

    if scenario_config is not None:
        result = scenario_config.select_scenario(scenario_id)
        if not result["success"]:
            raise HTTPException(status_code=404, detail=result["message"])
        return {"status": "selected", "scenario_id": scenario_id, **result}

    # Fallback legacy
    if generate_service is not None:
        ok = generate_service.deploy_scenario(scenario_id)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Scénario introuvable : {scenario_id}")
        return {"status": "deployed", "scenario_id": scenario_id}

    raise HTTPException(status_code=500, detail="Aucun service de scénario disponible")


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