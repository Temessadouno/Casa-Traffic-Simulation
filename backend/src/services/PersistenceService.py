# src/services/PersistenceService.py
from motor.motor_asyncio import AsyncIOMotorDatabase
from datetime import datetime
from typing import Dict, Any, Optional
import logging

logger = logging.getLogger(__name__)


class PersistenceService:

    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db

        # Collections — noms alignés avec ce que main.py lit
        self.journeys_collection        = db["journeys"]
        self.traffic_logs_collection    = db["traffic_logs"]   # steps GPS ego
        self.traffic_metrics_collection = db["traffic_metrics"]
        self.anomalies_collection       = db["anomalies"]
        self.predictions_collection     = db["predictions"]
        self.incidents_collection       = db["incidents"]
        self.alerts_collection          = db["alerts"]
        self.road_conditions_collection = db["road_conditions"]

    # ============================================================
    # INDEXES
    # ============================================================

    async def create_indexes(self):
        await self.journeys_collection.create_index("journey_id", unique=True)
        await self.traffic_logs_collection.create_index(
            [("journey_id", 1), ("timestamp", -1)])
        await self.traffic_metrics_collection.create_index(
            [("segment_id", 1), ("timestamp", -1)])
        await self.anomalies_collection.create_index(
            [("journey_id", 1), ("timestamp", -1)])
        await self.predictions_collection.create_index(
            [("journey_id", 1), ("segment_id", 1)])
        await self.incidents_collection.create_index([("timestamp", -1)])
        await self.alerts_collection.create_index([("timestamp", -1)])
        logger.info("✅ Index MongoDB créés")

    # ── alias utilisé au startup ──
    async def ensure_indexes(self):
        await self.create_indexes()

    # ============================================================
    # JOURNEYS
    # ============================================================

    async def create_journey(self, journey_id: str,
                              origin: Dict = None,
                              destination: Dict = None):
        """
        Crée un nouveau journey.
        origin / destination sont optionnels pour compatibilité
        avec les anciens appels à (journey_id, metadata).
        """
        doc = {
            "journey_id":       journey_id,
            "start_time":       datetime.utcnow(),
            "status":           "in_progress",
            "steps_count":      0,
            "anomalies_count":  0,
            "last_update":      datetime.utcnow(),
        }
        if origin:
            doc["origin"] = origin
        if destination:
            doc["destination"] = destination

        try:
            await self.journeys_collection.insert_one(doc)
            logger.info(f"✅ Journey créé: {journey_id}")
            return doc
        except Exception as e:
            logger.error(f"❌ create_journey error: {e}")
            return None

    async def finalize_journey(self, journey_id: str):
        """Marque le journey comme terminé et calcule les stats finales."""
        try:
            anomaly_count = await self.anomalies_collection.count_documents(
                {"journey_id": journey_id})
            prediction_count = await self.predictions_collection.count_documents(
                {"journey_id": journey_id})

            result = await self.journeys_collection.update_one(
                {"journey_id": journey_id},
                {"$set": {
                    "status":              "completed",
                    "end_time":            datetime.utcnow(),
                    "anomalies_detected":  anomaly_count,
                    "predictions_made":    prediction_count,
                }}
            )
            logger.info(
                f"✅ Journey finalisé: {journey_id} "
                f"(anomalies: {anomaly_count}, prédictions: {prediction_count})"
            )
            return result
        except Exception as e:
            logger.error(f"❌ finalize_journey error: {e}")
            return None

    # ── alias utilisé dans certaines versions ──
    async def close_journey(self, journey_id: str):
        return await self.finalize_journey(journey_id)

    # ============================================================
    # VEHICLE STEPS  (collection: traffic_logs)
    # ============================================================

    async def save_step(self, journey_id: str, point):
        """
        Sauvegarde un point GPS de l'ego.
        point : TrajectoryPoint (Pydantic v1 .dict() ou v2 .model_dump())
        """
        try:
            try:
                data = point.model_dump()          # Pydantic v2
            except AttributeError:
                data = point.dict()                # Pydantic v1

            doc = {"journey_id": journey_id, **data}
            await self.traffic_logs_collection.insert_one(doc)

            await self.journeys_collection.update_one(
                {"journey_id": journey_id},
                {"$inc": {"steps_count": 1},
                 "$set": {"last_update": datetime.utcnow()}}
            )
            return True
        except Exception as e:
            logger.error(f"❌ save_step error: {e}")
            return False

    # ============================================================
    # TRAFFIC METRICS
    # ============================================================

    async def save_traffic_metrics(self, metrics):
        try:
            try:
                doc = metrics.model_dump()
            except AttributeError:
                doc = metrics.dict()
            await self.traffic_metrics_collection.insert_one(doc)
            return True
        except Exception as e:
            logger.error(f"❌ save_traffic_metrics error: {e}")
            return False

    # ============================================================
    # ANOMALIES
    # ============================================================

    async def save_anomaly(self, journey_id: str, anomaly):
        try:
            try:
                data = anomaly.model_dump()
            except AttributeError:
                data = anomaly.dict()

            doc = {"journey_id": journey_id, **data}
            await self.anomalies_collection.insert_one(doc)

            # Incrémenter le compteur du journey
            await self.journeys_collection.update_one(
                {"journey_id": journey_id},
                {"$inc": {"anomalies_count": 1}}
            )
            return True
        except Exception as e:
            logger.error(f"❌ save_anomaly error: {e}")
            return False

    # ============================================================
    # PREDICTIONS
    # ============================================================

    async def save_prediction(self, journey_id: str, prediction):
        try:
            try:
                data = prediction.model_dump()
            except AttributeError:
                data = prediction.dict()

            doc = {"journey_id": journey_id, **data}
            await self.predictions_collection.insert_one(doc)
            return True
        except Exception as e:
            logger.error(f"❌ save_prediction error: {e}")
            return False

    # ============================================================
    # INCIDENTS
    # ============================================================

    async def save_incident(self, incident):
        try:
            try:
                doc = incident.model_dump()
            except AttributeError:
                doc = incident.dict()
            await self.incidents_collection.insert_one(doc)
            logger.warning(f"🚨 Incident sauvegardé: {incident.incident_type}")
            return True
        except Exception as e:
            logger.error(f"❌ save_incident error: {e}")
            return False

    # ============================================================
    # ALERTS
    # ============================================================

    async def save_alert(self, alert_data: Dict[str, Any]):
        try:
            doc = {**alert_data, "created_at": datetime.utcnow()}
            await self.alerts_collection.insert_one(doc)
            return True
        except Exception as e:
            logger.error(f"❌ save_alert error: {e}")
            return False

    # ============================================================
    # ROAD CONDITIONS
    # ============================================================

    async def save_road_condition(self, road_condition: Dict[str, Any]):
        try:
            doc = {**road_condition, "created_at": datetime.utcnow()}
            await self.road_conditions_collection.insert_one(doc)
            return True
        except Exception as e:
            logger.error(f"❌ save_road_condition error: {e}")
            return False

    # ============================================================
    # STATS (dashboard)
    # ============================================================

    async def get_statistics(self) -> Dict:
        return {
            "journeys":        await self.journeys_collection.count_documents({}),
            "steps":           await self.traffic_logs_collection.count_documents({}),
            "traffic_metrics": await self.traffic_metrics_collection.count_documents({}),
            "anomalies":       await self.anomalies_collection.count_documents({}),
            "predictions":     await self.predictions_collection.count_documents({}),
            "incidents":       await self.incidents_collection.count_documents({}),
            "alerts":          await self.alerts_collection.count_documents({}),
        }

    async def get_segment_statistics(self, segment_id: str,
                                      days: int = 7) -> Dict:
        from datetime import timedelta
        start = datetime.utcnow() - timedelta(days=days)
        pipeline = [
            {"$match": {"segment_id": segment_id,
                         "timestamp": {"$gte": start}}},
            {"$group": {
                "_id":        None,
                "mean_speed": {"$avg": "$average_speed"},
                "std_speed":  {"$stdDevSamp": "$average_speed"},
                "mean_volume": {"$avg": "$vehicle_count"},
                "sample_count": {"$sum": 1},
            }}
        ]
        result = await self.traffic_metrics_collection.aggregate(pipeline).to_list(1)
        if result:
            return result[0]
        return {"mean_speed": 30.0, "std_speed": 5.0,
                "mean_volume": 100.0, "sample_count": 0}