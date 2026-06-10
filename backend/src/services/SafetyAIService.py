# src/services/SafetyAIService.py
from src.models.trafficAiModels import GeoPoint, AnomalyDetection, Incident, IncidentType
import traci
import math
import logging
from datetime import datetime
from typing import Optional, Dict, List, Tuple
from collections import deque

logger = logging.getLogger(__name__)


class SafetyAIService:
    def __init__(self, sio, persistence_service=None):
        self.sio = sio
        self.persistence = persistence_service
        self.vehicle_history = {}
        self.history_maxlen = 100
        self.config = {
            "danger_zone_distance":          10.0,
            "warning_zone_distance":         25.0,
            "high_speed_threshold":          15.0,
            "low_speed_threshold":            5.0,
            "emergency_brake_deceleration":   4.5,
            "time_to_collision_threshold":    3.0,
            "trajectory_prediction_horizon":  2.0,
        }

    # ── Geometry helpers ─────────────────────────────────────────────────────

    def _distance(self, p1: Tuple, p2: Tuple) -> float:
        return math.sqrt((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2)

    def _calculate_ttc(self, my_pos, my_speed, my_heading,
                       other_pos, other_speed, other_heading) -> Optional[float]:
        dx = other_pos[0] - my_pos[0]
        dy = other_pos[1] - my_pos[1]
        rx = other_speed*math.cos(math.radians(other_heading)) - my_speed*math.cos(math.radians(my_heading))
        ry = other_speed*math.sin(math.radians(other_heading)) - my_speed*math.sin(math.radians(my_heading))
        rel_dist  = math.sqrt(dx**2 + dy**2)
        rel_speed = math.sqrt(rx**2 + ry**2)
        if rel_speed <= 0.1:
            return None
        ttc = rel_dist / rel_speed
        if rel_dist > 0:
            cos_theta = (dx*rx + dy*ry) / (rel_dist * rel_speed)
            if cos_theta > 0:   # vehicles diverging
                return None
        return ttc

    # ── History ──────────────────────────────────────────────────────────────

    def _update_vehicle_history(self, v_id: str, pos, speed: float, heading: float):
        if v_id not in self.vehicle_history:
            self.vehicle_history[v_id] = deque(maxlen=self.history_maxlen)
        self.vehicle_history[v_id].append({
            "timestamp": datetime.utcnow(),
            "pos": pos, "speed": speed, "heading": heading,
        })

    def _analyze_driving_behavior(self, v_id: str) -> Dict:
        if v_id not in self.vehicle_history or len(self.vehicle_history[v_id]) < 5:
            return {"risk_score": 0.0, "behavior": "normal",
                    "avg_speed_change": 0.0, "avg_heading_change": 0.0}
        history  = list(self.vehicle_history[v_id])
        speeds   = [h["speed"]   for h in history]
        headings = [h["heading"] for h in history]
        sc = [abs(speeds[i]-speeds[i-1])     for i in range(1, len(speeds))]
        hc = [abs(headings[i]-headings[i-1]) for i in range(1, len(headings))]
        avg_sc = sum(sc)/len(sc) if sc else 0
        avg_hc = sum(hc)/len(hc) if hc else 0
        risk_score = min(1.0, avg_sc/3.0)*0.6 + min(1.0, avg_hc/30.0)*0.4
        return {
            "risk_score":        round(risk_score, 2),
            "behavior":          "erratic" if risk_score > 0.5 else "normal",
            "avg_speed_change":  round(avg_sc, 2),
            "avg_heading_change": round(avg_hc, 2),
        }

    def _detect_traffic_anomaly(self, vehicles_data: List[Dict]) -> Optional[Dict]:
        if len(vehicles_data) < 3:
            return None
        avg_speed    = sum(v["speed"] for v in vehicles_data) / len(vehicles_data)
        slow         = [v for v in vehicles_data if v["speed"] < 5.0]
        slow_ratio   = len(slow) / len(vehicles_data)
        if slow_ratio > 0.5 and avg_speed < 8.0:
            return {
                "type":              "sudden_slowdown",
                "severity":          "high" if slow_ratio > 0.7 else "medium",
                "affected_vehicles": len(slow),
                "avg_speed":         round(avg_speed, 1),
            }
        return None

    # ── Main risk detection ───────────────────────────────────────────────────

    async def check_proximity_risk(self, v_id: str, current_pos) -> Dict:
        """
        Detects collision risks, erratic driving, and traffic anomalies.

        Parameters
        ----------
        v_id : str
            Ego vehicle ID in SUMO.
        current_pos : GeoPoint or None
            GPS position used to persist incidents. If None, incident saving
            is skipped (no Pydantic crash).
        """
        try:
            if not traci.isLoaded():
                return {"risk_detected": False, "level": "none"}

            vehicles = traci.vehicle.getIDList()
            if v_id not in vehicles:
                return {"risk_detected": False, "level": "none"}

            my_pos     = traci.vehicle.getPosition(v_id)
            my_speed   = traci.vehicle.getSpeed(v_id)
            my_heading = traci.vehicle.getAngle(v_id)
            self._update_vehicle_history(v_id, my_pos, my_speed, my_heading)

            risk_detected   = False
            risk_level      = "none"
            risk_factors    = []
            nearest_vehicle = None
            min_distance    = float("inf")
            min_ttc         = float("inf")
            vehicles_data   = []

            for vid in vehicles:
                if vid == v_id:
                    continue
                pos     = traci.vehicle.getPosition(vid)
                speed   = traci.vehicle.getSpeed(vid)
                heading = traci.vehicle.getAngle(vid)
                self._update_vehicle_history(vid, pos, speed, heading)
                vehicles_data.append({"id": vid, "speed": speed, "pos": pos})

                dist = self._distance(my_pos, pos)
                ttc  = self._calculate_ttc(my_pos, my_speed, my_heading, pos, speed, heading)

                if dist < min_distance:
                    min_distance    = dist
                    nearest_vehicle = vid
                if ttc and ttc < min_ttc:
                    min_ttc = ttc

                # Rule 1 – immediate danger
                if dist < self.config["danger_zone_distance"]:
                    risk_detected = True
                    risk_level    = "critical"
                    risk_factors.append({"type": "immediate_collision",
                                         "distance": round(dist, 2), "severity": "CRITICAL"})
                    break

                # Rule 2 – critical TTC
                if ttc and ttc < 2.0:
                    risk_detected = True
                    risk_level    = "critical"
                    risk_factors.append({"type": "time_to_collision",
                                         "ttc": round(ttc, 2), "severity": "CRITICAL"})
                    break

                # Rule 3 – warning zone
                if dist < self.config["warning_zone_distance"]:
                    risk_detected = True
                    if risk_level != "critical":
                        risk_level = "warning"
                    risk_factors.append({"type": "proximity_warning",
                                         "distance": round(dist, 2), "severity": "MEDIUM"})

                # Rule 4 – moderate TTC
                if ttc and 2.0 <= ttc < self.config["time_to_collision_threshold"]:
                    risk_detected = True
                    if risk_level != "critical":
                        risk_level = "warning"
                    risk_factors.append({"type": "moderate_ttc",
                                         "ttc": round(ttc, 2), "severity": "MEDIUM"})

                # Rule 5 – high speed + close proximity
                if dist < 30 and my_speed > self.config["high_speed_threshold"]:
                    risk_detected = True
                    risk_factors.append({"type": "high_speed_proximity",
                                         "distance": round(dist, 2),
                                         "speed": round(my_speed*3.6, 1),
                                         "severity": "MEDIUM"})

            # Erratic driving
            behavior = self._analyze_driving_behavior(v_id)
            if behavior["risk_score"] > 0.6:
                risk_detected = True
                if risk_level != "critical":
                    risk_level = "warning" if behavior["risk_score"] > 0.8 else "advisory"
                risk_factors.append({
                    "type":       "erratic_driving",
                    "behavior":   behavior["behavior"],
                    "risk_score": behavior["risk_score"],
                    "severity":   "HIGH" if behavior["risk_score"] > 0.8 else "MEDIUM",
                })

            # Traffic anomaly
            traffic_anomaly = self._detect_traffic_anomaly(vehicles_data)
            if traffic_anomaly:
                anomaly = AnomalyDetection(
                    anomaly_id=f"anom_{v_id}_{datetime.utcnow().timestamp()}",
                    timestamp=datetime.utcnow(),
                    segment_id="unknown",
                    metric_name="traffic_flow",
                    expected_value=0, actual_value=0, deviation=0,
                    anomaly_score=0.7, anomaly_type="contextual",
                    severity=traffic_anomaly["severity"],
                )
                if self.persistence:
                    await self.persistence.save_anomaly("safety_monitoring", anomaly)
                risk_factors.append({
                    "type":     "traffic_anomaly",
                    "details":  traffic_anomaly,
                    "severity": traffic_anomaly["severity"].upper(),
                })

            # Emit alert
            if risk_detected:
                d_str     = f"{min_distance:.0f}m" if min_distance != float("inf") else "?"
                ttc_str   = f"{min_ttc:.1f}s"      if min_ttc      != float("inf") else "?"
                speed_kmh = round(my_speed * 3.6, 1)

                if risk_level == "critical":
                    title = "Risque de collision imminent"
                    msg   = f"Vehicule {v_id} a {d_str} de {nearest_vehicle} - TTC {ttc_str} - {speed_kmh} km/h"
                    rec   = "FREINAGE D'URGENCE"
                elif risk_level == "warning":
                    title = "Proximite dangereuse"
                    msg   = f"Vehicule {v_id} trop proche de {nearest_vehicle} ({d_str}) - Ralentir"
                    rec   = "REDUIRE LA VITESSE"
                else:
                    title = "Vigilance"
                    msg   = f"Conduite irreguliere sur {v_id} - score {behavior['risk_score']:.0%}"
                    rec   = "RESTER VIGILANT"

                await self.sio.emit("emergency_alert", {
                    "event":             "COLLISION_WARNING",
                    "title":             title,
                    "message":           msg,
                    "vehicle_id":        v_id,
                    "nearest_vehicle":   nearest_vehicle,
                    "distance":          round(min_distance, 2) if min_distance != float("inf") else None,
                    "time_to_collision": round(min_ttc, 2)      if min_ttc      != float("inf") else None,
                    "speed":             speed_kmh,
                    "risk_level":        risk_level,
                    "risk_factors":      risk_factors,
                    "driving_behavior":  behavior,
                    "recommendation":    rec,
                    "timestamp":         datetime.utcnow().isoformat(),
                })
                logger.warning(f"Risk {risk_level}: {v_id} | {nearest_vehicle} | {min_distance:.1f}m")

                # ── FIX : current_pos=None guard ────────────────────────────
                # Pydantic crashait silencieusement quand current_pos=None était
                # passé comme `location` d'un Incident (champ obligatoire GeoPoint).
                if self.persistence and risk_level in ("critical", "warning") and current_pos is not None:
                    try:
                        incident = Incident(
                            incident_id=f"inc_{v_id}_{datetime.utcnow().timestamp()}",
                            incident_type=(IncidentType.ACCIDENT
                                           if risk_level == "critical"
                                           else IncidentType.BREAKDOWN),
                            location=current_pos,
                            description=f"Risque {risk_level} detecte sur {v_id}",
                            severity=5 if risk_level == "critical" else 3,
                            estimated_duration=5 if risk_level == "critical" else 2,
                        )
                        await self.persistence.save_incident(incident)
                    except Exception as inc_err:
                        logger.warning(f"save_incident skipped: {inc_err}")

            return {
                "risk_detected":    risk_detected,
                "level":            risk_level,
                "risk_factors":     risk_factors,
                "min_distance":     round(min_distance, 2) if min_distance != float("inf") else None,
                "min_ttc":          round(min_ttc, 2)      if min_ttc      != float("inf") else None,
                "driving_behavior": behavior,
            }

        except Exception as e:
            logger.error(f"SafetyAI error: {e}")
            import traceback; traceback.print_exc()
            return {"risk_detected": False, "level": "none", "error": str(e)}

    async def check_proximity_risk_simple(self, v_id: str, current_pos) -> bool:
        result = await self.check_proximity_risk(v_id, current_pos)
        return result.get("risk_detected", False)

    async def get_safety_statistics(self) -> Dict:
        try:
            total = len(traci.vehicle.getIDList()) if traci.isLoaded() else 0
            risky = sum(1 for vid in self.vehicle_history
                        if self._analyze_driving_behavior(vid)["risk_score"] > 0.5)
            return {
                "total_vehicles":   total,
                "tracked_vehicles": len(self.vehicle_history),
                "risky_drivers":    risky,
                "risk_percentage":  round(risky/len(self.vehicle_history)*100, 1)
                                    if self.vehicle_history else 0,
                "config":           self.config,
            }
        except Exception as e:
            logger.error(f"get_safety_statistics error: {e}")
            return {}

    def update_config(self, new_config: Dict):
        self.config.update(new_config)
        logger.info(f"SafetyAI config updated: {self.config}")