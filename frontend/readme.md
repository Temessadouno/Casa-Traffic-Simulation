# Frontend — TMT Traffic Control

Interface web React de la plateforme de simulation. Elle communique avec le backend via REST (axios) et WebSocket (Socket.IO) pour afficher la simulation en temps réel, générer des scénarios, analyser les métriques et consulter l'historique des trajets.

---

## Stack technique

| Composant | Version | Rôle |
|---|---|---|
| React | 18 | Framework UI |
| Leaflet / react-leaflet | 1.9 / 4.x | Carte interactive |
| Socket.IO client | 4.x | WebSocket temps réel |
| Axios | 1.x | Requêtes REST |
| Recharts | 2.x | Graphes temps réel |
| Tailwind CSS | 3.x | Utilitaires CSS (layout, couleurs) |
| html2canvas | 1.4 | Export PNG des analyses |
| lucide-react | 0.38 | Icônes SVG |

---

## Dockerfile

```dockerfile
FROM node:18-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY . .
ENV HOST=0.0.0.0
ENV PORT=3000
ENV CHOKIDAR_USEPOLLING=true   # nécessaire pour le hot-reload dans Docker
EXPOSE 3000
CMD ["npm", "start"]
```

Le volume `./frontend:/app` monte le code source local dans le container — toute modification est prise en compte instantanément sans rebuild.

---

## Architecture des composants

```
src/
├── App.jsx                         ← Routing entre les 4 écrans
├── components/
│   ├── layout/
│   │   ├── Navbar.jsx              ← Barre de navigation haute (titre, login)
│   │   └── Sidebar.jsx             ← Menu latéral (4 items + sous-titres)
│   └── screens/
│       ├── MapSolo.jsx             ← Écran Simulation (carte live)
│       ├── MapGlobal.jsx           ← Écran Générateur (création scénarios)
│       ├── Diagnostic.jsx          ← Écran Analyse (métriques + graphes)
│       └── Historique.jsx          ← Écran Historique (trajets enregistrés)
└── services/
    ├── api.js                      ← Couche REST (axios)
    └── socket.js                   ← Couche WebSocket (Socket.IO)
```

---

## Services

### `services/api.js`

Client axios pointant sur `REACT_APP_API_URL` (défaut : `http://localhost:8000`).

Méthodes principales :

```javascript
apiService.startSimulation()          // POST /simulation/start
apiService.stopSimulation()           // POST /simulation/stop
apiService.startJourney(origin, dest) // POST /journey/start
apiService.getJourneys(limit)         // GET  /journeys
apiService.getJourneyById(id)         // GET  /journeys/{id}
apiService.getTrafficStatistics()     // GET  /traffic/statistics
apiService.getAnomalies(limit)        // GET  /traffic/anomalies
apiService.getAIInfo()                // GET  /ai/info
```

### `services/socket.js`

Singleton Socket.IO. Reconnexion automatique (5 tentatives, délai exponentiel).

Routing intelligent des `emergency_alert` entrants :

```
emergency_alert
  ├── event === "ROAD_BLOCKED" → émet "road_alert"
  ├── event === "ACCIDENT"     → émet "accident_alert"
  └── sinon                    → émet "emergency_alert" + "collision_risk_alert"
```

Utilisation :

```javascript
socketService.connect()
socketService.on("all_vehicles_state", callback)
socketService.off("all_vehicles_state", callback)
socketService.emit("start_journey", { origin, destination })
```

---

## Écrans

### MapSolo — Simulation live

Carte Leaflet plein écran avec :

**Véhicules** — icônes SVG orientées dans leur direction de déplacement, colorées selon la vitesse (gris=arrêt, rouge < 10, orange 10–30, jaune 30–50, vert 50–80, bleu > 80 km/h). Clic droit pour suivre un véhicule (mode caméra auto).

**Piétons** — points cyan 10px.

**Accidents** — icône dédiée selon la cause :
- Collision : SVG 2 voitures face-à-face avec flammes animées + halo pulsant
- Panne : icône ronde orange avec emoji 🔧
- Feu grillé : icône jaune 🚦
- Obstacle : icône violette 🚧
- Piétons : icône bleue 🚶

Popup au clic : cause, ID, véhicules bloqués avec leurs IDs.

**Navbar fixe** — statut WebSocket, compteur véhicules, véhicule suivi avec vitesse.

**Sidebar simulation** (uniquement pendant simulation) — bouton toggle droit qui déroule verticalement : ×1 ×2 ×5 vitesse, caméra auto/libre, liste véhicules, scénario, arrêt.

**Panneau d'analyse** (bouton bas centre) — 4 onglets :
- Vitesses : courbe moy/max/min + ligne 50 km/h + distribution
- Prédiction : courbe IA temps réel par tronçon
- Accidents : liste avec cause, bloqués
- Alertes : scrollable, dismissable

### MapGlobal — Générateur de scénarios

Carte Leaflet avec panneau latéral droit (340px) :

1. **Nom** du scénario (optionnel)
2. **Zone** — dessin d'un rectangle par clic + glisser, affichage NW/SE + superficie km²
3. **Paramètres** — steppers Véhicules / Piétons / Durée
4. **Accidents** — placement par clic sur la carte, liste numérotée
5. **Récapitulatif** + **Journal de génération** en temps réel
6. **Footer** — bouton Générer, puis Valider les routes + Nouveau scénario

Les accidents placés sur la carte sont transmis au backend sous la forme `[{lat, lng}]`. La cause est assignée aléatoirement si non précisée.

### Diagnostic — Analyse temps réel

Toutes les données viennent des **événements Socket.IO** (véhicules, anomalies, prédictions, alerts) — pas de polling REST pendant la simulation.

4 graphes Recharts mis à jour à chaque step :
- **AreaChart** vitesse moy/max/min sur 60s glissantes
- **AreaChart** volume (total + arrêtés)
- **BarChart** distribution des vitesses (5 bandes colorées, cellules individuelles)
- **LineChart** vitesses prédites par l'IA

Sections complémentaires : état réseau REST, accidents actifs, anomalies récentes (10 min), alertes scrollables + dismissables, historique trajets, infrastructure.

### Historique — Trajets enregistrés

Données chargées via REST au montage, détail chargé à la demande (mis en cache).

Chaque trajet dépliable affiche :
- 4 KPIs (distance, vitesse moy/max/min)
- **Carte trajectoire** — segments Leaflet colorés par vitesse, marqueurs A (départ) et B (arrivée)
- **Profil de vitesse** — AreaChart sur les étapes
- **Distribution** — BarChart avec Cell par bande
- Anomalies et prédictions IA du trajet
- Log de positions (30 premières entrées)

**Export PNG** — bouton "Exporter en PNG" dans le détail. Construit une div hors-écran contenant :
- En-tête (titre, ID, date)
- 6 KPIs
- Carte SVG reconstruite depuis les coordonnées GPS (segments colorés, marqueurs A/B)
- Graphes clonés depuis le DOM Recharts (SVG inline)
- Anomalies
- Footer

Capturé à 2× (scale:2) via html2canvas → fichier `trajet_<id>.png`.

---

## Palette de couleurs

Tous les écrans partagent les mêmes design tokens :

```javascript
const T = {
  bg0:    "#05090f",   // fond principal (noir profond)
  bg1:    "#08111e",   // panneaux
  bg2:    "#0f172a",   // cartes / blocs
  bg3:    "#1e293b",   // éléments interactifs
  border: "#1e3a5f",   // bordures
  accent: "#3b82f6",   // bleu accent
  cyan:   "#06b6d4",   // piétons, info
  green:  "#22c55e",   // succès, départ
  orange: "#f97316",   // avertissements
  red:    "#ef4444",   // danger, arrivée
  purple: "#a78bfa",   // IA, prédictions
  text:   "#e2e8f0",   // texte principal
  muted:  "#475569",   // texte secondaire
  dim:    "#334155",   // texte tertiaire
};
```

---

## Variables d'environnement

```env
REACT_APP_API_URL=http://localhost:8000
REACT_APP_SOCKET_URL=http://localhost:8000
WATCHPACK_POLLING=true    # hot-reload Docker
HOST=0.0.0.0
PORT=3000
```

---

## Développement

```bash
# Accéder au container frontend
docker exec -it frontend_sim sh

# Voir les logs
docker compose logs -f frontend

# Rebuild après modification du package.json
docker compose up --build frontend
```

Le hot-reload fonctionne automatiquement pour toute modification de `.jsx` ou `.css` grâce au volume monté et à `WATCHPACK_POLLING=true`.