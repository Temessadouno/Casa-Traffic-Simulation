#  Simulation d'Accidents de Trafic par IA - Casablanca

Ce projet vise à simuler, analyser et prédire les congestions et risques d'accidents dans la ville de Casablanca en utilisant le moteur **SUMO** (Simulation of Urban MObility) et des modèles d'**Intelligence Artificielle**.

##  Architecture du Projet

Le projet suit une architecture micro-services orchestrée par **Docker** :
*   **Backend** : API FastAPI (Python) gérant la logique de simulation (TraCI) et l'IA.
*   **Frontend** : Interface React pour la visualisation cartographique du trafic.
*   **Base de données** : MongoDB pour le stockage des logs de trafic en temps réel.

##  Technologies Utilisées
*   **Simulation** : SUMO, TraCI.
*   **Backend** : FastAPI, Motor (Async MongoDB), Pydantic.
*   **IA** : Modèles de prédiction (DCRNN / Inférence Bayésienne).
*   **DevOps** : Docker, Docker-Compose.
*   **Cartographie** : OpenStreetMap (OSM) pour Casablanca.

## Structure des Dossiers
```text
simulation-accidents-ia/
├── backend/            # Code source Python (FastAPI + SUMO)
│   ├── data/           # Fichiers OSM et configurations de Casablanca
│   ├── src/            # Logique API et Database
│   └── simulation/     # Moteur de simulation (engine.py)
├── frontend/           # Interface utilisateur (React)
├── docs/               # Documentation UML et architecture
└── docker-compose.yml  # Orchestration des conteneurs


//Les commandes du docker-compose

---Construistion des images et conteneur
>>>>>> docker-compose up --build

---- Intallation des bibliothèque pour la génération de fichier .png
>>>> docker exec -it -u root backend_sim pip install matplotlib