# src/services/GenerateService.py
"""
Service de génération de scénarios SUMO.

Fonctionnement complet :
  1. Télécharge les données OSM depuis Overpass API (bbox)
  2. Convertit le réseau OSM → SUMO via netconvert
  3. Fallback : réseau synthétique via netgenerate
  4. Génère les routes véhicules via randomTrips.py
  5. Génère les piétons (optionnel)
  6. Injecte les accidents comme véhicules bloqués
  7. Produit le .sumocfg complet
  8. Déploie tout dans le dossier cible (remplace les fichiers existants)

Le dossier de sortie est :
  <SUMO_DATA_DIR>/generated_<timestamp>/   (sauvegardé)
  <SUMO_DATA_DIR>/casa.net.xml             (lien actif)
  <SUMO_DATA_DIR>/casa.rou.xml
  <SUMO_DATA_DIR>/casa.sumocfg
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


# ──────────────────────────────────────────────────────────────
# HELPERS INTERNES
# ──────────────────────────────────────────────────────────────

def _find_random_trips() -> Optional[str]:
    """Localise randomTrips.py dans l'installation SUMO."""
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
    """
    Télécharge les données OSM depuis Overpass API.
    Retourne True si le téléchargement a réussi.
    """
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
        return size > 500  # fichier vide = zone hors couverture
    except Exception as e:
        logger.warning(f"⚠️ Téléchargement OSM échoué : {e}")
        return False


def _netconvert_osm(osm_path: str, net_file: str, timeout: int = 120) -> bool:
    """Convertit un fichier OSM en réseau SUMO via netconvert."""
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
    """Génère un réseau en grille synthétique via netgenerate."""
    dlat = abs(bbox["max_lat"] - bbox["min_lat"])
    dlng = abs(bbox["max_lng"] - bbox["min_lng"])
    grid_x = max(3, min(12, int(dlng * 100)))
    grid_y = max(3, min(12, int(dlat * 100)))

    result = subprocess.run(
        [
            "netgenerate",
            "--grid",
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
    Lance randomTrips.py pour générer des routes valides.
    Stratégie : d'abord avec --validate (duarouter intégré),
    puis sans si ça échoue (certaines installations SUMO n'ont pas duarouter).
    """
    period = max(1, end // max(1, count))
    label  = "piétons" if pedestrians else "véhicules"

    # Injection concentrée en 60s max → saturation visible immédiatement
    injection_window = 60  # TOUJOURS 60s pour voir les véhicules dès le départ
    period           = max(0, round(injection_window / max(1, count), 2))
    if period < 0.5:
        period = 0.5  # minimum 0.5s entre chaque véhicule
    logger.info(f"Injection {count} véhicules en {injection_window}s (period={period}s)")

    # Commande de base : filtrer les edges motorisés pour les véhicules
    base_args = [
        "-n",       net_file,
        "-o",       trips_file,
        "-r",       rou_file,
        "--period", str(period),
        "--begin",  "0",
        "--end",    str(injection_window),   # injecter dans la fenêtre courte
        "--no-warnings",
        "--fringe-factor", "10",    # très favorable aux départs aux extrémités
        "--min-distance",  "50",    # distance min réduite pour plus de routes valides
    ]

    if pedestrians:
        base_args += ["--pedestrians"]
    else:
        # Restreindre aux véhicules motorisés de type "passenger"
        base_args += [
            "--vehicle-class",  "passenger",
            "--edge-permission", "passenger",
            "--allow-fringe-speed", "true",
        ]

    # Tentative 1 : avec --validate (duarouter intégré → garantit routes valides)
    cmd1 = ["python3", random_trips] + base_args + ["--validate"]
    result = subprocess.run(cmd1, capture_output=True, text=True, timeout=timeout)
    if result.returncode == 0 and os.path.exists(rou_file) and os.path.getsize(rou_file) > 100:
        logger.info(f"✅ Routes {label} validées ({count}) [--validate]")
        return True
    logger.warning(f"randomTrips --validate échoué: {result.stderr[:200]}")

    # Tentative 2 : sans --vehicle-class (plus permissif) mais avec --validate
    if os.path.exists(rou_file): os.remove(rou_file)
    base_args2 = [
        "-n", net_file, "-o", trips_file, "-r", rou_file,
        "--period", str(period), "--end", str(end),
        "--no-warnings", "--fringe-factor", "5",
    ]
    if pedestrians:
        base_args2.append("--pedestrians")
    cmd2 = ["python3", random_trips] + base_args2 + ["--validate"]
    result2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=timeout)
    if result2.returncode == 0 and os.path.exists(rou_file) and os.path.getsize(rou_file) > 100:
        logger.info(f"✅ Routes {label} générées ({count}) [sans vehicle-class]")
        return True
    logger.warning(f"randomTrips tentative 2 échouée: {result2.stderr[:200]}")

    # Tentative 3 : sans --validate du tout (moins fiable mais dernier recours)
    if os.path.exists(rou_file): os.remove(rou_file)
    cmd3 = ["python3", random_trips] + base_args2
    result3 = subprocess.run(cmd3, capture_output=True, text=True, timeout=timeout)
    if result3.returncode == 0 and os.path.exists(rou_file) and os.path.getsize(rou_file) > 100:
        logger.info(f"✅ Routes {label} générées ({count}) [sans validation]")
        return True

    logger.warning(f"randomTrips toutes tentatives échouées: {result3.stderr[:200]}")
    return False


def _is_motorized_edge(edge_elem) -> bool:
    """
    Retourne True si l'edge accepte les véhicules motorisés (passenger).
    Filtre les edges piétons/cyclistes uniquement.
    """
    lanes = edge_elem.findall("lane")
    if not lanes:
        return True  # pas d'info → on garde
    for lane in lanes:
        allow    = lane.get("allow",    "")
        disallow = lane.get("disallow", "")
        speed    = float(lane.get("speed", "13.9"))  # 13.9 m/s ≈ 50 km/h par défaut
        # Edge piéton pur : allow="pedestrian" ou "pedestrian bicycle"
        ped_only_allows = {"pedestrian", "bicycle", "pedestrian bicycle",
                           "bicycle pedestrian"}
        if allow and allow.strip() in ped_only_allows:
            continue
        # Vitesse max < 3 m/s (~11 km/h) → probablement piéton
        if speed < 3.0:
            continue
        # Lane utilisable par les véhicules
        return True
    return False


def _build_adjacency(net_file: str) -> dict:
    """
    Parse le réseau SUMO et construit une table d'adjacence edge→[edge_suivants].
    Filtre les edges piétons/cyclistes uniquement.
    """
    adj: dict = {}
    try:
        tree = ET.parse(net_file)
        root = tree.getroot()
        # Initialiser les edges motorisés uniquement
        for e in root.findall(".//edge"):
            eid = e.get("id", "")
            if eid and not eid.startswith(":") and _is_motorized_edge(e):
                adj[eid] = []
        # Connexions entre edges motorisés
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


def _bfs_route(adj: dict, start: str, max_depth: int = 20) -> list:
    """
    BFS depuis start pour trouver le chemin le plus long accessible.
    Retourne la liste d'edges du chemin.
    """
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


def _generate_minimal_routes(rou_file: str, net_file: str, count: int):
    """
    Fallback : génère des routes valides sans randomTrips en utilisant
    la topologie réelle du réseau (connexions entre edges).

    Stratégie :
      1. Construire le graphe d'adjacence depuis les <connection> du .net.xml
      2. BFS depuis plusieurs points de départ pour trouver des chemins valides
      3. Distribuer les véhicules sur ces chemins
    """
    adj    = _build_adjacency(net_file)
    edges  = list(adj.keys())

    if not edges:
        logger.warning("Aucun edge trouvé dans le réseau — routes vides")
        with open(rou_file, "w") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n<routes/>\n')
        return

    # Trouver des chemins valides depuis différents points de départ
    # Générer autant de routes uniques que possible (objectif = count routes)
    valid_routes: list[list] = []
    # Parcourir tous les edges comme points de départ possibles
    import random as _rnd
    _rnd.seed(42)
    shuffled = list(edges)
    _rnd.shuffle(shuffled)
    for start in shuffled:
        path = _bfs_route(adj, start, max_depth=20)
        if len(path) >= 2 and path not in valid_routes:
            valid_routes.append(path)
        if len(valid_routes) >= max(count, 20):
            break

    # Fallback : route single-edge si aucun chemin multi-edge
    if not valid_routes:
        logger.warning("Aucun chemin connecté — route single-edge")
        valid_routes = [[e] for e in edges[:min(count, len(edges))]]

    # Écrire le fichier routes
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<routes>',
        # vType : accel forte, teleport au bout de route activé via sumocfg,
        # routingMode=1 = reroutage dynamique si route bloquée
        '  <vType id="DEFAULT_VEHTYPE" accel="3.0" decel="6.0" maxSpeed="22.22"'
        ' speedFactor="1.2" speedDev="0.1" sigma="0.3" length="4.5"'
        ' minGap="1.5" tau="0.8" lcStrategic="1.0" lcCooperative="0.3"/>',
    ]

    route_ids = []
    for i, path in enumerate(valid_routes):
        rid = f"r{i}"
        lines.append(f'  <route id="{rid}" edges="{" ".join(path)}"/>')
        route_ids.append(rid)

    # Phase 1 : injection initiale en 30s pour saturation immédiate
    # Phase 2 : flow continu toutes les 60s pour maintenir la densité
    for i in range(count):
        rid    = route_ids[i % len(route_ids)]
        depart = round(i * 30.0 / max(1, count), 1)  # tous injectés en 30s
        lines.append(
            f'  <vehicle id="veh{i}" type="DEFAULT_VEHTYPE" route="{rid}" depart="{depart}" speedFactor="1.2"/>'
        )

    # Flows continus pour remplacer les véhicules qui finissent leur route
    # Un flow génère un véhicule toutes les X secondes sur chaque route
    flow_period = max(5, 120 // max(1, len(route_ids)))  # ex: 10 routes → 1 veh/12s par route
    for i, rid in enumerate(route_ids[:min(len(route_ids), 20)]):
        lines.append(
            f'  <flow id="flow{i}" type="DEFAULT_VEHTYPE" route="{rid}" begin="60" end="86400" period="{flow_period}" speedFactor="1.2"/>'
        )
    lines.append("</routes>")

    with open(rou_file, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    logger.info(f"✅ Routes valides générées ({count} véhicules sur {len(valid_routes)} routes)")


def _find_nearest_edge(
    lat: float, lng: float, lane_positions: List[Tuple]
) -> Optional[str]:
    """
    Retourne l'edge le plus proche d'un point GPS.
    lane_positions : liste de (edge_id, x_sumo, y_sumo).
    La correspondance GPS↔SUMO est approximative (pas de projection exacte ici).
    """
    if not lane_positions:
        return None
    # Approximation : traiter lat/lng comme des coordonnées proportionnelles
    best_edge = None
    best_dist = float("inf")
    for eid, x, y in lane_positions:
        # Normalisation grossière : 1° ≈ 111 km
        dx = (lng - x / 111320) * 1e5
        dy = (lat - y / 111320) * 1e5
        dist = dx * dx + dy * dy
        if dist < best_dist:
            best_dist = dist
            best_edge = eid
    return best_edge


# Causes d'accident disponibles
ACCIDENT_CAUSES = {
    "collision": {"label": "Collision",             "color": "1,0,0",      "n_vehicles": 2},
    "panne":     {"label": "Panne / Arrêt brusque", "color": "1,0.5,0",    "n_vehicles": 1},
    "feu_rouge": {"label": "Grillage de feu",       "color": "1,0.8,0",    "n_vehicles": 2},
    "obstacle":  {"label": "Obstacle sur route",    "color": "0.8,0,0.8",  "n_vehicles": 1},
    "pietons":   {"label": "Piétons sur route",     "color": "0,0.6,1",    "n_vehicles": 1},
    "inconnu":   {"label": "Accident inconnu",      "color": "0.5,0.5,0.5","n_vehicles": 1},
}

# vType dédié aux véhicules accidentés : immobiles, accel nulle, taille légèrement augmentée
ACCIDENT_VTYPE = """  <vType id="ACCIDENT_VTYPE" accel="0.0" decel="0.0" maxSpeed="0.01"
         length="5.5" width="2.2" sigma="0.0" speedFactor="0.0"
         guiShape="passenger" color="1,0,0"/>"""

def _inject_accidents(rou_file: str, accidents: List[Dict], net_file: str):
    """
    Injecte les accidents dans le .rou.xml :
    - Collision  → 2 véhicules bloqués côte à côte (5m d'écart), simule l'impact
    - Panne      → 1 véhicule bloqué au milieu de la voie
    - Autres     → 1 véhicule bloqué
    Les véhicules normaux s'accumulent derrière.
    """
    try:
        net_tree = ET.parse(net_file)
        lane_positions: List[Tuple] = []
        # Récupérer aussi la longueur de chaque edge
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

        # Insérer le vType accident en tête du fichier routes
        vtype_el = ET.fromstring(ACCIDENT_VTYPE.strip())
        rou_root.insert(0, vtype_el)

        for i, acc in enumerate(accidents):
            edge = _find_nearest_edge(acc["lat"], acc["lng"], lane_positions)
            if not edge and lane_positions:
                edge = lane_positions[i % len(lane_positions)][0]
            if not edge:
                logger.warning(f"Accident #{i} : aucun edge trouvé, ignoré")
                continue

            # Cause
            raw_cause = (acc.get("cause") or acc.get("type") or "inconnu").lower()
            if raw_cause not in ACCIDENT_CAUSES:
                if "collision" in raw_cause or "crash" in raw_cause:
                    raw_cause = "collision"
                elif "panne" in raw_cause or "brusque" in raw_cause:
                    raw_cause = "panne"
                elif "feu" in raw_cause:
                    raw_cause = "feu_rouge"
                elif "obstacle" in raw_cause:
                    raw_cause = "obstacle"
                elif "pieton" in raw_cause or "piéton" in raw_cause:
                    raw_cause = "pietons"
                else:
                    import random
                    raw_cause = random.choice(list(ACCIDENT_CAUSES.keys()))

            cause_info = ACCIDENT_CAUSES[raw_cause]
            n_veh      = cause_info["n_vehicles"]
            edge_len   = edge_lengths.get(edge, 50.0)
            depart_t   = str(5 + i * 2)

            # Position de base : milieu de l'edge
            base_pos   = max(3.0, min(edge_len * 0.4, edge_len - 10.0))

            for j in range(n_veh):
                # Pour une collision : 2 véhicules à 4m d'écart sur la même voie
                # → forcent les véhicules normaux à s'arrêter derrière
                pos_offset = j * 4.5  # 4.5m entre les deux véhicules impliqués
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
                # Angle aléatoire pour simuler un véhicule renversé/de travers
                if raw_cause == "collision":
                    import random as _r
                    veh_el.set("departSpeed", "0")
                    # Angle de -45° à +45° par rapport à la route (véhicule de travers)
                    # SUMO ne supporte pas l'angle explicite en XML, mais la couleur rouge
                    # et le type dédié le rendent bien visible

                stop_el = ET.SubElement(veh_el, "stop")
                stop_el.set("edge",      edge)
                stop_el.set("duration",  "9999")
                stop_el.set("startPos",  f"{start_pos:.1f}")
                stop_el.set("endPos",    f"{end_pos:.1f}")
                stop_el.set("parking",   "false")

                # ID canonique pour la détection backend (toujours accident_cause_i)
                # Les véhicules _i_1 sont ignorés pour les stats, seul _i_0 compte
                if j == 1:
                    # Deuxième véhicule de la collision : marquer comme "partie" de l'accident principal
                    veh_el.set("id", f"accident_{raw_cause}_{i}_b")

            # Log
            logger.info(f"Accident #{i} ({raw_cause}) → edge {edge}, {n_veh} véhicule(s), pos {base_pos:.1f}m")

        rou_tree.write(rou_file, encoding="unicode", xml_declaration=True)
        logger.info(f"✅ {len(accidents)} accidents injectés dans {rou_file}")

    except Exception as e:
        logger.warning(f"_inject_accidents non bloquant : {e}")
        import traceback; traceback.print_exc()


def _write_sumocfg(
    cfg_file: str,
    net_name:  str = "casa.net.xml",
    rou_name:  str = "casa.rou.xml",
    ped_name:  Optional[str] = None,
    end:       int = 3600,
):
    """Écrit un fichier .sumocfg SUMO complet."""
    additional = ""
    if ped_name:
        additional = f'\n        <additional-files value="{ped_name}"/>'

    # Structure identique au sumocfg de base + paramètres pour fluidité
    content = f"""<?xml version="1.0" encoding="utf-8"?>
<configuration>
    <input>
        <net-file value="{net_name}" />
        <route-files value="{rou_name}" />{additional}
    </input>

    <time>
        <begin value="0" />
        <end value="86400" />
        <step-length value="0.5" />
    </time>

    <processing>
        <ignore-route-errors value="true" />
        <time-to-teleport value="60" />
        <time-to-teleport.highways value="-1" />
        <lanechange.duration value="0" />
        <collision.action value="teleport" />
        <collision.mingap-factor value="0" />
        <emergencydecel.warning-threshold value="1.1" />
        <max-depart-delay value="30" />
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


# ──────────────────────────────────────────────────────────────
# SERVICE PRINCIPAL
# ──────────────────────────────────────────────────────────────

class GenerateService:
    """
    Service de génération de scénarios SUMO.

    Usage :
        svc    = GenerateService(sumo_data_dir="/app/maps")
        result = await svc.generate(bbox, vehicle_count, pedestrian_count, accidents)
    """

    def __init__(self, sumo_data_dir: str):
        self.sumo_data_dir = sumo_data_dir
        os.makedirs(sumo_data_dir, exist_ok=True)

    # ── Entrée publique ───────────────────────────────────────

    async def generate(
        self,
        bbox:             Dict,
        vehicle_count:    int  = 50,
        pedestrian_count: int  = 20,
        accidents:        List[Dict] = None,
        sim_duration:     int  = 6000,   # identique au sumocfg de référence
        scenario_name:    str  = "",
    ) -> Dict:
        """
        Génère un scénario SUMO complet et le déploie dans sumo_data_dir.

        Retourne un dict avec :
          - status          : "deployed"
          - message         : résumé lisible
          - scenario_id     : identifiant unique du scénario (= nom du dossier)
          - deployed_files  : liste des fichiers copiés
          - generation_log  : étapes réalisées
          - bbox            : bbox utilisée
        """
        accidents = accidents or []
        ts        = datetime.now().strftime("%Y%m%d_%H%M%S")
        # Nom du dossier : utilise le nom saisi ou un nom auto
        safe_name   = "".join(c for c in scenario_name.strip() if c.isalnum() or c in "-_ ")
        safe_name   = safe_name.replace(" ", "_")[:40]
        scenario_id = safe_name if safe_name else f"scenario_{ts}"
        # Si le dossier existe déjà, suffixer avec le timestamp
        if os.path.exists(os.path.join(self.sumo_data_dir, scenario_id)):
            scenario_id = f"{scenario_id}_{ts}"

        # Dossier de travail temporaire (nettoyé automatiquement)
        tmpdir = tempfile.mkdtemp(prefix=f"sumo_{ts}_")
        log    = []

        try:
            # Chemins des fichiers intermédiaires
            osm_path   = os.path.join(tmpdir, "zone.osm")
            net_file   = os.path.join(tmpdir, "generated.net.xml")
            rou_file   = os.path.join(tmpdir, "generated.rou.xml")
            ped_file   = os.path.join(tmpdir, "generated.ped.xml")
            trips_file = os.path.join(tmpdir, "trips.xml")
            ped_trips  = os.path.join(tmpdir, "ped_trips.xml")
            cfg_file   = os.path.join(tmpdir, "generated.sumocfg")

            # ── 1. Réseau ──────────────────────────────────────────────
            net_ok    = False
            osm_method = "osm"

            osm_ok = _download_osm(bbox, osm_path)
            if osm_ok:
                net_ok = _netconvert_osm(osm_path, net_file)
                if net_ok:
                    log.append("✅ Réseau réel OSM → SUMO (netconvert)")
                else:
                    log.append("⚠️ netconvert échoué, passage en réseau synthétique")
                    osm_method = "grid"
            else:
                log.append("⚠️ Téléchargement OSM échoué, réseau synthétique")
                osm_method = "grid"

            if not net_ok:
                net_ok = _netgenerate_grid(net_file, bbox)
                if not net_ok:
                    raise RuntimeError(
                        "Impossible de générer le réseau SUMO (netconvert et netgenerate ont échoué)"
                    )
                log.append(f"✅ Réseau synthétique en grille généré")

            # ── 2. Routes véhicules ────────────────────────────────────
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
                _generate_minimal_routes(rou_file, net_file, vehicle_count)
                log.append(f"✅ {vehicle_count} véhicules (routes minimales)")

            # ── 3. Piétons ─────────────────────────────────────────────
            ped_deployed = None
            if pedestrian_count > 0 and random_trips:
                ped_ok = _generate_routes_random_trips(
                    random_trips, net_file, ped_trips, ped_file,
                    count=pedestrian_count, end=sim_duration,
                    pedestrians=True,
                )
                if ped_ok:
                    ped_deployed = "casa.ped.xml"
                    log.append(f"✅ {pedestrian_count} piétons générés")
                else:
                    log.append(f"⚠️ Génération piétons échouée (ignorée)")
            elif pedestrian_count > 0:
                log.append("⚠️ randomTrips.py introuvable — piétons ignorés")

            # ── 3b. Validation des routes avec duarouter (si disponible) ──
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
                    if val_result.returncode == 0 and os.path.exists(validated) and os.path.getsize(validated) > 100:
                        import shutil as _sh2
                        _sh2.copy2(validated, rou_file)
                        log.append("✅ Routes validées par duarouter")
                    else:
                        log.append(f"⚠️ duarouter ignoré (retour: {val_result.returncode})")
            except Exception as val_err:
                log.append(f"⚠️ Validation duarouter ignorée : {val_err}")

            # ── 4. Accidents ───────────────────────────────────────────
            if accidents:
                _inject_accidents(rou_file, accidents, net_file)
                log.append(f"✅ {len(accidents)} accidents injectés")

            # ── 5. Configuration SUMO ──────────────────────────────────
            _write_sumocfg(
                cfg_file,
                net_name  = "casa.net.xml",
                rou_name  = "casa.rou.xml",
                ped_name  = ped_deployed,
                end       = sim_duration,
            )
            log.append("✅ casa.sumocfg généré")

            # ── 6. Sauvegarde du scénario dans un sous-dossier daté ────
            scenario_dir = os.path.join(self.sumo_data_dir, scenario_id)
            os.makedirs(scenario_dir, exist_ok=True)

            deploy_map = {
                net_file: ("casa.net.xml", scenario_dir),
                rou_file: ("casa.rou.xml", scenario_dir),
                cfg_file: ("casa.sumocfg", scenario_dir),
            }
            if ped_deployed and os.path.exists(ped_file):
                deploy_map[ped_file] = ("casa.ped.xml", scenario_dir)

            # ── 7. Déploiement actif : copier vers sumo_data_dir ───────
            deployed = []
            for src, (dst_name, dst_dir) in deploy_map.items():
                if not os.path.exists(src):
                    continue
                # Copie dans le dossier scénario (archivage)
                shutil.copy2(src, os.path.join(dst_dir, dst_name))
                # Copie active (remplace les fichiers en cours)
                active_dst = os.path.join(self.sumo_data_dir, dst_name)
                shutil.copy2(src, active_dst)
                deployed.append(dst_name)
                logger.info(
                    f"📦 Déployé : {dst_name} "
                    f"({os.path.getsize(active_dst):,} bytes)"
                )

            # Écrire un metadata.json dans le dossier scénario
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
                "message":        (
                    f"Scénario généré — {vehicle_count} véhicules, "
                    f"{pedestrian_count} piétons, "
                    f"{len(accidents)} accidents"
                ),
                "deployed_files": deployed,
                "generation_log": log,
                "bbox":           bbox,
                "network_method": osm_method,
            }

        except Exception as e:
            logger.error(f"❌ GenerateService.generate : {e}")
            import traceback
            traceback.print_exc()
            raise

        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    # ── Utilitaires publics ───────────────────────────────────

    def list_scenarios(self) -> List[Dict]:
        """
        Liste tous les scénarios archivés dans sumo_data_dir.
        Chaque entrée contient les métadonnées du scenario.
        """
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
                    scenarios.append({"scenario_id": name, "error": "metadata illisible"})
        return scenarios

    def get_active_scenario(self) -> Optional[str]:
        """
        Retourne l'ID du dernier scénario déployé en lisant
        le metadata.json le plus récent.
        """
        scenarios = self.list_scenarios()
        return scenarios[0]["scenario_id"] if scenarios else None

    def deploy_scenario(self, scenario_id: str) -> bool:
        """
        Redéploie un scénario archivé comme scénario actif.
        Utile pour revenir à un scénario précédent.
        """
        src_dir = os.path.join(self.sumo_data_dir, scenario_id)
        if not os.path.isdir(src_dir):
            logger.error(f"Scénario introuvable : {scenario_id}")
            return False

        for fname in ["casa.net.xml", "casa.rou.xml", "casa.sumocfg", "casa.ped.xml"]:
            src = os.path.join(src_dir, fname)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(self.sumo_data_dir, fname))
                logger.info(f"♻️  Redéployé : {fname}")
        return True