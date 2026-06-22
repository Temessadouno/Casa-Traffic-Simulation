# src/services/GenerateService.py
"""
Service de génération de scénarios SUMO — VERSION CORRIGÉE

Corrections appliquées :
  FIX 1 — randomTrips : supprimer --edge-permission passenger (trop restrictif OSM)
  FIX 2 — injection sur toute la durée sim + flows continus (pas juste 60s)
  FIX 3 — validation duarouter : vérifier que le fichier contient des <vehicle>
  FIX 4 — sumocfg : step-length 0.1 pour fluidité maximale
  FIX 5 — _generate_minimal_routes : flows plus denses et mieux répartis
"""

import os
import shutil
import subprocess
import tempfile
import logging
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import List, Dict, Optional, Tuple

logger = logging.getLogger(__name__)


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
    """Vérifie qu'un fichier .rou.xml contient au moins min_count véhicules ou flows."""
    try:
        if not os.path.exists(path) or os.path.getsize(path) < 100:
            return False
        tree = ET.parse(path)
        root = tree.getroot()
        vehicles = root.findall(".//vehicle") + root.findall(".//flow") + root.findall(".//trip")
        return len(vehicles) >= min_count
    except Exception:
        return False


def _generate_routes_random_trips(
    random_trips: str,
    net_file: str,
    trips_file: str,
    rou_file: str,
    count: int,
    end: int = 3600,
    pedestrians: bool = False,
    timeout: int = 120,
) -> bool:
    """
    FIX 1 : Suppression de --edge-permission passenger (trop restrictif pour OSM Casablanca)
    FIX 2 : Injection sur toute la durée sim (end=sim_duration) avec period adapté
    """
    label  = "piétons" if pedestrians else "véhicules"

    # FIX 2 : period calculé sur toute la durée → véhicules injectés en continu
    period = max(1.0, end / max(1, count))
    logger.info(f"Injection {count} {label} sur {end}s (period={period:.1f}s)")

    # ── Tentative 1 : avec --validate, sans restriction edge-permission ──
    base_args = [
        "-n",       net_file,
        "-o",       trips_file,
        "-r",       rou_file,
        "--period", str(period),
        "--begin",  "0",
        "--end",    str(end),
        "--no-warnings",
        "--fringe-factor", "5",
        "--min-distance",  "100",
    ]

    if pedestrians:
        base_args += ["--pedestrians"]
    else:
        # FIX 1 : PAS de --edge-permission ni --vehicle-class
        # Ces options rejettent trop d'edges dans les réseaux OSM non annotés
        base_args += ["--allow-fringe-speed", "true"]

    cmd1 = ["python3", random_trips] + base_args + ["--validate"]
    result = subprocess.run(cmd1, capture_output=True, text=True, timeout=timeout)
    if result.returncode == 0 and _rou_has_vehicles(rou_file):
        logger.info(f"✅ Routes {label} validées ({count}) [--validate sans edge-permission]")
        return True
    logger.warning(f"randomTrips tentative 1 échouée: {result.stderr[:200]}")

    # ── Tentative 2 : sans --validate, period plus court ──
    if os.path.exists(rou_file): os.remove(rou_file)
    period2 = max(0.5, period / 2)
    base_args2 = [
        "-n", net_file, "-o", trips_file, "-r", rou_file,
        "--period", str(period2), "--end", str(end),
        "--no-warnings", "--fringe-factor", "10",
        "--min-distance", "50",
    ]
    if pedestrians:
        base_args2.append("--pedestrians")

    cmd2 = ["python3", random_trips] + base_args2
    result2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=timeout)
    if result2.returncode == 0 and _rou_has_vehicles(rou_file):
        logger.info(f"✅ Routes {label} ({count}) [sans validation]")
        return True
    logger.warning(f"randomTrips tentative 2 échouée: {result2.stderr[:200]}")

    # ── Tentative 3 : paramètres minimaux ──
    if os.path.exists(rou_file): os.remove(rou_file)
    cmd3 = [
        "python3", random_trips,
        "-n", net_file, "-o", trips_file, "-r", rou_file,
        "--period", "2", "--end", str(end), "--no-warnings",
    ]
    if pedestrians:
        cmd3.append("--pedestrians")
    result3 = subprocess.run(cmd3, capture_output=True, text=True, timeout=timeout)
    if result3.returncode == 0 and _rou_has_vehicles(rou_file):
        logger.info(f"✅ Routes {label} [params minimaux]")
        return True

    logger.warning(f"randomTrips toutes tentatives échouées")
    return False


def _is_motorized_edge(edge_elem) -> bool:
    lanes = edge_elem.findall("lane")
    if not lanes:
        return True
    for lane in lanes:
        allow    = lane.get("allow",    "")
        disallow = lane.get("disallow", "")
        speed    = float(lane.get("speed", "13.9"))
        ped_only_allows = {"pedestrian", "bicycle", "pedestrian bicycle", "bicycle pedestrian"}
        if allow and allow.strip() in ped_only_allows:
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
            to  = conn.get("to",   "")
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
    queue     = deque([[start]])
    visited   = {start}
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


def _generate_minimal_routes(rou_file: str, net_file: str, count: int, sim_duration: int = 3600):
    """
    FIX 5 : flows continus bien répartis + injection initiale dense
    """
    adj    = _build_adjacency(net_file)
    edges  = list(adj.keys())

    if not edges:
        logger.warning("Aucun edge trouvé — routes vides")
        with open(rou_file, "w") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n<routes/>\n')
        return

    import random as _rnd
    _rnd.seed(42)
    shuffled = list(edges)
    _rnd.shuffle(shuffled)

    valid_routes: list = []
    for start in shuffled:
        path = _bfs_route(adj, start, max_depth=25)
        if len(path) >= 3 and path not in valid_routes:
            valid_routes.append(path)
        if len(valid_routes) >= max(count, 30):
            break

    if not valid_routes:
        logger.warning("Aucun chemin connecté — route single-edge")
        valid_routes = [[e] for e in edges[:min(count, len(edges))]]

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<routes>',
        # sigma=0.5 = conducteurs imparfaits → pas de convoi synchronisé
        # tau=0.8 = réaction rapide → moins de stops
        # speedDev=0.2 = variabilité de vitesse → trafic naturel
        '  <vType id="DEFAULT_VEHTYPE" accel="2.6" decel="4.5" maxSpeed="22.22"'
        ' speedFactor="1.1" speedDev="0.2" sigma="0.5" length="4.5"'
        ' minGap="1.5" tau="0.8" lcStrategic="1.0" lcCooperative="0.5"/>',
        # Camions — plus lents, créent de la congestion naturelle
        '  <vType id="TRUCK_VEHTYPE" accel="1.2" decel="3.0" maxSpeed="16.0"'
        ' speedFactor="0.9" speedDev="0.1" sigma="0.3" length="8.0"'
        ' minGap="2.5" tau="1.2" guiShape="truck"/>',
    ]

    route_ids = []
    for i, path in enumerate(valid_routes):
        rid = f"r{i}"
        lines.append(f'  <route id="{rid}" edges="{" ".join(path)}"/>')
        route_ids.append(rid)

    # Injection initiale dense : tous les véhicules en 60s
    for i in range(count):
        rid    = route_ids[i % len(route_ids)]
        depart = round(i * 60.0 / max(1, count), 2)
        vtype  = "TRUCK_VEHTYPE" if i % 8 == 0 else "DEFAULT_VEHTYPE"  # 1/8 camions
        lines.append(f'  <vehicle id="veh{i}" type="{vtype}" route="{rid}" depart="{depart}"/>')

    # Flows continus très denses — un véhicule toutes les 3-8s par route
    # pour maintenir une densité élevée pendant toute la simulation
    n_flows = min(len(route_ids), 30)
    # period = nb secondes entre chaque véhicule par flow
    # Pour count=100 véhicules sur 30 flows : 1 veh/3s par flow
    flow_period = max(3, 90 // max(1, n_flows))
    for i in range(n_flows):
        rid   = route_ids[i % len(route_ids)]
        vtype = "TRUCK_VEHTYPE" if i % 6 == 0 else "DEFAULT_VEHTYPE"
        lines.append(
            f'  <flow id="flow{i}" type="{vtype}" route="{rid}"'
            f' begin="60" end="{sim_duration}" period="{flow_period}"/>'
        )

    lines.append("</routes>")
    with open(rou_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    logger.info(f"✅ Routes BFS : {count} véhicules + {n_flows} flows continus")


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
    "collision": {"label": "Collision",             "color": "1,0,0",      "n_vehicles": 2},
    "panne":     {"label": "Panne / Arrêt brusque", "color": "1,0.5,0",    "n_vehicles": 1},
    "feu_rouge": {"label": "Grillage de feu",       "color": "1,0.8,0",    "n_vehicles": 2},
    "obstacle":  {"label": "Obstacle sur route",    "color": "0.8,0,0.8",  "n_vehicles": 1},
    "pietons":   {"label": "Piétons sur route",     "color": "0,0.6,1",    "n_vehicles": 1},
    "inconnu":   {"label": "Accident inconnu",      "color": "0.5,0.5,0.5","n_vehicles": 1},
}

ACCIDENT_VTYPE = """  <vType id="ACCIDENT_VTYPE" accel="0.001" decel="9.0" maxSpeed="0.01"
         length="5.5" width="2.2" sigma="0.0"
         speedFactor="0.20" speedDev="0.0"
         guiShape="passenger" color="1,0,0"/>"""

def _inject_accidents(rou_file: str, accidents: List[Dict], net_file: str):
    try:
        net_tree = ET.parse(net_file)
        lane_positions: List[Tuple] = []
        edge_lengths: dict = {}
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
                import random
                raw_cause = random.choice(list(ACCIDENT_CAUSES.keys()))

            cause_info = ACCIDENT_CAUSES[raw_cause]
            n_veh      = cause_info["n_vehicles"]
            edge_len   = edge_lengths.get(edge, 50.0)
            depart_t   = str(5 + i * 2)
            base_pos   = max(3.0, min(edge_len * 0.4, edge_len - 10.0))

            for j in range(n_veh):
                pos_offset = j * 4.5
                start_pos  = max(1.0, base_pos + pos_offset)
                end_pos    = start_pos + 4.5
                if end_pos > edge_len - 1:
                    start_pos = max(1.0, edge_len - 10.0 - j * 5)
                    end_pos   = start_pos + 4.5

                veh_id = f"accident_{raw_cause}_{i}" if n_veh == 1 else f"accident_{raw_cause}_{i}_{j}"

                route_el = ET.SubElement(rou_root, "route")
                route_el.set("id",    f"acc_route_{i}_{j}")
                route_el.set("edges", edge)

                veh_el = ET.SubElement(rou_root, "vehicle")
                veh_el.set("id",     veh_id)
                veh_el.set("type",   "ACCIDENT_VTYPE")
                veh_el.set("route",  f"acc_route_{i}_{j}")
                veh_el.set("depart", depart_t)
                veh_el.set("color",  cause_info["color"])

                stop_el = ET.SubElement(veh_el, "stop")
                stop_el.set("edge",     edge)
                stop_el.set("duration", "9999")
                stop_el.set("startPos", f"{start_pos:.1f}")
                stop_el.set("endPos",   f"{end_pos:.1f}")
                stop_el.set("parking",  "false")

                if j == 1:
                    veh_el.set("id", f"accident_{raw_cause}_{i}_b")

            logger.info(f"Accident #{i} ({raw_cause}) → edge {edge}")

        rou_tree.write(rou_file, encoding="unicode", xml_declaration=True)
        logger.info(f"✅ {len(accidents)} accidents injectés")

    except Exception as e:
        logger.warning(f"_inject_accidents : {e}")
        import traceback; traceback.print_exc()


def _write_sumocfg(cfg_file, net_name="casa.net.xml", rou_name="casa.rou.xml",
                   ped_name=None, end=3600):
    """FIX 4 : step-length 0.1 pour fluidité maximale côté frontend."""
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


# ── SERVICE PRINCIPAL ──────────────────────────────────────────────────────────

class GenerateService:

    def __init__(self, sumo_data_dir: str):
        self.sumo_data_dir = sumo_data_dir
        os.makedirs(sumo_data_dir, exist_ok=True)

    async def generate(self, bbox, vehicle_count=50, pedestrian_count=20,
                       accidents=None, sim_duration=3600, scenario_name="") -> Dict:
        accidents = accidents or []
        ts        = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_name = "".join(c for c in scenario_name.strip() if c.isalnum() or c in "-_ ")
        safe_name = safe_name.replace(" ", "_")[:40]
        scenario_id = safe_name if safe_name else f"scenario_{ts}"
        if os.path.exists(os.path.join(self.sumo_data_dir, scenario_id)):
            scenario_id = f"{scenario_id}_{ts}"

        tmpdir = tempfile.mkdtemp(prefix=f"sumo_{ts}_")
        log    = []

        try:
            osm_path   = os.path.join(tmpdir, "zone.osm")
            net_file   = os.path.join(tmpdir, "generated.net.xml")
            rou_file   = os.path.join(tmpdir, "generated.rou.xml")
            ped_file   = os.path.join(tmpdir, "generated.ped.xml")
            trips_file = os.path.join(tmpdir, "trips.xml")
            ped_trips  = os.path.join(tmpdir, "ped_trips.xml")
            cfg_file   = os.path.join(tmpdir, "generated.sumocfg")

            # ── 1. Réseau ──────────────────────────────────────────────────────
            net_ok     = False
            osm_method = "osm"

            osm_ok = _download_osm(bbox, osm_path)
            if osm_ok:
                net_ok = _netconvert_osm(osm_path, net_file)
                if net_ok:
                    log.append("✅ Réseau réel OSM → SUMO (netconvert)")
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

            # ── 2. Routes véhicules ────────────────────────────────────────────
            random_trips = _find_random_trips()
            rou_ok       = False

            if random_trips:
                rou_ok = _generate_routes_random_trips(
                    random_trips, net_file, trips_file, rou_file,
                    count=vehicle_count, end=sim_duration,
                )
                if rou_ok:
                    log.append(f"✅ {vehicle_count} véhicules via randomTrips.py")

            if not rou_ok:
                _generate_minimal_routes(rou_file, net_file, vehicle_count, sim_duration)
                log.append(f"✅ {vehicle_count} véhicules (routes BFS + flows continus)")

            # ── 3. Piétons ─────────────────────────────────────────────────────
            ped_deployed = None
            if pedestrian_count > 0 and random_trips:
                ped_ok = _generate_routes_random_trips(
                    random_trips, net_file, ped_trips, ped_file,
                    count=pedestrian_count, end=sim_duration, pedestrians=True,
                )
                if ped_ok:
                    ped_deployed = "casa.ped.xml"
                    log.append(f"✅ {pedestrian_count} piétons générés")
                else:
                    log.append("⚠️ Génération piétons échouée (ignorée)")

            # ── 3b. Validation duarouter ───────────────────────────────────────
            # FIX 3 : vérifier que duarouter produit un fichier avec des véhicules
            try:
                import shutil as _sh
                duarouter_path = _sh.which("duarouter")
                if duarouter_path and rou_ok:
                    validated = os.path.join(tmpdir, "validated.rou.xml")
                    val_result = subprocess.run([
                        "duarouter",
                        "--net-file",    net_file,
                        "--route-files", rou_file,
                        "--output-file", validated,
                        "--ignore-errors",
                        "--no-warnings",
                    ], capture_output=True, text=True, timeout=120)
                    # FIX 3 : utiliser le fichier validé SEULEMENT s'il contient des véhicules
                    if val_result.returncode == 0 and _rou_has_vehicles(validated, min_count=5):
                        shutil.copy2(validated, rou_file)
                        log.append("✅ Routes validées par duarouter")
                    else:
                        log.append("⚠️ duarouter ignoré (fichier résultant vide ou invalide)")
            except Exception as val_err:
                log.append(f"⚠️ Validation duarouter ignorée : {val_err}")

            # ── 4. Accidents ───────────────────────────────────────────────────
            if accidents:
                _inject_accidents(rou_file, accidents, net_file)
                log.append(f"✅ {len(accidents)} accidents injectés")

            # ── 5. Configuration SUMO ──────────────────────────────────────────
            _write_sumocfg(cfg_file, ped_name=ped_deployed, end=sim_duration)
            log.append("✅ casa.sumocfg généré (step-length=0.1)")

            # ── 6. Sauvegarde scénario ─────────────────────────────────────────
            scenario_dir = os.path.join(self.sumo_data_dir, scenario_id)
            os.makedirs(scenario_dir, exist_ok=True)

            deploy_map = {
                net_file: ("casa.net.xml", scenario_dir),
                rou_file: ("casa.rou.xml", scenario_dir),
                cfg_file: ("casa.sumocfg", scenario_dir),
            }
            if ped_deployed and os.path.exists(ped_file):
                deploy_map[ped_file] = ("casa.ped.xml", scenario_dir)

            deployed = []
            for src, (dst_name, dst_dir) in deploy_map.items():
                if not os.path.exists(src):
                    continue
                shutil.copy2(src, os.path.join(dst_dir, dst_name))
                active_dst = os.path.join(self.sumo_data_dir, dst_name)
                shutil.copy2(src, active_dst)
                deployed.append(dst_name)
                logger.info(f"📦 Déployé : {dst_name} ({os.path.getsize(active_dst):,} bytes)")

            import json
            metadata = {
                "scenario_id":      scenario_id,
                "generated_at":     datetime.utcnow().isoformat(),
                "bbox":             bbox,
                "vehicle_count":    vehicle_count,
                "pedestrian_count": pedestrian_count,
                "accident_count":   len(accidents),
                "sim_duration_s":   sim_duration,
                "network_method":   osm_method,
                "deployed_files":   deployed,
                "scenario_name":    scenario_name or scenario_id,
            }
            with open(os.path.join(scenario_dir, "metadata.json"), "w") as f:
                json.dump(metadata, f, indent=2)

            log.append(f"✅ Scénario archivé dans {scenario_id}/")

            return {
                "status":         "deployed",
                "scenario_id":    scenario_id,
                "message":        f"Scénario généré — {vehicle_count} véhicules, {pedestrian_count} piétons, {len(accidents)} accidents",
                "deployed_files": deployed,
                "generation_log": log,
                "bbox":           bbox,
                "network_method": osm_method,
            }

        except Exception as e:
            logger.error(f"❌ GenerateService.generate : {e}")
            import traceback; traceback.print_exc()
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
        for fname in ["casa.net.xml", "casa.rou.xml", "casa.sumocfg", "casa.ped.xml"]:
            src = os.path.join(src_dir, fname)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(self.sumo_data_dir, fname))
        return True