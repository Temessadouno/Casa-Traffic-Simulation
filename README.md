# TMT Traffic Control — Casablanca

Plateforme de simulation intelligente du trafic urbain de Casablanca, développée dans le cadre d'un projet de fin d'Année à la FST de Mohammedia.

Elle couple un moteur de simulation microscopique (SUMO/TraCI), une API temps réel (FastAPI + Socket.IO), une base de données de trajectoires (MongoDB) et une interface web interactive (React).

---

## Architecture globale

```
┌─────────────────────────────────────────────────────────────────┐
│                        Docker Compose                           │
│                        réseau : sim_net                         │
│                                                                 │
│  ┌──────────────┐   HTTP/WS    ┌──────────────────────────┐    │
│  │   frontend   │◄────────────►│        backend           │    │
│  │  React :3000 │              │  FastAPI + Socket.IO     │    │
│  └──────────────┘              │         :8000            │    │
│                                │                          │    │
│                                │  ┌────────────────────┐  │    │
│                                │  │   SUMO (process)   │  │    │
│                                │  │   TraCI socket     │  │    │
│                                │  └────────────────────┘  │    │
│                                └──────────┬───────────────┘    │
│                                           │ MongoDB driver      │
│                                ┌──────────▼───────────────┐    │
│                                │       mongodb            │    │
│                                │       Mongo 6  :27017    │    │
│                                └──────────────────────────┘    │
│                                           │                     │
│                                ┌──────────▼───────────────┐    │
│                                │     mongo-express        │    │
│                                │     UI admin   :8081     │    │
│                                └──────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### Les 4 services

| Service | Image | Port exposé | Rôle |
|---|---|---|---|
| `frontend` | Node 18 slim | `3000` | Interface React — simulation, génération, diagnostic, historique |
| `backend` | Ubuntu 22.04 + SUMO | `8000` | API FastAPI, moteur SUMO/TraCI, WebSocket temps réel |
| `mongodb` | mongo:6 | `27017` | Persistance des trajets, anomalies, prédictions |
| `mongo-express` | mongo-express | `8081` | UI d'administration MongoDB |

---

## Flux de données

```
Utilisateur
    │
    ▼
[React :3000]
    │  REST  POST /simulation/start
    │  REST  POST /scenario/generate
    │  WS    socket.io events
    ▼
[FastAPI :8000]
    │  traci.simulationStep()  (boucle async 10 fps)
    │  traci.vehicle.*
    │  traci.person.*
    ▼
[SUMO process]  ← lit casa.net.xml + casa.rou.xml
    │
    │  all_vehicles_state  (WebSocket → React)
    │  accidents_state     (WebSocket → React)
    │  emergency_alert     (WebSocket → React)
    │
    ▼
[MongoDB :27017]
    └── journeys       (trajets ego)
    └── traffic_logs   (positions GPS step par step)
    └── anomalies      (déviations IA)
    └── predictions    (vitesses prédites par segment)
```

---

## Démarrage rapide

### Prérequis

- Docker ≥ 24
- Docker Compose ≥ 2.20
- 4 Go de RAM disponibles (SUMO est gourmand)

### Lancer le projet

```bash
# Cloner le dépôt
git clone https://github.com/<user>/tmt-traffic-control.git
cd tmt-traffic-control

# Premier lancement (build des images)
docker compose up --build -d

# Vérifier que tout est UP
docker compose ps
```

### Accès

| Interface | URL |
|---|---|
| Application web | http://localhost:3000 |
| API FastAPI (Swagger) | http://localhost:8000/docs |
| MongoDB Express | http://localhost:8081 (admin / pass) |

### Arrêter proprement

```bash
docker compose down
```

### Nettoyage complet (supprime les volumes MongoDB)

```bash
docker compose down -v --remove-orphans
docker system prune -af --volumes
docker compose build --no-cache
docker compose up -d
```

---

## Structure des dossiers

```
tmt-traffic-control/
├── docker-compose.yml
├── README.md                  ← ce fichier
│
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── .env                   ← MONGO_URI, SUMO_HOME, etc.
│   └── src/
│       ├── main.py            ← FastAPI + Socket.IO + boucle SUMO
│       ├── maps/              ← fichiers SUMO (net.xml, rou.xml, sumocfg)
│       │   ├── casa.net.xml
│       │   ├── casa.rou.xml
│       │   ├── casa.sumocfg
│       │   └── <scenario_id>/  ← scénarios générés
│       └── services/
│           ├── GenerateService.py
│           ├── ScenarioConfigService.py
│           ├── SumoEngineService.py
│           ├── PersistenceService.py
│           └── SafetyAIService.py
│
└── frontend/
    ├── Dockerfile
    ├── package.json
    └── src/
        ├── components/
        │   ├── layout/
        │   │   └── Sidebar.jsx
        │   └── screens/
        │       ├── MapSolo.jsx      ← Simulation live
        │       ├── MapGlobal.jsx    ← Générateur de scénarios
        │       ├── Diagnostic.jsx   ← Métriques temps réel
        │       └── Historique.jsx   ← Trajets enregistrés
        └── services/
            ├── api.js
            └── socket.js
```

---

## Variables d'environnement

### Backend (`backend/.env`)

```env
MONGO_URI=mongodb://mongodb:27017
DATABASE_NAME=traffic_simulation
SUMO_HOME=/usr/share/sumo
SUMO_DATA_DIR=/app/src/maps
MODEL_PATH=           # optionnel : chemin vers un modèle IA .pkl
```

### Frontend (`docker-compose.yml`)

```env
REACT_APP_API_URL=http://localhost:8000
WATCHPACK_POLLING=true
```

---

## Technologies

| Couche | Stack |
|---|---|
| Simulation trafic | SUMO 1.26 + TraCI (Python) |
| API | FastAPI 0.11 + python-socketio |
| Temps réel | Socket.IO (WebSocket) |
| Base de données | MongoDB 6 + Motor (async driver) |
| IA / Prédiction | NumPy + moving average (fallback LSTM) |
| Frontend | React 18 + Leaflet + Recharts + Tailwind CSS |
| Conteneurisation | Docker Compose |

---

## Auteur

**Tamba Marcel Temessadouno** — Stagiaire ingénieur, FST Mohammedia  
Projet encadré par **Docteur Mohammed ADIL**