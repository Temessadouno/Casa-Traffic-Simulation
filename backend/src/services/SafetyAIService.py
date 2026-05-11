from src.models.traffic_models import GeoPoint
import traci
import math
import logging

logger = logging.getLogger(__name__)


class SafetyAIService:
    def __init__(self, sio):
        self.sio = sio

    # =========================
    # DISTANCE CALCULATION
    # =========================
    def _distance(self, p1, p2):
        return math.sqrt((p1[0] - p2[0])**2 + (p1[1] - p2[1])**2)

    # =========================
    # MAIN RISK DETECTION
    # =========================
    async def check_proximity_risk(self, v_id: str, current_pos: GeoPoint):
        try:
            if not traci.isLoaded():
                return

            vehicles = traci.vehicle.getIDList()

            my_pos = traci.vehicle.getPosition(v_id)
            my_speed = traci.vehicle.getSpeed(v_id)

            risk_detected = False
            nearest_vehicle = None
            min_distance = float("inf")

            # =========================
            # SCAN ALL VEHICLES
            # =========================
            for vid in vehicles:
                if vid == v_id:
                    continue

                pos = traci.vehicle.getPosition(vid)
                speed = traci.vehicle.getSpeed(vid)

                dist = self._distance(my_pos, pos)

                if dist < min_distance:
                    min_distance = dist
                    nearest_vehicle = vid

                # =========================
                # COLLISION RISK RULES
                # =========================

                # 🚨 danger zone
                if dist < 10:
                    risk_detected = True
                    break

                # 🚨 high speed + close
                if dist < 25 and my_speed > 15:
                    risk_detected = True
                    break

            # =========================
            # SEND ALERT
            # =========================
            if risk_detected and nearest_vehicle:

                alert_payload = {
                    "event": "COLLISION_WARNING",
                    "vehicle_id": v_id,
                    "nearest_vehicle": nearest_vehicle,
                    "distance": round(min_distance, 2),
                    "speed": round(my_speed, 2),
                    "severity": "HIGH" if min_distance < 10 else "MEDIUM",
                    "recommendation": "EMERGENCY_BRAKE"
                }

                await self.sio.emit("emergency_alert", alert_payload)

                logger.warning(f"🚨 Risk detected: {v_id} -> {nearest_vehicle}")

            return risk_detected

        except Exception as e:
            logger.error(f"SafetyAI error: {e}")
            return False