# TMT Traffic Control — Simulation de Trafic & IA · Casablanca

> Simulation de trafic urbain en temps réel avec détection d'accidents par IA, construite sur **SUMO**, **FastAPI**, **React** et **MongoDB**. Ville cible : **Casablanca, Maroc**.

---

## Table des matières

1. [Vue d'ensemble](#vue-densemble)
2. [Architecture](#architecture)
3. [Stack technique](#stack-technique)
4. [Structure du projet](#structure-du-projet)
5. [Installation & démarrage](#installation--démarrage)
6. [Fonctionnalités implémentées](#fonctionnalités-implémentées)
7. [Interfaces frontend](#interfaces-frontend)
8. [API REST](#api-rest)
9. [Protocole WebSocket](#protocole-websocket)
10. [Prochaines étapes](#prochaines-étapes)

---

## Vue d'ensemble

Ce projet simule la circulation dans la ville de Casablanca en utilisant le moteur de simulation SUMO (Simulation of Urban MObility). Un véhicule tracké ("ego") se déplace sur le réseau routier réel (`casa.net.xml`), sa position est diffusée en temps réel vers une interface cartographique React/Leaflet via WebSocket, et chaque déplacement est persisté en base MongoDB.

Un module d'IA de sécurité (`SafetyAIService`) analyse en continu les distances inter-véhiculaires et émet des alertes de collision.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   FRONTEND (React)                   │
│  MapSolo · MapGlobal · Historique · Diagnostic       │
│              socket.io-client + Leaflet              │
└───────────────────┬─────────────────────────────────┘
                    │  WebSocket (socket.io)
                    │  HTTP REST (fetch)
┌───────────────────▼─────────────────────────────────┐
│              BACKEND (FastAPI + socket.io)           │
│                                                      │
│  ┌─────────────────┐   ┌──────────────────────────┐ │
│  │ SumoEngineService│   │    SafetyAIService        │ │
│  │  TraCI · SUMO   │   │  Détection collision      │ │
│  └────────┬────────┘   └──────────────────────────┘ │
│           │                                          │
│  ┌────────▼────────┐   ┌──────────────────────────┐ │
│  │PersistenceService│   │       API Routes          │ │
│  │    MongoDB       │   │  /status /journeys /api   │ │
│  └─────────────────┘   └──────────────────────────┘ │
└───────────────────┬─────────────────────────────────┘
                    │  TraCI Protocol
┌───────────────────▼─────────────────────────────────┐
│                    SUMO 1.26.0                        │
│         casa.net.xml · casa.rou.xml                  │
└─────────────────────────────────────────────────────┘
                    │
┌───────────────────▼─────────────────────────────────┐
│                   MongoDB                            │
│    journeys · traffic_logs · accidents               │
└─────────────────────────────────────────────────────┘
```

---

## Stack technique

| Couche | Technologie | Version |
|---|---|---|
| Simulation | SUMO | 1.26.0 |
| Backend | FastAPI + Uvicorn | Python 3.11+ |
| WebSocket | python-socketio | async |
| Interface TraCI | traci (libsumo) | SUMO 1.26 |
| Base de données | MongoDB + Motor | async |
| Frontend | React | 18 |
| Cartographie | React-Leaflet + Leaflet | 4.x / 1.9 |
| Temps réel | socket.io-client | 4.x |
| Conteneurisation | Docker + docker-compose | — |

---

## Structure du projet

```
tmt-traffic/
│
├── backend/
|   ├── data/
│          ├── casa.net.xml                   # Réseau routier Casablanca (OSM export)
│          ├── casa.rou.xml                   # Définition des routes et véhicules
│          └── casa.sumocfg                   # Configuration SUMO
│   ├── main.py                        # Point d'entrée FastAPI + socket.io
│   └── src/
│       ├── api/
│       │   └── routes.py              # Endpoints REST /api/*
│       ├── models/
│       │   └── traffic_models.py      # Pydantic : GeoPoint, TrajectoryPoint, Journey
│       └── services/
│           ├── SumoEngineService.py   # TraCI, création véhicule ego, steps
│           ├── SafetyAIService.py     # Détection collision inter-véhicules
│           └── PersistenceService.py  # CRUD MongoDB (journeys, logs, accidents)
│
├── frontend/
│   └── src/
│       └── components/screens/
│           ├── MapSolo.jsx            # Suivi du véhicule ego + voisins de route
│           ├── MapGlobal.jsx          # Vue globale de tous les véhicules SUMO
│           ├── Historique.jsx         # Trajectoires passées depuis MongoDB
│           └── Diagnostic.jsx         # Statistiques simulation en temps réel
│
│
└── docker-compose.yml
```

---

## Installation & démarrage

### Prérequis

- Docker & docker-compose
- SUMO 1.26.0 (si exécution locale sans Docker)
- Node.js 18+ (frontend)

### Avec Docker

```bash
# Cloner le dépôt
git clone https://github.com/votre-org/tmt-traffic.git
cd tmt-traffic

# Démarrer tous les services
docker-compose up --build

# Backend disponible sur  : http://localhost:8000
# Frontend disponible sur : http://localhost:3000
```

### Sans Docker (développement)

```bash
# Backend
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Frontend
cd frontend
npm install
npm start
```

### Lancer une simulation

1. Ouvrir `http://localhost:3000`
2. Aller sur l'onglet **MapSolo** ou **MapGlobal**
3. Cliquer **Démarrer** — SUMO démarre, le véhicule ego est créé
4. Le suivi commence automatiquement via WebSocket
5. Cliquer **Arrêter** pour terminer

---

## Fonctionnalités implémentées

### Simulation SUMO

- Démarrage/arrêt de SUMO via l'API REST (`POST /simulation/start`, `POST /simulation/stop`)
- Création du véhicule ego avec mapping coordonnées GPS → edges SUMO (`_nearest_edge`)
- Conversion des coordonnées SUMO XY → GPS (lat/lng) via `traci.simulation.convertGeo`
- Contrôle de la distance de sécurité (arrêt < 5 m, ralentissement < 15 m)
- Recréation automatique du véhicule ego s'il disparaît du réseau
- Diffusion de tous les véhicules SUMO (`all_vehicles_state`) à chaque step

### Temps réel

- WebSocket stable résistant au StrictMode React (guard `mountedRef`)
- Émission `vehicle_state` pour le véhicule ego à chaque step (0.1 s)
- Émission `nearby_vehicles` : véhicules sur le même edge ou la même route
- Émission `emergency_alert` si distance inter-véhiculaire critique

### Persistance

- Création d'un journey à chaque démarrage de trajet
- Enregistrement de chaque step (coords, vitesse, cap, timestamp) dans `traffic_logs`
- Finalisation du journey à l'arrivée (statut `completed`, `end_time`)
- Détection et enregistrement des accidents dans la collection `accidents`

### Frontend

| Vue | Description |
|---|---|
| **MapSolo** | Suivi du véhicule ego (point vert), voisins de route (points jaunes), trajectoire, alertes |
| **MapGlobal** | Tous les véhicules SUMO sur la carte, compteur live, alertes collision |
| **Historique** | Liste des trajets MongoDB, mini-carte de trajectoire par trajet, stats vitesse |
| **Diagnostic** | Compteurs live (véhicules actifs, trajets, étapes), statut SUMO, infos système |

---

## API REST

| Méthode | Endpoint | Description |
|---|---|---|
| `GET` | `/status` | Statut SUMO (running, loaded) |
| `POST` | `/simulation/start` | Démarre SUMO |
| `POST` | `/simulation/stop` | Arrête SUMO |
| `GET` | `/journeys` | Liste des 20 derniers trajets |
| `GET` | `/journeys/{id}` | Détail d'un trajet + steps GPS |
| `GET` | `/api/health` | Santé du service |
| `GET` | `/api/simulation/vehicles` | Liste des véhicules actifs dans SUMO |
| `GET` | `/api/simulation/vehicle/{id}` | Position et vitesse d'un véhicule |

---

## Protocole WebSocket

### Émis par le client (frontend → backend)

| Événement | Payload | Description |
|---|---|---|
| `start_journey` | `{ origin, destination }` | Lance la boucle de simulation |

### Émis par le serveur (backend → frontend)

| Événement | Payload | Description |
|---|---|---|
| `vehicle_state` | `{ id, lat, lng, speed, heading }` | Position ego à chaque step |
| `all_vehicles_state` | `{ vehicles: { id: {...} } }` | Snapshot de tous les véhicules |
| `nearby_vehicles` | `{ vehicles: { id: {...} } }` | Véhicules sur la même route |
| `emergency_alert` | `{ vehicle_id, nearest_vehicle, distance, severity }` | Alerte collision |
| `simulation_status` | `{ status: "started" | "stopped" }` | Changement d'état SUMO |
| `journey_end` | `{ msg }` | Fin de trajet |
| `system_error` | `{ msg }` | Erreur backend |

---

## Prochaines étapes

### 1. Modèle IA de prédiction d'accidents

L'objectif principal du projet est d'intégrer un modèle de machine learning capable de **prédire les zones à risque** avant qu'un accident se produise.

- Collecter un dataset d'entraînement depuis les logs MongoDB (positions, vitesses, distances, conditions)
- Entraîner un modèle de classification (Random Forest ou LSTM) sur les séquences de déplacements précédant un incident
- Exposer le modèle via un endpoint `/api/predict/risk` qui retourne un score de risque par zone
- Afficher les zones à risque sur la carte sous forme de heatmap Leaflet

### 2. Mapping GPS → edges SUMO précis

Le mapping actuel (`_nearest_edge`) parcourt tous les edges et prend le plus proche par distance euclidienne, ce qui peut introduire des erreurs sur les routes à sens unique ou les échangeurs.

- Utiliser `traci.simulation.convertRoad(x, y, isGeo=False, vClass="passenger")` qui est la méthode officielle TraCI
- Implémenter un cache des edges valides au démarrage pour éviter le parcours complet à chaque appel
- Ajouter une validation : vérifier que `findRoute(start, end)` retourne bien un chemin passant près des coordonnées GPS d'origine

### 3. Scénarios d'accidents simulés

- Définir des scénarios dans les fichiers SUMO (`.rou.xml`) : freinage brutal, collision frontale, obstruction de voie
- Déclencher ces scénarios via l'API (`POST /simulation/scenario/{type}`) pendant une simulation active
- Enregistrer les données télémétriques pré/post incident pour alimenter le dataset IA

### 4. Tableau de bord analytique

- Graphiques de vitesse moyenne par tronçon (heure par heure)
- Carte de chaleur des zones de congestion sur le réseau Casablanca
- Historique des alertes de collision avec rejeu de trajectoire
- Export CSV/JSON des données de simulation

### 5. Authentification & multi-utilisateurs

- Ajouter JWT pour sécuriser les endpoints sensibles
- Permettre plusieurs sessions de simulation simultanées avec isolation par `journey_id`
- Interface d'administration pour gérer les scénarios et consulter les logs

### 6. Optimisations performance

- Réduire la fréquence d'émission WebSocket (actuellement 10 Hz) et introduire une interpolation côté frontend pour fluidifier le rendu
- Utiliser `traci.vehicle.subscribeContext` à la place du polling manuel pour réduire la charge TraCI
- Indexer `traffic_logs` sur `(journey_id, timestamp)` pour accélérer les requêtes historique

---

## Contribuer

```bash
# Créer une branche feature
git checkout -b feature/nom-de-la-fonctionnalite

# Commiter avec un message descriptif
git commit -m "feat: ajout heatmap zones à risque"

# Ouvrir une Pull Request vers main
```

---

## Licence

Projet de Stage ILISI 2ème Année.