import traci
import time
from datetime import datetime
from src.models.traffic_models import TrajectoryPoint, GeoPoint
import traceback


class SumoEngineService:

    def __init__(self, persistence, safety):
        self.persistence = persistence
        self.safety      = safety
        self.vehicles    = {}
        self.simulation_active = False

        # ID du véhicule tracké — doit correspondre à MapSolo.trackedVehicleId
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
    # CONVERT GPS → SUMO XY
    # ─────────────────────────────────────────────
    def _geo_to_xy(self, lat: float, lng: float):
        """
        Convertit des coordonnées GPS (lat, lng) en coordonnées SUMO (x, y).
        traci.simulation.convertGeo attend (longitude, latitude, fromGeo=True).
        Retourne (x, y) ou None si la conversion échoue.
        """
        try:
            x, y = traci.simulation.convertGeo(lng, lat, fromGeo=True)
            return x, y
        except Exception as e:
            print(f"❌ _geo_to_xy error ({lat}, {lng}): {e}")
            return None

    # ─────────────────────────────────────────────
    # FIND NEAREST EDGE FROM GPS
    # ─────────────────────────────────────────────
    def _nearest_edge(self, lat: float, lng: float):
        """
        Trouve l'edge SUMO le plus proche d'une position GPS.
        Stratégie : convertir en XY puis mesurer la distance
        au premier point de chaque lane.
        Retourne edge_id (str) ou None.
        """
        xy = self._geo_to_xy(lat, lng)
        if xy is None:
            return None

        x, y = xy
        best_edge = None
        best_dist = float("inf")

        try:
            for eid in traci.edge.getIDList():
                # Ignorer les edges internes aux jonctions
                if eid.startswith(":"):
                    continue
                try:
                    lane_count = traci.edge.getLaneNumber(eid)
                    for lane_idx in range(lane_count):
                        lane_id = f"{eid}_{lane_idx}"
                        shape   = traci.lane.getShape(lane_id)
                        if not shape:
                            continue
                        # Tester le premier et le dernier point du lane
                        for px, py in [shape[0], shape[-1]]:
                            dist = ((px - x) ** 2 + (py - y) ** 2) ** 0.5
                            if dist < best_dist:
                                best_dist = dist
                                best_edge = eid
                except Exception:
                    continue

        except Exception as e:
            print(f"⚠️ _nearest_edge error: {e}")

        if best_edge:
            print(f"   Edge trouvé : {best_edge} (dist={best_dist:.1f}m)")
        else:
            print("   ❌ Aucun edge trouvé")

        return best_edge

    # ─────────────────────────────────────────────
    # CREATE EGO VEHICLE
    # ─────────────────────────────────────────────
    def create_vehicle(self, origin=None, destination=None):
        """
        Crée le véhicule ego sur une route calculée depuis les
        coordonnées GPS origin → destination.
        Si le mapping GPS → edge échoue, utilise une route de secours.
        """
        try:
            if not self.is_connected():
                print("❌ TraCI non connecté")
                return False

            v_id = self.vehicle_id

            # ── 1. Mapping GPS → edges SUMO ──
            start_edge = None
            end_edge   = None

            if origin and destination:
                print(f"🗺️  Mapping GPS → edges SUMO")
                print(f"   Origin      : lat={origin['lat']} lng={origin['lng']}")
                print(f"   Destination : lat={destination['lat']} lng={destination['lng']}")

                start_edge = self._nearest_edge(origin["lat"],      origin["lng"])
                end_edge   = self._nearest_edge(destination["lat"], destination["lng"])

                print(f"   Start edge  : {start_edge}")
                print(f"   End edge    : {end_edge}")

            # ── 2. Fallback si le mapping a échoué ──
            if not start_edge or not end_edge or start_edge == end_edge:
                print("⚠️  Mapping GPS insuffisant — fallback sur edges du réseau")
                valid = [e for e in traci.edge.getIDList() if not e.startswith(":")]
                if len(valid) < 2:
                    print("❌ Réseau insuffisant")
                    return False
                step       = max(1, len(valid) // 8)
                start_edge = valid[step]
                end_edge   = valid[-(step + 1)]
                print(f"   Fallback : {start_edge} → {end_edge}")

            # ── 3. Trouver la route ──
            route = traci.simulation.findRoute(start_edge, end_edge)

            if not route or not route.edges:
                print(f"❌ findRoute({start_edge} → {end_edge}) impossible")
                # Chercher une paire d'edges qui fonctionne
                valid = [e for e in traci.edge.getIDList() if not e.startswith(":")]
                found = False
                for s in valid[::15]:
                    for e in reversed(valid[::15]):
                        if s == e:
                            continue
                        r = traci.simulation.findRoute(s, e)
                        if r and r.edges:
                            route      = r
                            start_edge = s
                            end_edge   = e
                            found      = True
                            print(f"✅ Route alternative : {s} → {e} ({len(r.edges)} edges)")
                            break
                    if found:
                        break

                if not found:
                    print("❌ Aucune route calculable sur ce réseau")
                    return False

            route_id = f"ego_route_{int(time.time())}"
            traci.route.add(route_id, route.edges)
            print(f"✅ Route enregistrée : {route_id} ({len(route.edges)} edges)")

            # ── 4. Supprimer l'ancien ego ──
            if v_id in traci.vehicle.getIDList():
                try:
                    traci.vehicle.remove(v_id)
                    traci.simulationStep()   # step pour valider la suppression
                except Exception:
                    pass

            # ── 5. Ajouter le véhicule ──
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

            v_id     = self.vehicle_id
            vehicles = traci.vehicle.getIDList()

            # Véhicule disparu → recréer sans coordonnées GPS
            if v_id not in vehicles:
                print(f"⚠️ Véhicule {v_id} disparu — recréation")
                return self.create_vehicle()

            # ── SAFETY — distance au véhicule devant ──
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

            # ── POSITION SUMO XY ──
            x, y = traci.vehicle.getPosition(v_id)

            # ── XY → GPS ──
            # convertGeo(x, y) retourne (longitude, latitude) — ordre SUMO
            try:
                lon, lat = traci.simulation.convertGeo(x, y)

                # Sanity check : zone Casablanca
                if not (-8.5 < lon < -6.0 and 32.5 < lat < 35.0):
                    print(
                        f"⚠️ Position hors zone Casa: lat={lat:.5f} lon={lon:.5f} "
                        f"(x={x:.1f} y={y:.1f}) — step ignoré"
                    )
                    return True   # on continue sans émettre de mauvaise position

            except Exception as e:
                print(f"⚠️ convertGeo error: {e}")
                return True

            speed = traci.vehicle.getSpeed(v_id)
            angle = traci.vehicle.getAngle(v_id)

            # ── PERSIST ──
            point = TrajectoryPoint(
                timestamp=datetime.utcnow(),
                coords=GeoPoint(lat=lat, lng=lon),
                speed=round(speed * 3.6, 2),
                heading=angle,
            )
            await self.persistence.save_step(journey_id, point)

            # ── EMIT ──
            await sio.emit(
                "vehicle_state",
                {
                    "id":      v_id,
                    "lat":     lat,
                    "lng":     lon,
                    "speed":   round(speed * 3.6, 2),
                    "heading": angle,
                },
                room=sid,
            )

            return True

        except Exception as e:
            print("❌ simulate_step error:", e)
            traceback.print_exc()
            return False

    # ─────────────────────────────────────────────
    # ROUTE COMPUTATION
    # ─────────────────────────────────────────────
    def compute_and_set_route(self, origin, destination):
        """
        Point d'entrée depuis main.py.
        Passe les coordonnées GPS à create_vehicle pour le mapping.
        """
        try:
            return self.create_vehicle(origin=origin, destination=destination)
        except Exception as e:
            print("❌ route error:", e)
            traceback.print_exc()
            return None