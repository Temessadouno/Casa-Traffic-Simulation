import traci
import time
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Any
from src.models.trafficAiModels import (
    GeoPoint, TrafficMetrics, TrafficPrediction,
    Incident, AnomalyDetection, PredictionRequest, PredictionHorizon,
    DataPreprocessor, TrafficCondition, TrajectoryPoint
)
import traceback
import numpy as np
from collections import deque
import asyncio


class SumoEngineService:

    def __init__(self, persistence, safety, prediction_service=None):
        self.persistence = persistence
        self.safety = safety
        self.prediction_service = prediction_service
        self.vehicles = {}
        self.simulation_active = False

        self.traffic_buffer = deque(maxlen=1000)
        self.segment_metrics = {}
        self.anomaly_history = []
        self.prediction_cache = {}

        self.prediction_interval = 60
        self.last_prediction_time = None

        self.vehicle_id = "ego"

    # ─────────────────────────────────────────────
    # CONNECTION CHECK
    # ─────────────────────────────────────────────

    def is_connected(self):
        try:
            return traci.isLoaded()
        except Exception:
            return False

    # ─────────────────────────────────────────────
    # COLLECTE DE DONNÉES POUR L'IA
    # ─────────────────────────────────────────────

    def collect_traffic_metrics(self) -> Dict[str, TrafficMetrics]:
        metrics = {}
        try:
            for edge_id in traci.edge.getIDList():
                if edge_id.startswith(":"):
                    continue
                try:
                    lane_count = traci.edge.getLaneNumber(edge_id)
                    total_vehicles = 0
                    total_speed = 0.0
                    total_occupancy = 0.0
                    speeds = []

                    for lane_idx in range(lane_count):
                        lane_id = f"{edge_id}_{lane_idx}"
                        vehicles_on_lane = traci.lane.getLastStepVehicleNumber(lane_id)
                        total_vehicles += vehicles_on_lane
                        speed = traci.lane.getLastStepMeanSpeed(lane_id)
                        if speed > 0:
                            total_speed += speed * vehicles_on_lane
                            speeds.extend([speed] * vehicles_on_lane)
                        occupancy = traci.lane.getLastStepOccupancy(lane_id)
                        total_occupancy += occupancy

                    avg_speed = total_speed / total_vehicles if total_vehicles > 0 else 0
                    avg_occupancy = total_occupancy / lane_count if lane_count > 0 else 0
                    segment_length = traci.lane.getLength(f"{edge_id}_0")
                    density = (total_vehicles / segment_length) * 1000 if segment_length > 0 else 0

                    speed_percentile_25 = np.percentile(speeds, 25) if speeds else None
                    speed_percentile_75 = np.percentile(speeds, 75) if speeds else None
                    speed_std_dev = np.std(speeds) if speeds else None

                    metric = TrafficMetrics(
                        segment_id=edge_id,
                        timestamp=datetime.utcnow(),
                        vehicle_count=total_vehicles,
                        average_speed=avg_speed * 3.6,
                        occupancy=avg_occupancy,
                        density=density,
                        speed_percentile_25=speed_percentile_25 * 3.6 if speed_percentile_25 else None,
                        speed_percentile_75=speed_percentile_75 * 3.6 if speed_percentile_75 else None,
                        speed_std_dev=speed_std_dev * 3.6 if speed_std_dev else None
                    )
                    metric.calculate_level_of_service()
                    metric.calculate_traffic_condition()
                    metrics[edge_id] = metric
                    self.traffic_buffer.append(metric)
                    self.segment_metrics[edge_id] = metric
                except Exception as e:
                    continue
        except Exception as e:
            print(f"❌ Erreur collecte métriques globale: {e}")
        return metrics

    def detect_anomalies(self, current_metrics: TrafficMetrics,
                         historical_window: int = 10) -> Optional[AnomalyDetection]:
        try:
            historical = [
                m for m in self.traffic_buffer
                if m.segment_id == current_metrics.segment_id
            ][-historical_window:]
            if len(historical) < 5:
                return None
            historical_speeds = [m.average_speed for m in historical]
            mean_speed = np.mean(historical_speeds)
            std_speed = np.std(historical_speeds)
            deviation = (current_metrics.average_speed - mean_speed) / std_speed if std_speed > 0 else 0
            if abs(deviation) > 2.0:
                anomaly_score = min(1.0, abs(deviation) / 5.0)
                severity = 'high' if abs(deviation) > 3.0 else ('medium' if abs(deviation) > 2.5 else 'low')
                anomaly = AnomalyDetection(
                    anomaly_id=f"anom_{current_metrics.segment_id}_{datetime.utcnow().timestamp()}",
                    timestamp=datetime.utcnow(),
                    segment_id=current_metrics.segment_id,
                    metric_name="speed",
                    expected_value=mean_speed,
                    actual_value=current_metrics.average_speed,
                    deviation=deviation,
                    anomaly_score=anomaly_score,
                    anomaly_type='point',
                    severity=severity,
                    is_incident_related=False
                )
                self.anomaly_history.append(anomaly)
                return anomaly
        except Exception as e:
            print(f"⚠️ Erreur détection anomalie: {e}")
        return None

    async def predict_traffic(self, segment_ids: List[str],
                              horizon: PredictionHorizon = PredictionHorizon.SHORT) -> List[TrafficPrediction]:
        if not self.prediction_service:
            return self._simple_prediction(segment_ids, horizon)
        try:
            request = PredictionRequest(
                segment_ids=segment_ids,
                prediction_horizon=horizon,
                include_confidence=True
            )
            predictions = await self.prediction_service.predict_traffic(request)
            for pred in predictions:
                self.prediction_cache[pred.segment_id] = {
                    'prediction': pred,
                    'timestamp': datetime.utcnow()
                }
            return predictions
        except Exception as e:
            print(f"❌ Erreur prédiction IA: {e}")
            return self._simple_prediction(segment_ids, horizon)

    def _simple_prediction(self, segment_ids: List[str],
                           horizon: PredictionHorizon) -> List[TrafficPrediction]:
        predictions = []
        for segment_id in segment_ids:
            if segment_id not in self.segment_metrics:
                continue
            historical = [
                m for m in self.traffic_buffer
                if m.segment_id == segment_id
            ][-20:]
            if len(historical) < 3:
                continue
            recent_speeds = [m.average_speed for m in historical[-5:]]
            mean_recent = np.mean(recent_speeds)
            std_recent = np.std(recent_speeds)
            predicted_speed = mean_recent
            try:
                segment_length = traci.lane.getLength(f"{segment_id}_0") / 1000
                predicted_travel_time = (segment_length / (predicted_speed / 60)) if predicted_speed > 0 else 0
            except Exception:
                predicted_travel_time = 0
            historical_volumes = [m.vehicle_count for m in historical[-10:]]
            predicted_volume = int(np.mean(historical_volumes)) if historical_volumes else 0
            prediction = TrafficPrediction(
                prediction_id=f"pred_{segment_id}_{datetime.utcnow().timestamp()}",
                segment_id=segment_id,
                timestamp=datetime.utcnow(),
                prediction_horizon=horizon,
                predicted_speed=round(predicted_speed, 1),
                predicted_travel_time=round(predicted_travel_time, 1),
                predicted_volume=predicted_volume,
                confidence_lower=round(mean_recent - std_recent, 1),
                confidence_upper=round(mean_recent + std_recent, 1),
                model_name="simple_moving_average",
                model_version="1.0.0",
                confidence_score=0.7 if len(historical) > 10 else 0.5
            )
            predictions.append(prediction)
        return predictions

    # ─────────────────────────────────────────────
    # STATISTIQUES
    # ─────────────────────────────────────────────

    def get_traffic_statistics(self) -> Dict:
        if not self.segment_metrics:
            return {"status": "no_data"}
        speeds = [m.average_speed for m in self.segment_metrics.values()]
        volumes = [m.vehicle_count for m in self.segment_metrics.values()]
        return {
            "timestamp": datetime.utcnow().isoformat(),
            "total_segments": len(self.segment_metrics),
            "average_speed": round(np.mean(speeds), 1) if speeds else 0,
            "median_speed": round(np.median(speeds), 1) if speeds else 0,
            "total_vehicles": sum(volumes),
            "congestion_level": self._calculate_congestion_level(),
            "anomalies_count": len(self.anomaly_history),
            "predictions_cached": len(self.prediction_cache),
            "ai_enabled": self.prediction_service is not None
        }

    def _calculate_congestion_level(self) -> str:
        if not self.segment_metrics:
            return "unknown"
        congested = sum(1 for m in self.segment_metrics.values()
                        if m.traffic_condition in [TrafficCondition.CONGESTED, TrafficCondition.GRIDLOCK])
        ratio = congested / len(self.segment_metrics) if self.segment_metrics else 0
        if ratio < 0.2: return "low"
        elif ratio < 0.5: return "medium"
        else: return "high"

    def cleanup(self):
        self.traffic_buffer.clear()
        self.segment_metrics.clear()
        self.anomaly_history.clear()
        self.prediction_cache.clear()
        print("SumoEngineService cleaned up")

    # ─────────────────────────────────────────────
    # CONVERSION GPS ↔ SUMO XY
    # ─────────────────────────────────────────────

    def _geo_to_xy(self, lat: float, lng: float):
        try:
            x, y = traci.simulation.convertGeo(lng, lat, fromGeo=True)
            return x, y
        except Exception as e:
            print(f"❌ _geo_to_xy error ({lat}, {lng}): {e}")
            return None

    def _is_motorized_lane(self, lane_id: str) -> bool:
        """Vérifie qu'une lane accepte les véhicules motorisés (passenger)."""
        try:
            allowed    = traci.lane.getAllowed(lane_id)    # liste de classes autorisées
            disallowed = traci.lane.getDisallowed(lane_id)
            speed      = traci.lane.getMaxSpeed(lane_id)

            # Vitesse très basse → probablement piéton
            if speed < 2.8:  # < 10 km/h
                return False

            # Si une liste allowed est définie et n'inclut pas passenger/motor
            pedestrian_only = {"pedestrian", "bicycle"}
            if allowed and set(allowed).issubset(pedestrian_only):
                return False

            # Si passenger est explicitement interdit
            if "passenger" in disallowed or "motorized" in disallowed:
                return False

            return True
        except Exception:
            return True  # En cas d'erreur, on suppose motorisé

    def _nearest_motorized_edge(self, lat: float, lng: float) -> Optional[str]:
        """
        Trouve l'edge motorisé le plus proche d'un point GPS.
        Filtre les edges piétons/cyclistes.
        """
        xy = self._geo_to_xy(lat, lng)
        if xy is None:
            return None

        x, y = xy
        best_edge = None
        best_dist = float("inf")

        try:
            for eid in traci.edge.getIDList():
                if eid.startswith(":"):
                    continue
                try:
                    lane_count = traci.edge.getLaneNumber(eid)
                    # Vérifier qu'au moins une lane est motorisée
                    has_motorized = any(
                        self._is_motorized_lane(f"{eid}_{i}")
                        for i in range(lane_count)
                    )
                    if not has_motorized:
                        continue

                    for lane_idx in range(lane_count):
                        lane_id = f"{eid}_{lane_idx}"
                        if not self._is_motorized_lane(lane_id):
                            continue
                        shape = traci.lane.getShape(lane_id)
                        if not shape:
                            continue
                        for px, py in [shape[0], shape[-1]]:
                            dist = ((px - x) ** 2 + (py - y) ** 2) ** 0.5
                            if dist < best_dist:
                                best_dist = dist
                                best_edge = eid
                except Exception:
                    continue

        except Exception as e:
            print(f"⚠️ _nearest_motorized_edge error: {e}")

        if best_edge:
            print(f"   Edge motorisé trouvé : {best_edge} (dist={best_dist:.1f}m)")
        else:
            print("   ❌ Aucun edge motorisé trouvé")

        return best_edge

    # Alias pour compatibilité
    def _nearest_edge(self, lat: float, lng: float) -> Optional[str]:
        return self._nearest_motorized_edge(lat, lng)

    # ─────────────────────────────────────────────
    # VEHICLE MANAGEMENT
    # ─────────────────────────────────────────────

    def _find_valid_route(self, start_edge: str, end_edge: str):
        """
        Tente de trouver une route valide entre deux edges.
        Retourne (route, start, end) ou (None, None, None).
        """
        # Tentative directe
        try:
            route = traci.simulation.findRoute(start_edge, end_edge)
            if route and route.edges:
                return route, start_edge, end_edge
        except Exception as e:
            print(f"   findRoute({start_edge} → {end_edge}) échoué: {e}")

        # Tentative avec edges motorisés du réseau
        print("   Recherche d'une route alternative sur edges motorisés…")
        try:
            all_edges = [
                e for e in traci.edge.getIDList()
                if not e.startswith(":")
                and traci.edge.getLaneNumber(e) > 0
                and self._is_motorized_lane(f"{e}_0")
            ]

            # Essayer plusieurs paires d'edges éloignées
            step = max(1, len(all_edges) // 20)
            for s_idx in range(0, min(len(all_edges), 40), step):
                s = all_edges[s_idx]
                for e_idx in range(len(all_edges) - 1, max(0, len(all_edges) - 40), -step):
                    e = all_edges[e_idx]
                    if s == e:
                        continue
                    try:
                        route = traci.simulation.findRoute(s, e)
                        if route and route.edges:
                            print(f"   ✅ Route alternative : {s} → {e} ({len(route.edges)} edges)")
                            return route, s, e
                    except Exception:
                        continue
        except Exception as ex:
            print(f"   ❌ Recherche alternative échouée: {ex}")

        return None, None, None

    def create_vehicle(self, origin=None, destination=None):
        try:
            if not self.is_connected():
                print("❌ TraCI non connecté")
                return False

            v_id = self.vehicle_id
            start_edge = None
            end_edge = None

            if origin and destination:
                print(f"🗺️  Mapping GPS → edges motorisés SUMO")
                print(f"   Origin      : lat={origin['lat']} lng={origin['lng']}")
                print(f"   Destination : lat={destination['lat']} lng={destination['lng']}")

                start_edge = self._nearest_motorized_edge(origin["lat"], origin["lng"])
                end_edge   = self._nearest_motorized_edge(destination["lat"], destination["lng"])

                print(f"   Start edge  : {start_edge}")
                print(f"   End edge    : {end_edge}")

            # Si le mapping GPS a échoué ou donne deux edges identiques
            if not start_edge or not end_edge or start_edge == end_edge:
                print("⚠️  Mapping GPS insuffisant — fallback sur edges motorisés")
                try:
                    motorized_edges = [
                        e for e in traci.edge.getIDList()
                        if not e.startswith(":")
                        and traci.edge.getLaneNumber(e) > 0
                        and self._is_motorized_lane(f"{e}_0")
                    ]
                    if len(motorized_edges) >= 2:
                        step = max(1, len(motorized_edges) // 8)
                        start_edge = motorized_edges[step]
                        end_edge   = motorized_edges[-(step + 1)]
                        print(f"   Fallback motorisé : {start_edge} → {end_edge}")
                except Exception as fe:
                    print(f"   Fallback error: {fe}")

            # Trouver une route valide
            route, actual_start, actual_end = self._find_valid_route(start_edge, end_edge)

            if not route or not route.edges:
                print("❌ Aucune route calculable sur ce réseau")
                return False

            route_id = f"ego_route_{int(time.time())}"
            traci.route.add(route_id, route.edges)
            print(f"✅ Route enregistrée : {route_id} ({len(route.edges)} edges)")

            # Supprimer l'ancien véhicule ego si présent
            if v_id in traci.vehicle.getIDList():
                try:
                    traci.vehicle.remove(v_id)
                    traci.simulationStep()
                except Exception:
                    pass

            traci.vehicle.add(
                vehID=v_id,
                routeID=route_id,
                typeID="DEFAULT_VEHTYPE",
                depart="now",
            )
            traci.vehicle.setColor(v_id, (255, 50, 50, 255))
            traci.vehicle.setSpeedMode(v_id, 31)

            print(f"✅ Véhicule ego prêt")
            return True

        except Exception as e:
            print("❌ create_vehicle error:", e)
            traceback.print_exc()
            return False

    # ─────────────────────────────────────────────
    # SIMULATION STEP
    # ─────────────────────────────────────────────

    async def simulate_step(self, journey_id: str, sio, sid=None):
        try:
            if not self.is_connected():
                print("❌ TraCI non connecté")
                return False

            traci.simulationStep()
            traffic_metrics = self.collect_traffic_metrics()

            if self.persistence:
                for metric in traffic_metrics.values():
                    try:
                        await self.persistence.save_traffic_metrics(metric)
                    except Exception as e:
                        print(f"⚠️ save_traffic_metrics error: {e}")

            anomalies = []
            for metric in traffic_metrics.values():
                anomaly = self.detect_anomalies(metric)
                if anomaly:
                    anomalies.append(anomaly)
                    await sio.emit("traffic_anomaly", {
                        "segment_id": anomaly.segment_id,
                        "anomaly_type": anomaly.anomaly_type,
                        "severity": anomaly.severity,
                        "deviation": anomaly.deviation,
                        "expected_speed": anomaly.expected_value,
                        "actual_speed": anomaly.actual_value,
                        "anomaly_score": anomaly.anomaly_score
                    }, room=sid)
                    if self.persistence:
                        await self.persistence.save_anomaly(journey_id, anomaly)

            for anomaly in anomalies:
                if anomaly.severity in ["high", "medium"]:
                    speed_val = anomaly.actual_value
                    if speed_val < 5:
                        condition_text = "route bloquée (trafic arrêté)"
                        sev = "critical"
                    elif speed_val < 15:
                        condition_text = f"fort ralentissement ({speed_val:.0f} km/h)"
                        sev = "warning"
                    else:
                        condition_text = f"trafic perturbé (déviation {anomaly.deviation:.1f}σ)"
                        sev = "info"
                    await sio.emit("road_alert", {
                        "title": f"Perturbation sur {anomaly.segment_id[:12]}",
                        "message": f"Segment {anomaly.segment_id}: {condition_text}",
                        "segment_id": anomaly.segment_id,
                        "current_speed": speed_val,
                        "expected_speed": anomaly.expected_value,
                        "severity": sev,
                        "timestamp": datetime.utcnow().isoformat(),
                    }, room=sid)

            current_time = datetime.utcnow()
            if (self.last_prediction_time is None or
                    (current_time - self.last_prediction_time).total_seconds() >= self.prediction_interval):
                active_segments = list(traffic_metrics.keys())[:10]
                if active_segments:
                    predictions = await self.predict_traffic(active_segments)
                    for pred in predictions:
                        await sio.emit("traffic_prediction", {
                            "segment_id": pred.segment_id,
                            "prediction_horizon": pred.prediction_horizon.value,
                            "predicted_speed": pred.predicted_speed,
                            "predicted_travel_time": pred.predicted_travel_time,
                            "predicted_volume": pred.predicted_volume,
                            "confidence_lower": pred.confidence_lower,
                            "confidence_upper": pred.confidence_upper,
                            "confidence_score": pred.confidence_score
                        }, room=sid)
                        if self.persistence:
                            await self.persistence.save_prediction(journey_id, pred)
                    self.last_prediction_time = current_time

            v_id = self.vehicle_id
            vehicles = traci.vehicle.getIDList()

            if v_id not in vehicles:
                print(f"⚠️ Véhicule {v_id} disparu — recréation")
                return self.create_vehicle()

            try:
                leader = traci.vehicle.getLeader(v_id, 20)
                if leader:
                    _, dist = leader
                    if dist < 5:
                        traci.vehicle.setSpeed(v_id, 0)
                    elif dist < 15:
                        traci.vehicle.setSpeed(v_id, 5)
                    else:
                        traci.vehicle.setSpeed(v_id, -1)
                else:
                    traci.vehicle.setSpeed(v_id, -1)
            except Exception as e:
                print("⚠️ Speed control error:", e)

            x, y = traci.vehicle.getPosition(v_id)
            try:
                lon, lat = traci.simulation.convertGeo(x, y)
                if not (-8.5 < lon < -6.0 and 32.5 < lat < 35.0):
                    return True
            except Exception:
                return True

            speed = traci.vehicle.getSpeed(v_id)
            angle = traci.vehicle.getAngle(v_id)
            point = TrajectoryPoint(
                timestamp=datetime.utcnow(),
                coords=GeoPoint(lat=lat, lng=lon),
                speed=round(speed * 3.6, 2),
                heading=angle,
            )
            if self.persistence:
                await self.persistence.save_step(journey_id, point)

            await sio.emit("vehicle_state", {
                "id": v_id,
                "lat": lat,
                "lng": lon,
                "speed": round(speed * 3.6, 2),
                "heading": angle,
            }, room=sid)

            if traffic_metrics:
                summary = {
                    "timestamp": datetime.utcnow().isoformat(),
                    "total_segments": len(traffic_metrics),
                    "conditions": {
                        "flowing": sum(1 for m in traffic_metrics.values()
                                       if m.traffic_condition == TrafficCondition.FLOWING),
                        "moderate": sum(1 for m in traffic_metrics.values()
                                        if m.traffic_condition == TrafficCondition.MODERATE),
                        "congested": sum(1 for m in traffic_metrics.values()
                                         if m.traffic_condition == TrafficCondition.CONGESTED),
                        "gridlock": sum(1 for m in traffic_metrics.values()
                                        if m.traffic_condition == TrafficCondition.GRIDLOCK)
                    },
                    "anomalies_detected": len(anomalies)
                }
                await sio.emit("traffic_summary", summary, room=sid)

            return True

        except Exception as e:
            print("❌ simulate_step error:", e)
            traceback.print_exc()
            return False

    # ─────────────────────────────────────────────
    # ROUTE COMPUTATION
    # ─────────────────────────────────────────────

    def compute_and_set_route(self, origin, destination):
        try:
            return self.create_vehicle(origin=origin, destination=destination)
        except Exception as e:
            print("❌ route error:", e)
            traceback.print_exc()
            return None

    async def get_optimal_route(self, origin: GeoPoint, destination: GeoPoint) -> Optional[Dict]:
        try:
            start_edge = self._nearest_motorized_edge(origin.lat, origin.lng)
            end_edge   = self._nearest_motorized_edge(destination.lat, destination.lng)
            if not start_edge or not end_edge:
                return None
            route = traci.simulation.findRoute(start_edge, end_edge)
            if not route or not route.edges:
                return None
            total_time = 0
            segment_times = []
            for edge_id in route.edges:
                if edge_id in self.prediction_cache:
                    pred = self.prediction_cache[edge_id]['prediction']
                    segment_times.append({
                        "segment": edge_id,
                        "predicted_time": pred.predicted_travel_time,
                        "confidence": pred.confidence_score
                    })
                    total_time += pred.predicted_travel_time
                else:
                    try:
                        max_speed = traci.edge.getMaxSpeed(edge_id)
                        length = traci.lane.getLength(f"{edge_id}_0") / 1000
                        estimated_time = (length / max_speed) * 60 if max_speed > 0 else 0
                        segment_times.append({
                            "segment": edge_id,
                            "predicted_time": estimated_time,
                            "confidence": 0.5
                        })
                        total_time += estimated_time
                    except Exception:
                        segment_times.append({"segment": edge_id, "predicted_time": 0, "confidence": 0})
            return {
                "route": route.edges,
                "total_edges": len(route.edges),
                "estimated_travel_time_minutes": round(total_time, 1),
                "segment_details": segment_times,
                "confidence": np.mean([s["confidence"] for s in segment_times]) if segment_times else 0
            }
        except Exception as e:
            print(f"❌ Erreur calcul route optimale: {e}")
            return None


# ─────────────────────────────────────────────
# SERVICE DE PRÉDICTION
# ─────────────────────────────────────────────

class TrafficPredictionService:

    def __init__(self, model_path: Optional[str] = None):
        self.model = None
        self.preprocessor = DataPreprocessor()
        if model_path:
            self.load_model(model_path)

    def load_model(self, model_path: str):
        pass

    async def predict_traffic(self, request: PredictionRequest) -> List[TrafficPrediction]:
        predictions = []
        for segment_id in request.segment_ids:
            prediction = TrafficPrediction(
                prediction_id=f"pred_{segment_id}_{datetime.utcnow().timestamp()}",
                segment_id=segment_id,
                timestamp=datetime.utcnow(),
                prediction_horizon=request.prediction_horizon,
                predicted_speed=35.0,
                predicted_travel_time=5.0,
                predicted_volume=50,
                confidence_lower=30.0,
                confidence_upper=40.0,
                model_name="lstm_v1",
                model_version="1.0.0",
                confidence_score=0.85
            )
            predictions.append(prediction)
        return predictions

    async def _extract_features(self, segment_id: str, request: PredictionRequest) -> Dict:
        current_time = request.prediction_time or datetime.utcnow()
        return {
            'segment_id': segment_id,
            'time_features': self.preprocessor.create_time_features(current_time),
            'prediction_horizon': request.prediction_horizon.value
        }