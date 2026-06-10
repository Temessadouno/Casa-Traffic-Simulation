# Backend — TMT Traffic Control

Service principal de la plateforme. Il orchestre le moteur de simulation SUMO, expose une API REST + WebSocket, et persiste les données dans MongoDB.

---

## Stack technique

| Composant | Version | Rôle |
|---|---|---|
| Python | 3.10 | Langage principal |
| FastAPI | 0.11 | API REST + routing |
| python-socketio | 5.x | WebSocket (Socket.IO) |
| SUMO | 1.26 | Moteur de simulation trafic |
| TraCI | (bundled SUMO) | Pilotage SUMO depuis Python |
| Motor | 3.x | Driver MongoDB asynchrone |
| uvicorn | 0.x | Serveur ASGI (reload en dev) |
| NumPy | 1.x | Calculs métriques trafic |

---

## Architecture interne

```
src/
├── main.py                    ← Point d'entrée ASGI
├── maps/                      ← Fichiers SUMO
│   ├── casa.net.xml           ← Réseau routier Casablanca (OSM)
│   ├── casa.rou.xml           ← Routes et véhicules (défaut)
│   ├── casa.sumocfg           ← Configuration simulation défaut
│   ├── active_scenario.json   ← Scénario sélectionné (persisté)
│   └── <scenario_id>/         ← Scénarios générés
│       ├── casa.net.xml
│       ├── casa.rou.xml
│       ├── casa.sumocfg
│       └── metadata.json
└── services/
    ├── GenerateService.py         ← Génération OSM → SUMO
    ├── ScenarioConfigService.py   ← Sélection / validation scénario
    ├── SumoEngineService.py       ← Véhicule ego, métriques, prédictions
    ├── PersistenceService.py      ← Écriture MongoDB
    └── SafetyAIService.py         ← Détection risques de collision
```

---

## Dockerfile

```dockerfile
FROM ubuntu:22.04
# SUMO installé via apt (sumo + sumo-tools)
# Python 3.10 + pip
# SUMO_HOME=/usr/share/sumo
# PORT 8000
```

Le container utilise Ubuntu 22.04 car SUMO nécessite des dépendances système spécifiques (`libglib2.0`, `libx11`, `libgl1`) non disponibles dans les images Python slim.

---

## main.py — Structure

### Démarrage

```
startup
  ├── Connexion MongoDB (Motor)
  ├── Initialisation des services (Persistence, Safety, SumoEngine...)
  ├── Chargement ScenarioConfigService (lit active_scenario.json)
  └── Lancement boucle broadcast (asyncio.create_task)
```

### Boucle broadcast (`simulation_broadcast_loop`)

Tourne en tâche de fond toutes les 100ms (≈ 10 fps) quand `SUMO_RUNNING = True`.

```
Chaque tick :
  1. traci.simulationStep() × (1 + SUMO_EXTRA_STEPS)
  2. broadcast_all_vehicles()
     ├── Récupère position/vitesse/cap de chaque véhicule
     ├── Récupère position/vitesse des piétons (traci.person)
     └── Émet "all_vehicles_state" via Socket.IO
  3. Détection accidents (toutes les 5 steps)
     ├── Véhicules bloqués sur le même edge qu'un accident_*
     └── Émet "accidents_state"
  4. Détection pannes (toutes les 3 steps)
     ├── Véhicule à l'arrêt > 40 steps hors feu rouge
     └── Émet "emergency_alert" (event: BREAKDOWN)
  5. Persistence ego (si journey actif)
  6. Métriques + anomalies IA (toutes les 10 steps)
  7. Prédictions IA (toutes les 60 steps)
```

### Variables globales clés

| Variable | Type | Rôle |
|---|---|---|
| `SUMO_RUNNING` | bool | Active/désactive la boucle broadcast |
| `SUMO_EXTRA_STEPS` | int | 0=×1, 1=×2, 4=×5 (multiplicateur vitesse) |
| `SUMO_STEP_DELAY` | float | Délai entre steps (non utilisé activement) |
| `ACCIDENT_STATES` | dict | `{vid: {lat, lng, cause, edge, blocked}}` |
| `BREAKDOWN_STATES` | dict | `{vid: {waiting_since, notified}}` |
| `ACTIVE_JOURNEY_ID` | str | ID du trajet en cours de persistence |

---

## Endpoints REST

### Simulation

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/simulation/start` | Lance SUMO, warm-up, détecte accidents |
| `POST` | `/simulation/stop` | Arrête SUMO proprement, finalise le journey |
| `POST` | `/simulation/step-delay` | `{factor: 1|2|5}` — multiplie la vitesse |

### Scénarios

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/scenario/generate` | Génère un scénario depuis une bbox OSM |
| `GET` | `/scenario/list` | Liste tous les scénarios archivés |
| `GET` | `/scenario/active` | Retourne le scénario actif |
| `POST` | `/scenario/select/{id}` | Sélectionne un scénario sans copier les fichiers |
| `POST` | `/scenario/select-default` | Revient aux fichiers maps/ racine |
| `DELETE` | `/scenario/{id}` | Supprime un scénario archivé |
| `POST` | `/scenario/fix-routes` | Régénère les routes du scénario actif |

### Données

| Méthode | Route | Description |
|---|---|---|
| `POST` | `/journey/start` | Crée un trajet en DB, active la persistence |
| `GET` | `/journeys` | Liste les 50 derniers trajets |
| `GET` | `/journeys/{id}` | Détail : steps, anomalies, prédictions |
| `GET` | `/traffic/statistics` | Stats réseau temps réel (via SumoEngine) |
| `GET` | `/traffic/anomalies` | Anomalies détectées |
| `GET` | `/ai/info` | État du modèle IA |

---

## Événements Socket.IO émis

| Événement | Contenu | Fréquence |
|---|---|---|
| `all_vehicles_state` | `{vehicles: {id: {lat,lng,speed,heading}}, pedestrians: {...}}` | Chaque step (~10/s) |
| `simulation_status` | `{status: "started"|"stopped"}` | Au démarrage/arrêt |
| `accidents_state` | `{accidents: [{id,lat,lng,cause,blocked_count,blocked_ids}]}` | Toutes les 5 steps |
| `emergency_alert` | `{title,message,severity,vehicle_id,lat,lng,event}` | Sur détection |
| `traffic_prediction` | `{segment_id, predicted_speed, confidence_score,...}` | Toutes les 60 steps |
| `traffic_anomaly` | `{segment_id,deviation,severity,expected,actual}` | Sur détection |

---

## Services

### `GenerateService.py`

Pipeline de génération d'un scénario SUMO complet :

```
1. Téléchargement OSM (Overpass API) → zone.osm
2. netconvert OSM → casa.net.xml
   Fallback : netgenerate --grid si netconvert échoue
3. randomTrips.py → casa.rou.xml (3 tentatives avec options dégradées)
   Fallback BFS : routes topologiques depuis le graphe du réseau
4. Injection piétons (randomTrips --pedestrians)
5. Validation duarouter (si disponible)
6. _inject_accidents() → ajoute les véhicules accident_<cause>_<i> au .rou.xml
   - Collision : 2 véhicules avec vType ACCIDENT_VTYPE, 4.5m d'écart
   - Panne : 1 véhicule bloqué au milieu de l'edge
7. _write_sumocfg() → casa.sumocfg (end=86400, step-length=0.5)
8. Archivage dans maps/<scenario_id>/ + metadata.json
```

**Injection véhicules** : tous les véhicules entrent dans les 60 premières secondes (injection_window=60s) + flows continus toutes les X secondes pour maintenir la densité.

### `ScenarioConfigService.py`

Maintient quel dossier de fichiers SUMO est utilisé. Persiste le choix dans `maps/active_scenario.json`. En mode défaut, pointe sur `maps/` racine. En mode scénario, pointe sur `maps/<id>/` sans copier les fichiers.

### `SumoEngineService.py`

- Mapping GPS ↔ coordonnées SUMO (`traci.simulation.convertGeo`)
- Filtrage des edges motorisés (exclut piétons/cyclistes)
- Calcul de routes via `traci.simulation.findRoute`
- Collecte des métriques par edge (vitesse moy, densité, occupation)
- Détection d'anomalies par écart-type sur fenêtre glissante (σ > 2.0)
- Prédictions par moving average (fallback si pas de modèle LSTM)

### `PersistenceService.py`

Écrit en MongoDB via Motor (driver async) :
- `journeys` — métadonnées du trajet (origine, destination, statut)
- `traffic_logs` — positions GPS step par step
- `anomalies` — détections de déviations
- `predictions` — vitesses prédites par segment

### `SafetyAIService.py`

Détecte les risques de collision en calculant la distance entre le véhicule ego et les véhicules voisins. Émet `collision_risk_alert` si la distance < seuil critique.

---

## Configuration SUMO (traci.start)

```python
traci.start([
    "sumo",
    "-c",                         cfg_name,
    "--step-length",              "0.5",    # 500ms par step simulé
    "--default.speeddev",         "0.1",    # variation vitesse naturelle
    "--time-to-teleport",         "60",     # téléporte les bloqués après 60s
    "--time-to-teleport.highways","-1",     # jamais sur autoroutes
    "--ignore-route-errors",      "true",
    "--collision.action",         "warn",
    "--end",                      "86400",  # 24h → SUMO ne se ferme jamais seul
    "--no-warnings",
    "--no-step-log",
    "--error-log",                "/tmp/sumo_errors.log",
])
```

Le warm-up avance jusqu'à ce que tous les véhicules `accident_*` soient entrés dans la simulation (max 60 steps = 30s simulées).

---

## Variables d'environnement

```env
MONGO_URI=mongodb://mongodb:27017   # Nom du service Docker, pas localhost
DATABASE_NAME=traffic_simulation
SUMO_HOME=/usr/share/sumo
SUMO_DATA_DIR=/app/src/maps
PYTHONUNBUFFERED=1
PYTHONPATH=/app
MODEL_PATH=                         # Optionnel : modèle IA externe
```

---

## Logs utiles

```bash
# Suivre les logs en temps réel
docker compose logs -f backend

# Erreurs SUMO
docker exec backend_sim cat /tmp/sumo_errors.log

# Vérifier la connexion MongoDB
docker exec backend_sim python3 -c "from motor.motor_asyncio import AsyncIOMotorClient; print('OK')"
```