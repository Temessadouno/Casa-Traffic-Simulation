import React, { useState, useEffect, useRef, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import { LocateFixed, AlertTriangle, Car, Radio, Wifi, WifiOff } from "lucide-react";
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

const CENTER  = { lat: 33.5731, lng: -7.5898 };
const EGO_ID  = "ego";
const API_URL = "http://localhost:8000";

/* =====================================================
   AUTO RECENTER
===================================================== */
const RecenterMap = ({ coords }) => {
  const map = useMap();
  useEffect(() => {
    if (coords?.lat && coords?.lng)
      map.setView([coords.lat, coords.lng], 14, { animate: true });
  }, [coords, map]);
  return null;
};

/* =====================================================
   ICONS
===================================================== */
/* Ego : grand point vert */
const egoIconGlobal = () =>
  L.divIcon({
    className: "",
    html: `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
      <circle cx="11" cy="11" r="10" fill="#22c55e" fill-opacity="0.2"/>
      <circle cx="11" cy="11" r="6"  fill="#22c55e" stroke="white" stroke-width="2"/>
      <circle cx="11" cy="11" r="2.5" fill="white"/>
    </svg>`,
    iconSize:   [22, 22],
    iconAnchor: [11, 11],
  });

/* Véhicule ordinaire : petit point jaune, rouge si alerte */
const vehicleIconGlobal = (hasAlert = false) =>
  L.divIcon({
    className: "",
    html: `<svg width="10" height="10" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">
      <circle cx="5" cy="5" r="4" fill="${hasAlert ? "#ef4444" : "#facc15"}" stroke="white" stroke-width="1.5"/>
    </svg>`,
    iconSize:   [10, 10],
    iconAnchor: [5, 5],
  });

const makeVehicleIcon = (isEgo = false, hasAlert = false) =>
  isEgo ? egoIconGlobal() : vehicleIconGlobal(hasAlert);

/* =====================================================
   COMPONENT
===================================================== */
const MapGlobal = () => {
  const [vehicles,      setVehicles]      = useState({});
  const [alerts,        setAlerts]        = useState([]);
  const [socketStatus,  setSocketStatus]  = useState("disconnected");
  const [userPosition,  setUserPosition]  = useState(null);
  const [alertVehicles, setAlertVehicles] = useState(new Set());

  // On garde une ref stable vers le socket pour éviter les re-créations
  const socketRef    = useRef(null);
  const mountedRef   = useRef(false);   // guard contre StrictMode double-mount
  const watchRef     = useRef(null);
  const alertTimeout = useRef(null);

  /* =====================================================
     ALERT HELPER
  ===================================================== */
  const addAlert = useCallback((msg, vehicleId = null) => {
    const id = Date.now();
    setAlerts((prev) => [{ id, msg, vehicleId }, ...prev.slice(0, 4)]);

    if (vehicleId) {
      setAlertVehicles((prev) => new Set([...prev, vehicleId]));
      setTimeout(() => {
        setAlertVehicles((prev) => {
          const n = new Set(prev); n.delete(vehicleId); return n;
        });
      }, 3000);
    }

    clearTimeout(alertTimeout.current);
    alertTimeout.current = setTimeout(() => setAlerts([]), 6000);
  }, []);

  /* =====================================================
     SOCKET — créé une seule fois, stable
  ===================================================== */
  useEffect(() => {
    // Guard React StrictMode : ne crée le socket qu'une seule fois
    if (mountedRef.current) return;
    mountedRef.current = true;

    // Import dynamique pour éviter SSR et double-instanciation
    import("socket.io-client").then(({ io }) => {
      const socket = io(API_URL, {
        transports:          ["websocket"],
        reconnectionAttempts: 10,
        reconnectionDelay:    2000,
        autoConnect:          true,
      });

      socketRef.current = socket;

      socket.on("connect", () => {
        setSocketStatus("connected");
        console.log("✅ Socket connecté:", socket.id);
      });

      socket.on("disconnect", (reason) => {
        setSocketStatus("disconnected");
        console.warn("⚠️ Socket déconnecté:", reason);
      });

      socket.on("connect_error", (err) => {
        setSocketStatus("error");
        console.error("❌ Socket erreur:", err.message);
      });

      /* ── vehicle_state : un véhicule à la fois ── */
      socket.on("vehicle_state", (data) => {
        if (!data?.id || data.lat == null || data.lng == null) return;
        setVehicles((prev) => ({
          ...prev,
          [data.id]: {
            lat:     data.lat,
            lng:     data.lng,
            speed:   data.speed   || 0,
            heading: data.heading || 0,
          },
        }));
      });

      /* ── all_vehicles_state : snapshot complet depuis backend ── */
      socket.on("all_vehicles_state", (data) => {
        if (!data?.vehicles) return;
        setVehicles(data.vehicles);
      });

      socket.on("emergency_alert", (d) => {
        addAlert(
          `🚨 Collision — ${d.vehicle_id} ↔ ${d.nearest_vehicle} (${d.distance}m)`,
          d.vehicle_id
        );
      });

      socket.on("simulation_status", (d) => {
        if (d?.status === "stopped") setVehicles({});
      });
    });

    return () => {
      clearTimeout(alertTimeout.current);
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      mountedRef.current = false;
    };
  }, []); // socket créé une seule fois au montage

  /* =====================================================
     GPS RÉEL
  ===================================================== */
  const startGPS = useCallback(() => {
    if (!navigator.geolocation) return;
    if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current);
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => setUserPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => console.warn("GPS error:", err),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }, []);

  useEffect(() => {
    startGPS();
    return () => {
      if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current);
    };
  }, [startGPS]);

  /* =====================================================
     DERIVED
  ===================================================== */
  const vehicleList  = Object.entries(vehicles);
  const vehicleCount = vehicleList.length;

  const statusConfig = {
    connected:    { color: "text-green-400", bg: "bg-green-900/30 border-green-500/30", icon: <Wifi size={11} />,    label: "Connecté"    },
    disconnected: { color: "text-slate-400", bg: "bg-slate-800/50 border-slate-600/30", icon: <WifiOff size={11} />, label: "Déconnecté"  },
    error:        { color: "text-red-400",   bg: "bg-red-900/30 border-red-500/30",     icon: <WifiOff size={11} />, label: "Erreur"       },
  };
  const sc = statusConfig[socketStatus] || statusConfig.disconnected;

  /* =====================================================
     RENDER
  ===================================================== */
  return (
    <div className="h-full flex flex-col relative bg-slate-950 overflow-hidden">

      {/* ── TOP HUD ── */}
      <div className="absolute top-4 left-4 right-4 z-[1000] flex justify-between items-start gap-3 pointer-events-none">

        {/* Title + status */}
        <div className="bg-slate-900/90 backdrop-blur-md border border-white/10 px-4 py-3 rounded-2xl pointer-events-auto">
          <div className="flex items-center gap-2 mb-1">
            <Radio size={13} className={sc.color} />
            <span className="text-white font-black text-xs uppercase tracking-widest">
              Vue Globale SUMO
            </span>
          </div>
          <p className="text-[10px] text-slate-400 font-mono">
            {vehicleCount > 0
              ? `${vehicleCount} véhicule${vehicleCount > 1 ? "s" : ""} en simulation`
              : "En attente de données SUMO..."}
          </p>
        </div>

        {/* Counters + GPS button */}
        <div className="flex gap-2 pointer-events-auto">
          <div className="bg-slate-900/90 backdrop-blur-md border border-white/10 px-4 py-3 rounded-2xl text-center min-w-[56px]">
            <div className="text-2xl font-black text-blue-400 tabular-nums leading-none">
              {vehicleCount}
            </div>
            <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-1 flex items-center justify-center gap-1">
              <Car size={8} /> véhicules
            </div>
          </div>

          <div className="bg-slate-900/90 backdrop-blur-md border border-white/10 px-4 py-3 rounded-2xl text-center min-w-[56px]">
            <div className="text-2xl font-black text-red-400 tabular-nums leading-none">
              {alerts.length}
            </div>
            <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-1 flex items-center justify-center gap-1">
              <AlertTriangle size={8} /> alertes
            </div>
          </div>

          <div className={`px-3 py-3 rounded-2xl border text-[10px] font-bold flex items-center gap-1.5 ${sc.bg} ${sc.color}`}>
            {sc.icon} {sc.label}
          </div>

          <button
            onClick={startGPS}
            className="bg-blue-700 hover:bg-blue-600 text-white px-4 py-3 rounded-2xl transition-all active:scale-95"
            title="Recentrer sur ma position"
          >
            <LocateFixed size={18} />
          </button>
        </div>
      </div>

      {/* ── MAP ── */}
      <div className="flex-1 z-0">
        <MapContainer
          center={[CENTER.lat, CENTER.lng]}
          zoom={13}
          scrollWheelZoom
          className="h-full w-full"
        >
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {userPosition && <RecenterMap coords={userPosition} />}

          {/* Tous les véhicules SUMO */}
          {vehicleList.map(([vid, v]) => (
            <Marker
              key={vid}
              position={[v.lat, v.lng]}
              icon={makeVehicleIcon(vid === EGO_ID, alertVehicles.has(vid))}
            >
              <Popup>
                <div className="font-mono text-xs leading-relaxed">
                  <strong className={vid === EGO_ID ? "text-blue-600" : "text-gray-700"}>
                    {vid === EGO_ID ? "● Ego (suivi)" : `· ${vid}`}
                  </strong><br />
                  Vitesse : {Math.round(v.speed)} km/h<br />
                  Cap     : {Math.round(v.heading)}°<br />
                  <span className="text-gray-400">
                    {v.lat.toFixed(5)}, {v.lng.toFixed(5)}
                  </span>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      {/* ── ALERTS ── */}
      {alerts.length > 0 && (
        <div className="absolute bottom-6 left-4 right-4 z-[1000] space-y-2 pointer-events-none">
          {alerts.map((a) => (
            <div
              key={a.id}
              className="bg-red-950/90 border border-red-500/50 px-4 py-3 rounded-2xl backdrop-blur-md flex items-center gap-3"
            >
              <AlertTriangle className="text-red-400 shrink-0" size={16} />
              <span className="text-xs text-red-200 font-mono">{a.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MapGlobal;