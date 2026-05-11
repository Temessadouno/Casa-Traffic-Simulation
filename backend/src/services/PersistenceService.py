# src/services/PersistenceService.py
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class PersistenceService:
    def __init__(self, db):
        self.db = db
        self.journeys_collection = db["journeys"]
        self.traffic_logs_collection = db["traffic_logs"]
        self.accidents_collection = db["accidents"]  # 🔥 ajout analyse accidents

    # =========================
    # CREATE JOURNEY
    # =========================
    async def create_journey(self, journey_id, origin, destination):
        try:
            document = {
                "journey_id": journey_id,
                "origin": origin,
                "destination": destination,
                "start_time": datetime.utcnow(),
                "status": "in_progress",
                "steps_count": 0,
                "last_update": datetime.utcnow()
            }

            await self.journeys_collection.insert_one(document)

            logger.info(f"✅ Journey créé: {journey_id}")
            return document

        except Exception as e:
            logger.error(f"❌ create_journey error: {e}")
            return None

    # =========================
    # SAVE TRAFFIC STEP (REAL TIME)
    # =========================
    async def save_step(self, journey_id: str, point):
        try:
            document = {
                "journey_id": journey_id,
                "timestamp": point.timestamp if hasattr(point, "timestamp") else datetime.utcnow(),
                "coords": {
                    "lat": point.coords.lat,
                    "lng": point.coords.lng
                },
                "speed": float(point.speed),
                "heading": float(point.heading)
            }

            await self.traffic_logs_collection.insert_one(document)

            # update journey summary (LIGHTWEIGHT)
            await self.journeys_collection.update_one(
                {"journey_id": journey_id},
                {
                    "$inc": {"steps_count": 1},
                    "$set": {"last_update": datetime.utcnow()}
                }
            )

            return True

        except Exception as e:
            logger.error(f"❌ save_step error: {e}")
            return False

    # =========================
    # ACCIDENT DETECTION (NEW)
    # =========================
    async def save_accident(self, vehicle_id: str, position, speed):
        try:
            accident = {
                "vehicle_id": vehicle_id,
                "timestamp": datetime.utcnow(),
                "position": {
                    "x": position[0],
                    "y": position[1]
                },
                "speed": speed,
                "severity": "high" if speed < 1 else "medium"
            }

            await self.accidents_collection.insert_one(accident)

            logger.warning(f"🚨 Accident détecté: {vehicle_id}")
            return accident

        except Exception as e:
            logger.error(f"❌ save_accident error: {e}")
            return None

    # =========================
    # FINALIZE JOURNEY
    # =========================
    async def finalize_journey(self, journey_id: str):
        try:
            result = await self.journeys_collection.update_one(
                {"journey_id": journey_id},
                {
                    "$set": {
                        "status": "completed",
                        "end_time": datetime.utcnow()
                    }
                }
            )

            logger.info(f"✅ Journey finalisé: {journey_id}")
            return result

        except Exception as e:
            logger.error(f"❌ finalize_journey error: {e}")
            return None