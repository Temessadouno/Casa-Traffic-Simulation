import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  Popup,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import { Play, Square, AlertTriangle, Navigation, Wifi, WifiOff } from "lucide-react";
import "leaflet/dist/leaflet.css";

/* =====================================================
   LEAFLET ICON FIX
===================================================== */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:       "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:     "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

/* =====================================================
   CONFIG
===================================================== */
const API_URL = "http://localhost:8000";

const SIMULATION_CONFIG = {
  start:            { lat: 33.596877, lng: -7.609460, name: "Départ"  },
  destination:      { lat: 33.589000, lng: -7.620000, name: "Arrivée" },
  trackedVehicleId: "ego",
};

const ROAD_ELEMENTS = [
  { id: 1, type: "traffic_light", lat: 33.592, lng: -7.614, status: "red"  },
  { id: 2, type: "junction",      lat: 33.590, lng: -7.617, risk:   "high" },
];

/* =====================================================
   HAVERSINE
===================================================== */
const haversine = (a, b) => {
  const R    = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

/* =====================================================
   CAMERA FOLLOW
===================================================== */
const CameraFollower = ({ position }) => {
  const map = useMap();
  useEffect(() => {
    if (!position) return;
    map.flyTo([position.lat, position.lng], 18, { duration: 0.5 });
  }, [position, map]);
  return null;
};

/* =====================================================
   SVG ICONS — propres, pas d'emoji
===================================================== */

/* Ego : grand point vert avec halo pulsant */
const egoIcon = () =>
  L.divIcon({
    className: "",
    html: `
      <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
        <circle cx="14" cy="14" r="13" fill="#22c55e" fill-opacity="0.2"/>
        <circle cx="14" cy="14" r="7"  fill="#22c55e" stroke="white" stroke-width="2.5"/>
        <circle cx="14" cy="14" r="3"  fill="white"/>
      </svg>`,
    iconSize:   [28, 28],
    iconAnchor: [14, 14],
  });

/* Véhicule voisin : petit point jaune */
const nearbyIcon = () =>
  L.divIcon({
    className: "",
    html: `
      <svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg">
        <circle cx="6" cy="6" r="5" fill="#facc15" stroke="white" stroke-width="1.5"/>
      </svg>`,
    iconSize:   [12, 12],
    iconAnchor: [6, 6],
  });

/* Départ : grand point vert clair avec anneau */
const startIcon = L.divIcon({
  className: "",
  html: `
    <svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
      <circle cx="18" cy="18" r="16" fill="#22c55e" fill-opacity="0.15" stroke="#22c55e" stroke-width="1.5"/>
      <circle cx="18" cy="18" r="9"  fill="#22c55e" stroke="white" stroke-width="2"/>
      <circle cx="18" cy="18" r="3"  fill="white"/>
    </svg>`,
  iconSize:   [36, 36],
  iconAnchor: [18, 18],
});

/* Arrivée : grand point rouge avec anneau */
const destIcon = L.divIcon({
  className: "",
  html: `
    <svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
      <circle cx="18" cy="18" r="16" fill="#ef4444" fill-opacity="0.15" stroke="#ef4444" stroke-width="1.5"/>
      <circle cx="18" cy="18" r="9"  fill="#ef4444" stroke="white" stroke-width="2"/>
      <circle cx="18" cy="18" r="3"  fill="white"/>
    </svg>`,
  iconSize:   [36, 36],
  iconAnchor: [18, 18],
});

/* Feu tricolore */
const trafficIcon = (status) =>
  L.divIcon({
    className: "",
    html: `
      <svg width="14" height="14" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
        <circle cx="7" cy="7" r="6" fill="${status === "red" ? "#ef4444" : "#22c55e"}"
          stroke="white" stroke-width="1.5"/>
      </svg>`,
    iconSize:   [14, 14],
    iconAnchor: [7, 7],
  });

/* Intersection dangereuse */
const junctionIcon = (risk) =>
  L.divIcon({
    className: "",
    html: `
      <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
        <polygon points="8,1 15,15 1,15"
          fill="${risk === "high" ? "#ef4444" : "#f59e0b"}"
          stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`,
    iconSize:   [16, 16],
    iconAnchor: [8, 15],
  });

/* =====================================================
   MAIN COMPONENT
===================================================== */
const MapSolo = () => {
  const [position,       setPosition]       = useState(SIMULATION_CONFIG.start);
  const [speed,          setSpeed]          = useState(0);
  const [heading,        setHeading]        = useState(0);
  const [socketStatus,   setSocketStatus]   = useState("disconnected");
  const [running,        setRunning]        = useState(false);
  const [journey,        setJourney]        = useState(false);
  const [warnings,       setWarnings]       = useState([]);
  const [trajectory,     setTrajectory]     = useState([]);
  const [nearbyVehicles, setNearbyVehicles] = useState({});

  const socketRef      = useRef(null);
  const mountedRef     = useRef(false);
  const warningTimeout = useRef(null);

  /* =====================================================
     WARNINGS
  ===================================================== */
  const addWarning = useCallback((msg, type = "info") => {
    setWarnings((prev) => {
      if (prev.find((w) => w.msg === msg)) return prev;
      return [{ id: Date.now(), msg, type }, ...prev.slice(0, 4)];
    });
    clearTimeout(warningTimeout.current);
    warningTimeout.current = setTimeout(() => setWarnings([]), 4000);
  }, []);

  /* =====================================================
     SOCKET — stable, résistant au StrictMode
  ===================================================== */
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;

    import("socket.io-client").then(({ io }) => {
      const socket = io(API_URL, {
        transports:           ["websocket"],
        reconnectionAttempts: 10,
        reconnectionDelay:    2000,
        autoConnect:          true,
      });

      socketRef.current = socket;

      socket.on("connect",       () => { setSocketStatus("connected");    addWarning("Serveur connecté"); });
      socket.on("disconnect",    () => { setSocketStatus("disconnected"); setRunning(false); setJourney(false); });
      socket.on("connect_error", () =>   setSocketStatus("error"));

      /* Ego */
      socket.on("vehicle_state", (data) => {
        if (!data?.id) return;
        if (String(data.id) !== SIMULATION_CONFIG.trackedVehicleId) return;
        if (data.lat == null || data.lng == null) return;

        const pos = { lat: data.lat, lng: data.lng };
        setPosition(pos);
        setSpeed(data.speed   || 0);
        setHeading(data.heading || 0);

        setTrajectory((prev) => {
          const updated = [...prev, [pos.lat, pos.lng]];
          return updated.length > 500 ? updated.slice(-500) : updated;
        });

        ROAD_ELEMENTS.forEach((e) => {
          const d = haversine(pos, e);
          if (e.type === "traffic_light" && e.status === "red" && d < 0.05)
            addWarning("Feu rouge proche", "danger");
          if (e.type === "junction" && e.risk === "high" && d < 0.05)
            addWarning("Zone dangereuse", "danger");
        });
      });

      /* Véhicules sur la même route */
      socket.on("nearby_vehicles", (data) => {
        if (!data?.vehicles) return;
        setNearbyVehicles(data.vehicles);
      });

      socket.on("emergency_alert", (d) => {
        addWarning(`Alerte collision — dist: ${d?.distance}m`, "danger");
      });

      socket.on("journey_end", () => {
        addWarning("Arrivée à destination !");
        setJourney(false);
        setRunning(false);
      });

      socket.on("system_error", (d) => {
        addWarning(d?.msg || "Erreur système", "error");
      });
    });

    return () => {
      clearTimeout(warningTimeout.current);
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      mountedRef.current = false;
    };
  }, []); // socket créé une seule fois au montage

  /* =====================================================
     ACTIONS
  ===================================================== */
  const startSimulation = async () => {
    try {
      const res = await fetch(`${API_URL}/simulation/start`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      setRunning(true);
      setTrajectory([]);
      setNearbyVehicles({});
      addWarning("Simulation démarrée");

      const socket = socketRef.current;
      if (!socket) { addWarning("Socket non prêt", "error"); return; }

      const emit = () =>
        socket.emit("start_journey", {
          origin:      SIMULATION_CONFIG.start,
          destination: SIMULATION_CONFIG.destination,
        });

      socket.connected ? emit() : socket.once("connect", emit);
      setJourney(true);

    } catch (err) {
      addWarning(`Erreur backend : ${err.message}`, "error");
    }
  };

  const stopSimulation = async () => {
    try {
      await fetch(`${API_URL}/simulation/stop`, { method: "POST" });
    } catch {}
    setRunning(false);
    setJourney(false);
    setTrajectory([]);
    setNearbyVehicles({});
  };

  /* =====================================================
     STATUS
  ===================================================== */
  const sc = {
    connected:    { label: "Connecté",   cls: "bg-green-900/60 border-green-500/30 text-green-300",  icon: <Wifi    size={11} /> },
    disconnected: { label: "Déconnecté", cls: "bg-slate-900/80 border-white/10    text-slate-400",   icon: <WifiOff size={11} /> },
    error:        { label: "Erreur",     cls: "bg-red-900/60   border-red-500/30   text-red-300",    icon: <WifiOff size={11} /> },
  }[socketStatus] || { label: "...", cls: "bg-slate-900/80 border-white/10 text-slate-400", icon: null };

  /* =====================================================
     RENDER
  ===================================================== */
  return (
    <div className="h-screen w-full relative bg-black text-white overflow-hidden">

      {/* ── TOP BAR ── */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] flex gap-3 items-center">
        <div className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs border font-mono ${sc.cls}`}>
          {sc.icon} {sc.label}
        </div>

        {!running ? (
          <button
            onClick={startSimulation}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 px-5 py-2 rounded-xl text-sm font-bold transition-all active:scale-95"
          >
            <Play size={15} /> Démarrer
          </button>
        ) : (
          <button
            onClick={stopSimulation}
            className="flex items-center gap-2 bg-red-600 hover:bg-red-500 px-5 py-2 rounded-xl text-sm font-bold transition-all active:scale-95"
          >
            <Square size={15} /> Arrêter
          </button>
        )}
      </div>

      {/* ── INFO PANEL ── */}
      <div className="absolute top-20 right-4 z-[1000] bg-black/80 border border-white/10 rounded-2xl p-4 text-xs space-y-3 min-w-[155px]">
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#22c55e"/></svg>
            <span className="text-green-400 font-bold uppercase text-[10px] tracking-widest">Départ</span>
          </div>
          <div className="text-gray-300 font-mono">{SIMULATION_CONFIG.start.lat.toFixed(5)}</div>
          <div className="text-gray-300 font-mono">{SIMULATION_CONFIG.start.lng.toFixed(5)}</div>
        </div>
        <div className="border-t border-white/10 pt-3">
          <div className="flex items-center gap-1.5 mb-1">
            <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#ef4444"/></svg>
            <span className="text-red-400 font-bold uppercase text-[10px] tracking-widest">Arrivée</span>
          </div>
          <div className="text-gray-300 font-mono">{SIMULATION_CONFIG.destination.lat.toFixed(5)}</div>
          <div className="text-gray-300 font-mono">{SIMULATION_CONFIG.destination.lng.toFixed(5)}</div>
        </div>
        <div className="border-t border-white/10 pt-3">
          <div className="flex items-center gap-1.5 mb-1">
            <svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#facc15"/></svg>
            <span className="text-yellow-400 font-bold uppercase text-[10px] tracking-widest flex items-center gap-1">
              <Navigation size={9} /> Proches
            </span>
          </div>
          <div className="text-gray-300 font-mono">{Object.keys(nearbyVehicles).length} véh.</div>
        </div>
        <div className="border-t border-white/10 pt-3">
          <div className="text-purple-400 font-bold mb-1 uppercase text-[10px] tracking-widest">Trajectoire</div>
          <div className="text-gray-300 font-mono">{trajectory.length} pts</div>
        </div>
      </div>

      {/* ── WARNINGS ── */}
      <div className="absolute top-20 left-4 z-[1000] space-y-2 max-w-[270px]">
        {warnings.map((w) => (
          <div
            key={w.id}
            className={`px-3 py-2 rounded-xl text-xs flex items-center gap-2 backdrop-blur-sm border ${
              w.type === "danger" ? "bg-red-950/80 border-red-500/50 text-red-300"
              : w.type === "error" ? "bg-orange-950/80 border-orange-500/50 text-orange-300"
              : "bg-black/80 border-white/10 text-gray-300"
            }`}
          >
            <AlertTriangle size={12} className="shrink-0" />
            {w.msg}
          </div>
        ))}
      </div>

      {/* ── MAP ── */}
      <MapContainer
        center={[SIMULATION_CONFIG.start.lat, SIMULATION_CONFIG.start.lng]}
        zoom={15}
        className="h-full w-full"
        zoomControl={false}
      >
        <TileLayer
          attribution="&copy; OpenStreetMap contributors"
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <CameraFollower position={journey ? position : null} />

        {/* Trajectoire */}
        {trajectory.length > 1 && (
          <Polyline positions={trajectory} color="#22c55e" weight={3} opacity={0.8} />
        )}

        {/* Départ */}
        <Marker
          position={[SIMULATION_CONFIG.start.lat, SIMULATION_CONFIG.start.lng]}
          icon={startIcon}
        >
          <Popup>
            <span className="font-bold text-green-600">Départ</span><br />
            {SIMULATION_CONFIG.start.lat.toFixed(5)}, {SIMULATION_CONFIG.start.lng.toFixed(5)}
          </Popup>
        </Marker>

        {/* Arrivée */}
        <Marker
          position={[SIMULATION_CONFIG.destination.lat, SIMULATION_CONFIG.destination.lng]}
          icon={destIcon}
        >
          <Popup>
            <span className="font-bold text-red-600">Arrivée</span><br />
            {SIMULATION_CONFIG.destination.lat.toFixed(5)}, {SIMULATION_CONFIG.destination.lng.toFixed(5)}
          </Popup>
        </Marker>

        {/* Éléments routiers */}
        {ROAD_ELEMENTS.map((e) => (
          <Marker
            key={e.id}
            position={[e.lat, e.lng]}
            icon={e.type === "traffic_light" ? trafficIcon(e.status) : junctionIcon(e.risk)}
          >
            <Popup>
              {e.type === "traffic_light"
                ? `Feu ${e.status === "red" ? "rouge" : "vert"}`
                : `Intersection — risque ${e.risk}`}
            </Popup>
          </Marker>
        ))}

        {/* Véhicules voisins — petits points jaunes */}
        {Object.entries(nearbyVehicles).map(([vid, v]) => (
          <Marker
            key={vid}
            position={[v.lat, v.lng]}
            icon={nearbyIcon()}
          >
            <Popup>
              <div className="text-xs font-mono">
                <strong>{vid}</strong><br />
                {Math.round(v.speed || 0)} km/h
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Ego — grand point vert */}
        <Marker
          position={[position.lat, position.lng]}
          icon={egoIcon()}
        >
          <Popup>
            <div className="text-sm font-mono">
              <strong className="text-green-600">Ego (suivi)</strong><br />
              {Math.round(speed)} km/h · cap {Math.round(heading)}°<br />
              <span className="text-gray-400 text-xs">
                {position.lat.toFixed(5)}, {position.lng.toFixed(5)}
              </span>
            </div>
          </Popup>
        </Marker>
      </MapContainer>

      {/* ── SPEED HUD ── */}
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-[1000] text-center pointer-events-none select-none">
        <div className="text-6xl font-black tabular-nums leading-none drop-shadow-lg">
          {Math.round(speed)}
        </div>
        <div className="text-xs text-gray-400 mt-1 tracking-widest uppercase">km/h</div>
        <div className={`text-xs mt-2 font-bold tracking-widest ${journey ? "text-green-400" : "text-gray-600"}`}>
          {journey ? "● EN ROUTE" : "○ IDLE"}
        </div>
      </div>

    </div>
  );
};

export default MapSolo;