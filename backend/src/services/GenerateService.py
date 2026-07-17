# src/services/GenerateService.py
"""
Service de génération de scénarios SUMO — VERSION STABLE
- Génération réseau OSM ou synthétique
- Flux progressifs de véhicules
- Piétons sur trottoirs (non bloquant)
- Injection d'accidents
- Sauvegarde des scénarios
"""

import os
import shutil
import subprocess
import tempfile
import logging
import urllib.request
import xml.etree.ElementTree as ET
import random
from datetime import datetime
from typing import List, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


# ============================================================
# 1. UTILITAIRES
# ============================================================

def _find_random_trips() -> Optional[str]:
    candidates = [
        "/usr/share/sumo/tools/randomTrips.py",
        "/usr/local/share/sumo/tools/randomTrips.py",
        os.path.join(os.getenv("SUMO_HOME", ""), "tools", "randomTrips.py"),
        "/opt/sumo/tools/randomTrips.py",
    ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return None


def _download_osm(bbox: Dict, dest: str, timeout: int = 90) -> bool:
    url = (
        f"https://overpass-api.de/api/map?"
        f"bbox={bbox['min_lng']},{bbox['min_lat']},{bbox['max_lng']},{bbox['max_lat']}"
    )
    logger.info(f"📥 Téléchargement OSM : {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "TMT-TrafficControl/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as f:
            f.write(resp.read())
        size = os.path.getsize(dest)
        logger.info(f"✅ OSM téléchargé : {size:,} bytes")
        return size > 500
    except Exception as e:
        logger.warning(f"⚠️ Téléchargement OSM échoué : {e}")
        return False


def _netconvert_osm(osm_path: str, net_file: str, timeout: int = 120) -> bool:
    result = subprocess.run(
        [
            "netconvert",
            "--osm-files",       osm_path,
            "--output-file",     net_file,
            "--geometry.remove",
            "--roundabouts.guess",
            "--ramps.guess",
            "--junctions.join",
            "--tls.guess-signals",
            "--no-warnings",
            "--proj.utm",
        ],
        capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0 or not os.path.exists(net_file):
        logger.warning(f"netconvert stderr: {result.stderr[:400]}")
        return False
    logger.info("✅ Réseau OSM converti par netconvert")
    return True


def _netgenerate_grid(net_file: str, bbox: Dict, timeout: int = 60) -> bool:
    dlat = abs(bbox["max_lat"] - bbox["min_lat"])
    dlng = abs(bbox["max_lng"] - bbox["min_lng"])
    grid_x = max(5, min(15, int(dlng * 100)))
    grid_y = max(5, min(15, int(dlat * 100)))

    result = subprocess.run(
        [
            "netgenerate", "--grid",
            f"--grid.x-number={grid_x}",
            f"--grid.y-number={grid_y}",
            "--grid.x-length=150",
            "--grid.y-length=150",
            "--output-file", net_file,
            "--no-warnings",
        ],
        capture_output=True, text=True, timeout=timeout,
    )
    ok = result.returncode == 0 and os.path.exists(net_file)
    if ok:
        logger.info(f"✅ Réseau grille synthétique ({grid_x}×{grid_y})")
    else:
        logger.error(f"netgenerate stderr: {result.stderr[:400]}")
    return ok


def _rou_has_vehicles(path: str, min_count: int = 5) -> bool:
    try:
        if not os.path.exists(path) or os.path.getsize(path) < 100:
            return False
        tree = ET.parse(path)
        root = tree.getroot()
        vehicles = root.findall(".//vehicle") + root.findall(".//flow") + root.findall(".//trip")
        return len(vehicles) >= min_count
    except Exception:
        return False


def _is_motorized_edge(edge_elem) -> bool:
    lanes = edge_elem.findall("lane")
    if not lanes:
        return True
    for lane in lanes:
        allow = lane.get("allow", "")
        disallow = lane.get("disallow", "")
        speed = float(lane.get("speed", "13.9"))
        ped_only = {"pedestrian", "bicycle", "pedestrian bicycle", "bicycle pedestrian"}
        if allow and allow.strip() in ped_only:
            continue
        if speed < 3.0:
            continue
        return True
    return False


def _build_adjacency(net_file: str) -> dict:
    adj: dict = {}
    try:
        tree = ET.parse(net_file)
        root = tree.getroot()
        for e in root.findall(".//edge"):
            eid = e.get("id", "")
            if eid and not eid.startswith(":") and _is_motorized_edge(e):
                adj[eid] = []
        for conn in root.findall(".//connection"):
            frm = conn.get("from", "")
            to = conn.get("to", "")
            if frm and to and frm in adj and to in adj:
                if to not in adj[frm]:
                    adj[frm].append(to)
        logger.info(f"_build_adjacency: {len(adj)} edges motorisés")
    except Exception as e:
        logger.warning(f"_build_adjacency: {e}")
    return adj


def _bfs_route(adj: dict, start: str, max_depth: int = 25) -> list:
    from collections import deque
    best_path = [start]
    queue = deque([[start]])
    visited = {start}
    while queue:
        path = queue.popleft()
        if len(path) > len(best_path):
            best_path = path[:]
        if len(path) >= max_depth:
            continue
        for nxt in adj.get(path[-1], []):
            if nxt not in visited:
                visited.add(nxt)
                queue.append(path + [nxt])
    return best_path


# ============================================================
# 2. GÉNÉRATION DES ROUTES VÉHICULES
# ============================================================

def _generate_progressive_flows(rou_file: str, net_file: str, count: int, sim_duration: int = 3600):
    """Génère des flux progressifs de véhicules."""
    adj = _build_adjacency(net_file)
    edges = list(adj.keys())

    if not edges:
        logger.warning("Aucun edge trouvé — routes vides")
        with open(rou_file, "w") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n<routes/>\n')
        return

    random.seed(42)
    shuffled = list(edges)
    random.shuffle(shuffled)

    valid_routes = []
    for start in shuffled:
        path = _bfs_route(adj, start, max_depth=25)
        if len(path) >= 3 and path not in valid_routes:
            valid_routes.append(path)
        if len(valid_routes) >= max(count, 30):
            break

    if not valid_routes:
        logger.warning("Aucun chemin connecté — route single-edge")
        valid_routes = [[e] for e in edges[:min(count, len(edges))]]

    flow_phases = [
        (0, 300, 12, "car"),
        (300, 900, 6, "car"),
        (900, 1800, 3, "car"),
        (1800, 3600, 8, "car"),
        (3600, 5400, 10, "car"),
        (5400, sim_duration, 25, "car"),
    ]

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<routes>',
        '  <vType id="car" accel="2.6" decel="4.5" sigma="0.5" length="4.5" maxSpeed="50" speedFactor="1.0" speedDev="0.15"/>',
        '  <vType id="truck" accel="1.3" decel="3.0" sigma="0.7" length="8.0" maxSpeed="40" speedFactor="0.9" speedDev="0.1"/>',
        '  <vType id="bus" accel="1.2" decel="2.8" sigma="0.5" length="12.0" maxSpeed="35" speedFactor="0.85" speedDev="0.05"/>',
    ]

    route_ids = []
    for i, path in enumerate(valid_routes):
        rid = f"r{i}"
        lines.append(f'  <route id="{rid}" edges="{" ".join(path)}"/>')
        route_ids.append(rid)

    n_routes = len(route_ids)
    flow_counter = 0

    for begin, end, period, vtype in flow_phases:
        n_flows = min(n_routes, 8)
        for i in range(n_flows):
            rid = route_ids[i % n_routes]
            actual_type = random.choice(["car", "car", "car", "car", "truck"]) if vtype == "car" else vtype
            flow_id = f"flow_{flow_counter}"
            lines.append(
                f'  <flow id="{flow_id}" type="{actual_type}" route="{rid}"'
                f' begin="{begin}" end="{end}" period="{period}"/>'
            )
            flow_counter += 1

    # Camions
    for i in range(min(n_routes, 4)):
        rid = route_ids[i % n_routes]
        lines.append(
            f'  <flow id="truck_flow_{i}" type="truck" route="{rid}"'
            f' begin="900" end="5400" period="30"/>'
        )

    # Bus
    for i in range(min(n_routes, 2)):
        rid = route_ids[i % n_routes]
        lines.append(
            f'  <flow id="bus_flow_{i}" type="bus" route="{rid}"'
            f' begin="900" end="3600" period="60"/>'
        )

    lines.append("</routes>")
    with open(rou_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    logger.info(f"✅ Routes avec flux progressifs : {flow_counter} flows sur {len(route_ids)} routes")


# ============================================================
# 3. PIÉTONS SUR TROTTOIRS (NON BLOQUANT)
# ============================================================

def _add_sidewalks_safe(net_file: str):
    """
    Ajoute des trottoirs (sidewalks) aux routes existantes.
    VERSION SÉCURISÉE — ne plante pas si le fichier est invalide.
    """
    try:
        if not os.path.exists(net_file) or os.path.getsize(net_file) < 100:
            logger.warning("⚠️ Fichier réseau invalide, ignoré")
            return
        
        tree = ET.parse(net_file)
        root = tree.getroot()
        
        # Récupérer tous les edges
        edges = root.findall(".//edge")
        added_count = 0
        
        for edge in edges:
            eid = edge.get("id", "")
            if eid.startswith(":"):
                continue
            
            edge_type = edge.get("type", "")
            if edge_type in ["highway.residential", "highway.secondary", "highway.tertiary", "highway.service"]:
                lanes = edge.findall("lane")
                if lanes and len(lanes) > 0:
                    # Ajouter une lane piétonne
                    existing_lanes = len(lanes)
                    ped_lane_id = f"{eid}_ped"
                    
                    first_lane = lanes[0]
                    shape = first_lane.get("shape", "0,0 100,0")
                    length = first_lane.get("length", "100.0")
                    
                    ped_lane = ET.Element("lane", {
                        "id": ped_lane_id,
                        "index": str(existing_lanes),
                        "allow": "pedestrian",
                        "speed": "2.78",
                        "length": length,
                        "width": "1.50",
                        "shape": shape
                    })
                    edge.append(ped_lane)
                    added_count += 1
        
        # Ajouter le type footway
        types = root.findall(".//type")
        ped_type_exists = any(t.get("id") == "highway.footway" for t in types)
        
        if not ped_type_exists:
            ped_type = ET.Element("type", {
                "id": "highway.footway",
                "priority": "1",
                "numLanes": "1",
                "speed": "2.78",
                "allow": "pedestrian",
                "oneway": "1",
                "width": "1.50"
            })
            root.insert(0, ped_type)
        
        tree.write(net_file, encoding="unicode", xml_declaration=True)
        logger.info(f"✅ {added_count} trottoirs ajoutés")
        
    except ET.ParseError as e:
        logger.warning(f"⚠️ Erreur parsing XML, ignoré: {e}")
    except Exception as e:
        logger.warning(f"⚠️ Erreur ajout trottoirs, ignoré: {e}")


def _generate_pedestrians_safe(rou_file: str, net_file: str, ped_count: int, sim_duration: int = 3600):
    """
    Génère des piétons sur les trottoirs.
    VERSION SÉCURISÉE — ne bloque jamais la génération.
    """
    if ped_count <= 0:
        return
    
    try:
        if not os.path.exists(rou_file) or os.path.getsize(rou_file) < 100:
            logger.warning("⚠️ Fichier routes invalide, ignoré")
            return
        
        tree = ET.parse(rou_file)
        root = tree.getroot()
        
        # 1. Ajouter le type piéton
        if not root.find(".//vType[@vClass='pedestrian']"):
            ped_vtype = ET.Element("vType", {
                "id": "DEFAULT_PEDTYPE",
                "vClass": "pedestrian",
                "speed": "1.2",
                "width": "0.5",
                "length": "0.5",
                "guiShape": "pedestrian",
                "color": "0,0.8,0.8"
            })
            root.insert(0, ped_vtype)
        
        # 2. Utiliser les routes existantes pour les piétons
        existing_routes = root.findall(".//route")
        ped_edges = []
        
        for route in existing_routes[:5]:
            edges = route.get("edges", "")
            if edges:
                edge_list = edges.split()
                if len(edge_list) >= 2:
                    ped_edges.append(" ".join(edge_list[:2]))
        
        if not ped_edges:
            # Fallback: utiliser les edges du réseau
            try:
                net_tree = ET.parse(net_file)
                net_root = net_tree.getroot()
                for edge in net_root.findall(".//edge"):
                    eid = edge.get("id", "")
                    if eid and not eid.startswith(":"):
                        ped_edges.append(eid)
                        if len(ped_edges) >= 5:
                            break
            except:
                pass
        
        if not ped_edges:
            logger.warning("⚠️ Aucun edge pour piétons, ignoré")
            return
        
        # 3. Créer des routes piétonnes
        ped_route_ids = []
        for i in range(min(3, len(ped_edges) - 1)):
            if i + 1 < len(ped_edges):
                route_edges = f"{ped_edges[i]} {ped_edges[i+1]}"
                ped_route_id = f"ped_route_{i}"
                if not root.find(f".//route[@id='{ped_route_id}']"):
                    ped_route = ET.Element("route", {
                        "id": ped_route_id,
                        "edges": route_edges,
                        "allow": "pedestrian"
                    })
                    root.append(ped_route)
                ped_route_ids.append(ped_route_id)
        
        if not ped_route_ids:
            logger.warning("⚠️ Pas de routes piétonnes créées")
            return
        
        # 4. Ajouter des flux de piétons
        for i, route_id in enumerate(ped_route_ids):
            period = max(10, 60 // max(1, ped_count // 3))
            flow = ET.Element("flow", {
                "id": f"ped_flow_{i}",
                "type": "DEFAULT_PEDTYPE",
                "route": route_id,
                "begin": "0",
                "end": str(sim_duration),
                "period": str(period)
            })
            root.append(flow)
        
        # 5. Ajouter des piétons individuels
        for i in range(min(10, ped_count)):
            route_id = ped_route_ids[i % len(ped_route_ids)]
            person = ET.Element("person", {
                "id": f"person_{i}",
                "route": route_id,
                "depart": str(i * 10)
            })
            root.append(person)
        
        tree.write(rou_file, encoding="unicode", xml_declaration=True)
        logger.info(f"✅ {ped_count} piétons générés")
        
    except ET.ParseError as e:
        logger.warning(f"⚠️ Erreur parsing XML, ignoré: {e}")
    except Exception as e:
        logger.warning(f"⚠️ Erreur génération piétons, ignoré: {e}")


# ============================================================
# 4. ACCIDENTS
# ============================================================

def _find_nearest_edge(lat, lng, lane_positions):
    if not lane_positions:
        return None
    best_edge = None
    best_dist = float("inf")
    for eid, x, y in lane_positions:
        dx = (lng - x / 111320) * 1e5
        dy = (lat - y / 111320) * 1e5
        dist = dx * dx + dy * dy
        if dist < best_dist:
            best_dist = dist
            best_edge = eid
    return best_edge


ACCIDENT_CAUSES = {
    "collision": {"label": "Collision", "color": "1,0,0", "n_vehicles": 2},
    "panne": {"label": "Panne", "color": "1,0.5,0", "n_vehicles": 1},
    "feu_rouge": {"label": "Feu grillé", "color": "1,0.8,0", "n_vehicles": 2},
    "obstacle": {"label": "Obstacle", "color": "0.8,0,0.8", "n_vehicles": 1},
    "pietons": {"label": "Piétons", "color": "0,0.6,1", "n_vehicles": 1},
    "inconnu": {"label": "Inconnu", "color": "0.5,0.5,0.5", "n_vehicles": 1},
}

ACCIDENT_VTYPE = """  <vType id="ACCIDENT_VTYPE" accel="0.001" decel="9.0" maxSpeed="0.01"
         length="5.5" width="2.2" sigma="0.0"
         speedFactor="0.20" speedDev="0.0"
         guiShape="passenger" color="1,0,0"/>"""


def _inject_accidents(rou_file: str, accidents: List[Dict], net_file: str):
    try:
        net_tree = ET.parse(net_file)
        lane_positions = []
        edge_lengths = {}
        for edge in net_tree.getroot().findall(".//edge"):
            eid = edge.get("id", "")
            if eid.startswith(":"):
                continue
            for lane in edge.findall("lane"):
                shape = lane.get("shape", "")
                length = float(lane.get("length", "50"))
                if not shape:
                    continue
                first_pt = shape.split()[0].split(",")
                if len(first_pt) >= 2:
                    try:
                        lane_positions.append((eid, float(first_pt[0]), float(first_pt[1])))
                        edge_lengths[eid] = max(edge_lengths.get(eid, 0), length)
                    except ValueError:
                        pass

        rou_tree = ET.parse(rou_file)
        rou_root = rou_tree.getroot()

        vtype_el = ET.fromstring(ACCIDENT_VTYPE.strip())
        rou_root.insert(0, vtype_el)

        for i, acc in enumerate(accidents):
            edge = _find_nearest_edge(acc["lat"], acc["lng"], lane_positions)
            if not edge and lane_positions:
                edge = lane_positions[i % len(lane_positions)][0]
            if not edge:
                continue

            raw_cause = (acc.get("cause") or acc.get("type") or "inconnu").lower()
            if raw_cause not in ACCIDENT_CAUSES:
                raw_cause = random.choice(list(ACCIDENT_CAUSES.keys()))

            cause_info = ACCIDENT_CAUSES[raw_cause]
            n_veh = cause_info["n_vehicles"]
            edge_len = edge_lengths.get(edge, 50.0)
            depart_t = str(5 + i * 2)
            base_pos = max(3.0, min(edge_len * 0.4, edge_len - 10.0))

            for j in range(n_veh):
                pos_offset = j * 4.5
                start_pos = max(1.0, base_pos + pos_offset)
                end_pos = start_pos + 4.5
                if end_pos > edge_len - 1:
                    start_pos = max(1.0, edge_len - 10.0 - j * 5)
                    end_pos = start_pos + 4.5

                veh_id = f"accident_{raw_cause}_{i}" if n_veh == 1 else f"accident_{raw_cause}_{i}_{j}"

                route_el = ET.SubElement(rou_root, "route")
                route_el.set("id", f"acc_route_{i}_{j}")
                route_el.set("edges", edge)

                veh_el = ET.SubElement(rou_root, "vehicle")
                veh_el.set("id", veh_id)
                veh_el.set("type", "ACCIDENT_VTYPE")
                veh_el.set("route", f"acc_route_{i}_{j}")
                veh_el.set("depart", depart_t)
                veh_el.set("color", cause_info["color"])

                stop_el = ET.SubElement(veh_el, "stop")
                stop_el.set("edge", edge)
                stop_el.set("duration", "9999")
                stop_el.set("startPos", f"{start_pos:.1f}")
                stop_el.set("endPos", f"{end_pos:.1f}")
                stop_el.set("parking", "false")

                if j == 1:
                    veh_el.set("id", f"accident_{raw_cause}_{i}_b")

            logger.info(f"Accident #{i} ({raw_cause}) → edge {edge}")

        rou_tree.write(rou_file, encoding="unicode", xml_declaration=True)
        logger.info(f"✅ {len(accidents)} accidents injectés")

    except Exception as e:
        logger.warning(f"_inject_accidents : {e}")
        import traceback
        traceback.print_exc()


# ============================================================
# 5. CONFIGURATION SUMO
# ============================================================

def _write_sumocfg(cfg_file, net_name="casa.net.xml", rou_name="casa.rou.xml",
                   ped_name=None, end=3600):
    additional = f'\n        <additional-files value="{ped_name}"/>' if ped_name else ""
    content = f"""<?xml version="1.0" encoding="utf-8"?>
<configuration>
    <input>
        <net-file value="{net_name}" />
        <route-files value="{rou_name}" />{additional}
    </input>

    <time>
        <begin value="0" />
        <end value="86400" />
        <step-length value="0.1" />
    </time>

    <processing>
        <ignore-route-errors value="true" />
        <time-to-teleport value="120" />
        <time-to-teleport.highways value="-1" />
        <collision.action value="teleport" />
        <collision.mingap-factor value="0" />
        <max-depart-delay value="60" />
        <emergencydecel.warning-threshold value="1.1" />
    </processing>

    <routing>
        <routing-algorithm value="dijkstra" />
    </routing>

    <report>
        <no-warnings value="true" />
        <no-step-log value="true" />
    </report>
</configuration>
"""
    with open(cfg_file, "w", encoding="utf-8") as f:
        f.write(content)
    logger.info(f"✅ .sumocfg écrit : {cfg_file}")


# ============================================================
# 6. SERVICE PRINCIPAL
# ============================================================

class GenerateService:

    def __init__(self, sumo_data_dir: str):
        self.sumo_data_dir = sumo_data_dir
        os.makedirs(sumo_data_dir, exist_ok=True)

    async def generate(self, bbox, vehicle_count=50, pedestrian_count=20,
                       accidents=None, sim_duration=3600, scenario_name="") -> Dict:
        accidents = accidents or []
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_name = "".join(c for c in scenario_name.strip() if c.isalnum() or c in "-_ ")
        safe_name = safe_name.replace(" ", "_")[:40]
        scenario_id = safe_name if safe_name else f"scenario_{ts}"
        if os.path.exists(os.path.join(self.sumo_data_dir, scenario_id)):
            scenario_id = f"{scenario_id}_{ts}"

        tmpdir = tempfile.mkdtemp(prefix=f"sumo_{ts}_")
        log = []

        try:
            osm_path = os.path.join(tmpdir, "zone.osm")
            net_file = os.path.join(tmpdir, "generated.net.xml")
            rou_file = os.path.join(tmpdir, "generated.rou.xml")
            ped_file = os.path.join(tmpdir, "generated.ped.xml")
            ped_trips = os.path.join(tmpdir, "ped_trips.xml")
            cfg_file = os.path.join(tmpdir, "generated.sumocfg")

            # ── 1. Réseau ──────────────────────────────────────────────────────
            net_ok = False
            osm_method = "osm"

            osm_ok = _download_osm(bbox, osm_path)
            if osm_ok:
                net_ok = _netconvert_osm(osm_path, net_file)
                if net_ok:
                    log.append("✅ Réseau réel OSM → SUMO (netconvert)")
                    # ⭐ Ajout sécurisé des trottoirs
                    _add_sidewalks_safe(net_file)
                    log.append("✅ Trottoirs ajoutés")
                else:
                    log.append("⚠️ netconvert échoué → réseau synthétique")
                    osm_method = "grid"
            else:
                log.append("⚠️ Téléchargement OSM échoué → réseau synthétique")
                osm_method = "grid"

            if not net_ok:
                net_ok = _netgenerate_grid(net_file, bbox)
                if not net_ok:
                    raise RuntimeError("Impossible de générer le réseau SUMO")
                log.append("✅ Réseau synthétique en grille généré")
                _add_sidewalks_safe(net_file)
                log.append("✅ Trottoirs ajoutés au réseau synthétique")

            # ── 2. Routes véhicules ──────────────────────────────────────────
            _generate_progressive_flows(rou_file, net_file, vehicle_count, sim_duration)
            log.append(f"✅ {vehicle_count} véhicules avec flux progressifs")

            # ── 3. Piétons (sécurisé) ────────────────────────────────────────
            if pedestrian_count > 0:
                _generate_pedestrians_safe(rou_file, net_file, pedestrian_count, sim_duration)
                log.append(f"✅ {pedestrian_count} piétons générés")

            # ── 4. Accidents ───────────────────────────────────────────────────
            if accidents:
                _inject_accidents(rou_file, accidents, net_file)
                log.append(f"✅ {len(accidents)} accidents injectés")

            # ── 5. Configuration SUMO ──────────────────────────────────────────
            _write_sumocfg(cfg_file, end=sim_duration)
            log.append("✅ casa.sumocfg généré")

            # ── 6. Sauvegarde scénario ─────────────────────────────────────────
            scenario_dir = os.path.join(self.sumo_data_dir, scenario_id)
            os.makedirs(scenario_dir, exist_ok=True)

            deploy_map = {
                net_file: ("casa.net.xml", scenario_dir),
                rou_file: ("casa.rou.xml", scenario_dir),
                cfg_file: ("casa.sumocfg", scenario_dir),
            }

            deployed = []
            for src, (dst_name, dst_dir) in deploy_map.items():
                if not os.path.exists(src):
                    continue
                shutil.copy2(src, os.path.join(dst_dir, dst_name))
                active_dst = os.path.join(self.sumo_data_dir, dst_name)
                shutil.copy2(src, active_dst)
                deployed.append(dst_name)
                logger.info(f"📦 Déployé : {dst_name}")

            import json
            metadata = {
                "scenario_id": scenario_id,
                "generated_at": datetime.utcnow().isoformat(),
                "bbox": bbox,
                "vehicle_count": vehicle_count,
                "pedestrian_count": pedestrian_count,
                "accident_count": len(accidents),
                "sim_duration_s": sim_duration,
                "network_method": osm_method,
                "deployed_files": deployed,
                "scenario_name": scenario_name or scenario_id,
                "flow_progressive": True,
            }
            with open(os.path.join(scenario_dir, "metadata.json"), "w") as f:
                json.dump(metadata, f, indent=2)

            log.append(f"✅ Scénario archivé dans {scenario_id}/")

            return {
                "status": "deployed",
                "scenario_id": scenario_id,
                "message": f"Scénario généré — {vehicle_count} véhicules, {pedestrian_count} piétons",
                "deployed_files": deployed,
                "generation_log": log,
                "bbox": bbox,
                "network_method": osm_method,
            }

        except Exception as e:
            logger.error(f"❌ GenerateService.generate : {e}")
            import traceback
            traceback.print_exc()
            raise
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def list_scenarios(self) -> List[Dict]:
        import json
        scenarios = []
        for name in sorted(os.listdir(self.sumo_data_dir), reverse=True):
            path = os.path.join(self.sumo_data_dir, name)
            if not os.path.isdir(path) or not name.startswith("scenario_"):
                continue
            meta_path = os.path.join(path, "metadata.json")
            if os.path.exists(meta_path):
                try:
                    with open(meta_path) as f:
                        scenarios.append(json.load(f))
                except Exception:
                    scenarios.append({"scenario_id": name})
        return scenarios

    def get_active_scenario(self) -> Optional[str]:
        scenarios = self.list_scenarios()
        return scenarios[0]["scenario_id"] if scenarios else None

    def deploy_scenario(self, scenario_id: str) -> bool:
        src_dir = os.path.join(self.sumo_data_dir, scenario_id)
        if not os.path.isdir(src_dir):
            return False
        for fname in ["casa.net.xml", "casa.rou.xml", "casa.sumocfg"]:
            src = os.path.join(src_dir, fname)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(self.sumo_data_dir, fname))
        return True