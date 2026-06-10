// frontend/src/components/screens/MapGlobal.jsx
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  MapContainer, TileLayer, Marker, Popup,
  Rectangle, useMap, useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import {
  LocateFixed, Car, Wifi, WifiOff,
  Crosshair, MapPin, Trash2, Send, CheckCircle,
  Layers, Minus, Plus, Tag, X, ChevronRight,
  AlertTriangle, RefreshCw,
} from "lucide-react";
import "leaflet/dist/leaflet.css";
import socketService from "../../services/socket";

const API = process.env.REACT_APP_API_URL || "http://localhost:8000";

/* ─── Leaflet fix ────────────────────────────────────────────── */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:       "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:     "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

const CENTER = { lat: 33.5731, lng: -7.5898 };

/* ─── Speed color ────────────────────────────────────────────── */
const speedColor = (s) => {
  if (!s || s <= 0) return "#64748b";
  if (s <= 10)  return "#ef4444";
  if (s <= 30)  return "#f97316";
  if (s <= 50)  return "#eab308";
  if (s <= 80)  return "#22c55e";
  return "#3b82f6";
};

/* ─── Icons ──────────────────────────────────────────────────── */
const carSVG = (color, size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
    <rect x="9" y="6" width="14" height="20" rx="4" fill="${color}"/>
    <rect x="11" y="10" width="10" height="8" rx="2" fill="white" fill-opacity="0.22"/>
    <rect x="11.5" y="10.5" width="9" height="4" rx="1.5" fill="white" fill-opacity="0.5"/>
    <ellipse cx="12" cy="8" rx="2" ry="1.2" fill="white" fill-opacity="0.9"/>
    <ellipse cx="20" cy="8" rx="2" ry="1.2" fill="white" fill-opacity="0.9"/>
    <ellipse cx="12" cy="24" rx="1.8" ry="1" fill="#ef4444" fill-opacity="0.9"/>
    <ellipse cx="20" cy="24" rx="1.8" ry="1" fill="#ef4444" fill-opacity="0.9"/>
    <rect x="6" y="10" width="4" height="5" rx="2" fill="#1e293b"/>
    <rect x="22" y="10" width="4" height="5" rx="2" fill="#1e293b"/>
    <rect x="6" y="17" width="4" height="5" rx="2" fill="#1e293b"/>
    <rect x="22" y="17" width="4" height="5" rx="2" fill="#1e293b"/>
  </svg>`;

const makeCarIcon = (speed = 0, heading = 0, isEgo = false) => {
  const c    = isEgo ? "#22c55e" : speedColor(speed);
  const size = isEgo ? 28 : 18;
  const rot  = (heading - 90 + 360) % 360;
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;transform:rotate(${rot}deg);transform-origin:center">${carSVG(c, size)}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  });
};

const makeAccidentIcon = (index) => L.divIcon({
  className: "",
  html: `<div style="width:30px;height:30px;background:#7f1d1d;border:2px solid #fca5a5;border-radius:8px;
                display:flex;align-items:center;justify-content:center;
                color:#fca5a5;font-weight:900;font-size:12px;font-family:monospace;
                box-shadow:0 2px 10px #dc262688">${index + 1}</div>`,
  iconSize: [30, 30], iconAnchor: [15, 15],
});

/* ─── Map helpers ────────────────────────────────────────────── */
const RecenterMap = ({ coords }) => {
  const map = useMap();
  useEffect(() => {
    if (coords?.lat && coords?.lng)
      map.setView([coords.lat, coords.lng], 14, { animate: true });
  }, [coords, map]);
  return null;
};

const CaptureHandler = ({ mode, onZone }) => {
  const map     = useMap();
  const startRef = useRef(null);
  const drawing  = useRef(false);

  useEffect(() => {
    const container = map.getContainer();
    const toLL = (e) => {
      const r = container.getBoundingClientRect();
      return map.containerPointToLatLng(L.point(e.clientX - r.left, e.clientY - r.top));
    };
    const down = (e) => {
      if (mode !== "capture") return;
      e.preventDefault(); e.stopPropagation();
      map.dragging.disable();
      startRef.current = toLL(e);
      drawing.current  = true;
    };
    const move = (e) => {
      if (!drawing.current || mode !== "capture") return;
      e.preventDefault();
      onZone({ start: startRef.current, end: toLL(e), final: false });
    };
    const up = (e) => {
      if (!drawing.current || mode !== "capture") return;
      e.preventDefault();
      onZone({ start: startRef.current, end: toLL(e), final: true });
      drawing.current = false; startRef.current = null;
      map.dragging.enable();
    };
    container.addEventListener("mousedown", down, { capture: true });
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      container.removeEventListener("mousedown", down, { capture: true });
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      map.dragging.enable();
    };
  }, [mode, map, onZone]);
  return null;
};

const AccidentHandler = ({ mode, onPlace }) => {
  useMapEvents({ click(e) { if (mode === "accident") onPlace(e.latlng); } });
  return null;
};

/* ─── Number stepper ─────────────────────────────────────────── */
const Stepper = ({ label, value, onChange, min = 0, max = 500, step = 5, color = "#3b82f6" }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
    <span style={{ fontSize: 11, color: "#94a3b8", flex: 1 }}>{label}</span>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button onClick={() => onChange(Math.max(min, value - step))} style={{
        width: 28, height: 28, borderRadius: 7, border: "none",
        background: color + "33", color, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}><Minus size={11} /></button>
      <span style={{ width: 40, textAlign: "center", fontSize: 13, fontWeight: 900, color: "white", fontVariantNumeric: "tabular-nums" }}>{value}</span>
      <button onClick={() => onChange(Math.min(max, value + step))} style={{
        width: 28, height: 28, borderRadius: 7, border: "none",
        background: color, color: "white", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}><Plus size={11} /></button>
    </div>
  </div>
);

/* ─── Step header ────────────────────────────────────────────── */
const StepHeader = ({ n, label, done }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
    <div style={{
      width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
      background: done ? "#15803d" : "#1e3a5f",
      border: `1px solid ${done ? "#22c55e" : "#2d5a8e"}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 9, fontWeight: 900, color: done ? "#4ade80" : "#60a5fa",
    }}>{done ? "✓" : n}</div>
    <span style={{ fontSize: 10, fontWeight: 800, color: "#e2e8f0", textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</span>
  </div>
);

/* ─── Divider ────────────────────────────────────────────────── */
const Divider = () => <div style={{ height: 1, background: "#1e3a5f", margin: "4px 0" }} />;

/* ─── Progress log item ──────────────────────────────────────── */
const LogLine = ({ text, status }) => {
  const color = status === "ok" ? "#4ade80" : status === "err" ? "#f87171" : "#60a5fa";
  const sym   = status === "ok" ? "✓" : status === "err" ? "✗" : "·";
  return (
    <div style={{ display: "flex", gap: 6, fontSize: 10, color, lineHeight: 1.5, fontFamily: "monospace" }}>
      <span style={{ flexShrink: 0 }}>{sym}</span>
      <span>{text}</span>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   MAIN
═══════════════════════════════════════════════════════════════ */
const MapGlobal = () => {
  /* Live simulation */
  const [vehicles,     setVehicles]     = useState({});
  const [socketStatus, setSocketStatus] = useState("disconnected");
  const [userPosition, setUserPosition] = useState(null);
  const [liveAlerts,   setLiveAlerts]   = useState([]);

  /* Editor */
  const [panelOpen,       setPanelOpen]       = useState(false);
  const [editorMode,      setEditorMode]      = useState("view");
  const [captureZone,     setCaptureZone]     = useState(null);
  const [scenarioName,    setScenarioName]    = useState("");
  const [vehicleCount,    setVehicleCount]    = useState(50);
  const [pedestrianCount, setPedestrianCount] = useState(20);
  const [simDuration,     setSimDuration]     = useState(3600);
  const [accidents,       setAccidents]       = useState([]);

  /* Generation state */
  const [genPhase,   setGenPhase]   = useState("idle"); // idle | loading | success | error
  const [genLog,     setGenLog]     = useState([]);     // [{text, status}]
  const [genResult,  setGenResult]  = useState(null);
  const [fixPhase,   setFixPhase]   = useState("idle");

  const mountedRef   = useRef(false);
  const watchRef     = useRef(null);
  const alertTimeout = useRef(null);

  /* ── Socket ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    socketService.connect();

    const onAll  = (d) => { if (d?.vehicles) setVehicles(d.vehicles); };
    const onVeh  = (d) => {
      if (!d?.id || d.lat == null) return;
      setVehicles(p => ({ ...p, [d.id]: { lat: d.lat, lng: d.lng, speed: d.speed || 0, heading: d.heading || 0 } }));
    };
    const onAlert = (d) => {
      const msg = `${d.title || "Alerte"} — ${d.vehicle_id || "inconnu"}`;
      setLiveAlerts(p => [{ id: Date.now(), msg }, ...p].slice(0, 5));
      clearTimeout(alertTimeout.current);
      alertTimeout.current = setTimeout(() => setLiveAlerts([]), 8000);
    };
    const onSim = (d) => { if (d?.status === "stopped") setVehicles({}); };

    socketService.on("connect",            () => setSocketStatus("connected"));
    socketService.on("disconnect",         () => setSocketStatus("disconnected"));
    socketService.on("connect_error",      () => setSocketStatus("error"));
    socketService.on("all_vehicles_state", onAll);
    socketService.on("vehicle_state",      onVeh);
    socketService.on("emergency_alert",    onAlert);
    socketService.on("simulation_status",  onSim);

    return () => {
      ["connect","disconnect","connect_error","all_vehicles_state","vehicle_state","emergency_alert","simulation_status"]
        .forEach(ev => socketService.off(ev));
      clearTimeout(alertTimeout.current);
      mountedRef.current = false;
    };
  }, []);

  /* ── GPS ─────────────────────────────────────────────────────── */
  const startGPS = useCallback(() => {
    if (!navigator.geolocation) return;
    if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current);
    watchRef.current = navigator.geolocation.watchPosition(
      p => setUserPosition({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {}, { enableHighAccuracy: true, maximumAge: 5000 }
    );
  }, []);

  useEffect(() => {
    startGPS();
    return () => { if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current); };
  }, [startGPS]);

  /* ── Handlers ────────────────────────────────────────────────── */
  const handleZone    = useCallback(z => { setCaptureZone(z); if (z.final) setEditorMode("view"); }, []);
  const placeAccident = useCallback(ll => setAccidents(p => [...p, { lat: ll.lat, lng: ll.lng, id: Date.now() }]), []);
  const removeAcc     = useCallback(id => setAccidents(p => p.filter(a => a.id !== id)), []);

  /* ── Generate ────────────────────────────────────────────────── */
  const generate = async () => {
    if (!captureZone?.final) {
      setGenLog([{ text: "Dessinez d'abord une zone sur la carte", status: "err" }]);
      setGenPhase("error");
      return;
    }
    setGenPhase("loading");
    setGenResult(null);
    setFixPhase("idle");

    const steps = [
      "Téléchargement OSM via Overpass…",
      "Conversion réseau (netconvert)…",
      "Génération des routes (randomTrips)…",
      "Injection des accidents…",
      "Écriture du fichier .sumocfg…",
      "Sauvegarde du scénario…",
    ];

    // Simuler le log progressif (le backend génère en ~20-40s)
    let i = 0;
    const interval = setInterval(() => {
      if (i < steps.length - 1) {
        setGenLog(p => [...p, { text: steps[i], status: "loading" }]);
        i++;
      }
    }, 3000);

    const { start, end } = captureZone;
    try {
      const res  = await fetch(`${API}/scenario/generate`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario_name:    scenarioName.trim(),
          bbox: {
            min_lat: Math.min(start.lat, end.lat), max_lat: Math.max(start.lat, end.lat),
            min_lng: Math.min(start.lng, end.lng), max_lng: Math.max(start.lng, end.lng),
          },
          vehicle_count:    vehicleCount,
          pedestrian_count: pedestrianCount,
          accidents:        accidents.map(({ lat, lng }) => ({ lat, lng })),
          sim_duration:     simDuration,
        }),
      });
      clearInterval(interval);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Erreur serveur");
      setGenPhase("success");
      setGenResult(data);
      setGenLog([
        { text: "Réseau OSM téléchargé et converti", status: "ok" },
        { text: `Routes générées — ${vehicleCount} véhicules`, status: "ok" },
        accidents.length > 0 ? { text: `${accidents.length} accident(s) injecté(s)`, status: "ok" } : null,
        { text: `Scénario sauvegardé : ${data.scenario_id || ""}`, status: "ok" },
      ].filter(Boolean));
    } catch (e) {
      clearInterval(interval);
      setGenPhase("error");
      setGenLog(p => [...p, { text: e.message, status: "err" }]);
    }
  };

  const fixRoutes = async () => {
    setFixPhase("loading");
    try {
      const res  = await fetch(`${API}/scenario/fix-routes`, { method: "POST" });
      const data = await res.json();
      setFixPhase("done");
      setGenLog(p => [...p, { text: data.message || "Routes validées", status: "ok" }]);
    } catch (e) {
      setFixPhase("idle");
      setGenLog(p => [...p, { text: e.message, status: "err" }]);
    }
  };

  const reset = () => {
    setGenPhase("idle"); setGenLog([]); setGenResult(null);
    setCaptureZone(null); setAccidents([]); setFixPhase("idle");
    setScenarioName(""); setEditorMode("view");
  };

  /* ── Derived ─────────────────────────────────────────────────── */
  const vCount  = Object.keys(vehicles).length;
  const scColor = socketStatus === "connected" ? "#22c55e" : socketStatus === "error" ? "#ef4444" : "#64748b";
  const captureRect = captureZone
    ? [[captureZone.start.lat, captureZone.start.lng], [captureZone.end.lat, captureZone.end.lng]]
    : null;

  const canGenerate = captureZone?.final && genPhase !== "loading";

  /* ════════════════════════════════════════════════════════════
     RENDER
  ════════════════════════════════════════════════════════════ */
  return (
    <div style={{
      height: "100%", width: "100%", position: "relative",
      background: "#08111e", overflow: "hidden",
      cursor: editorMode === "capture" ? "crosshair" : editorMode === "accident" ? "copy" : "default",
    }}>

      {/* ══ NAVBAR ══ */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, zIndex: 1000,
        height: 52, background: "#08111eee", backdropFilter: "blur(12px)",
        borderBottom: "1px solid #1e3a5f",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 16px", gap: 12,
      }}>
        {/* Gauche */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: "#e2e8f0", letterSpacing: "-0.4px" }}>
            TMT Traffic — Vue Globale
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 5, background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 20, padding: "3px 10px" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: scColor }} />
            <span style={{ fontSize: 10, color: scColor, fontWeight: 600 }}>
              {socketStatus === "connected" ? "Connecté" : socketStatus === "error" ? "Erreur" : "Déconnecté"}
            </span>
          </div>
          {vCount > 0 && (
            <div style={{ fontSize: 10, color: "#60a5fa", background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 20, padding: "3px 10px", fontFamily: "monospace" }}>
              {vCount} véhicules en direct
            </div>
          )}
        </div>

        {/* Droite */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={startGPS} title="Centrer sur ma position" style={{
            width: 34, height: 34, borderRadius: 8, border: "1px solid #1e3a5f",
            background: "#0f172a", color: "#60a5fa", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}><LocateFixed size={14} /></button>

          <button onClick={() => setPanelOpen(v => !v)} style={{
            display: "flex", alignItems: "center", gap: 6,
            background: panelOpen ? "#1e40af" : "#0f172a",
            border: `1px solid ${panelOpen ? "#3b82f6" : "#1e3a5f"}`,
            borderRadius: 8, padding: "7px 14px",
            fontSize: 11, fontWeight: 700,
            color: panelOpen ? "white" : "#a78bfa",
            cursor: "pointer",
          }}>
            <Layers size={13} />
            {panelOpen ? "Fermer l'éditeur" : "Éditeur de scénario"}
          </button>
        </div>
      </div>

      {/* ══ MAP ══ */}
      <MapContainer center={[CENTER.lat, CENTER.lng]} zoom={13} scrollWheelZoom
        style={{ height: "100%", width: "100%" }}>
        <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {userPosition && <RecenterMap coords={userPosition} />}
        <CaptureHandler mode={editorMode} onZone={handleZone} />
        <AccidentHandler mode={editorMode} onPlace={placeAccident} />

        {captureRect && (
          <Rectangle bounds={captureRect} pathOptions={{
            color: captureZone.final ? "#3b82f6" : "#93c5fd",
            weight: 2, fillOpacity: 0.06,
            dashArray: captureZone.final ? undefined : "8 5",
          }} />
        )}

        {accidents.map((acc, i) => (
          <Marker key={acc.id} position={[acc.lat, acc.lng]} icon={makeAccidentIcon(i)}>
            <Popup>
              <div style={{ fontFamily: "sans-serif", fontSize: 12, minWidth: 140 }}>
                <div style={{ fontWeight: 700, color: "#dc2626", marginBottom: 6 }}>Accident #{i + 1}</div>
                <div style={{ fontSize: 10, color: "#6b7280", fontFamily: "monospace" }}>
                  {acc.lat.toFixed(5)}, {acc.lng.toFixed(5)}
                </div>
                <button onClick={() => removeAcc(acc.id)} style={{
                  marginTop: 8, width: "100%", padding: "5px 0", borderRadius: 6,
                  background: "#7f1d1d", border: "none", color: "#fca5a5",
                  fontSize: 10, fontWeight: 700, cursor: "pointer",
                }}>Supprimer</button>
              </div>
            </Popup>
          </Marker>
        ))}

        {Object.entries(vehicles).map(([vid, v]) => (
          <Marker key={vid} position={[v.lat, v.lng]} icon={makeCarIcon(v.speed, v.heading, vid === "ego")}>
            <Popup>
              <div style={{ fontFamily: "monospace", fontSize: 12, minWidth: 110 }}>
                <div style={{ fontWeight: 700, color: vid === "ego" ? "#22c55e" : speedColor(v.speed), marginBottom: 4 }}>{vid}</div>
                <div style={{ fontWeight: 700, color: speedColor(v.speed) }}>{Math.round(v.speed)} km/h</div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      {/* ══ EDITOR PANEL (sidebar droite) ══ */}
      <div style={{
        position: "absolute", top: 0, right: 0, bottom: 0, zIndex: 1100,
        width: panelOpen ? 340 : 0, overflow: "hidden",
        transition: "width 0.3s cubic-bezier(0.4,0,0.2,1)",
        pointerEvents: panelOpen ? "auto" : "none",
      }}>
        <div style={{
          width: 340, height: "100%",
          background: "#08111e", borderLeft: "1px solid #1e3a5f",
          display: "flex", flexDirection: "column",
        }}>
          {/* Panel header */}
          <div style={{
            padding: "64px 20px 16px",
            borderBottom: "1px solid #1e3a5f", flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10,
                background: "#1e3a5f", border: "1px solid #2d5a8e",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Layers size={16} color="#60a5fa" />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#e2e8f0" }}>Nouveau scénario</div>
                <div style={{ fontSize: 10, color: "#475569", marginTop: 1 }}>Génération réseau SUMO depuis OSM</div>
              </div>
            </div>
          </div>

          {/* Scrollable content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 0" }}>

            {/* ── 0. NOM ───────────────────────────────────────── */}
            <StepHeader n="0" label="Nom du scénario" done={scenarioName.trim().length > 0} />
            <div style={{ position: "relative", marginBottom: 20 }}>
              <Tag size={11} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "#334155", pointerEvents: "none" }} />
              <input
                type="text" value={scenarioName}
                onChange={e => setScenarioName(e.target.value)}
                placeholder="ex: Casa-Centre-50veh (optionnel)"
                maxLength={40}
                style={{
                  width: "100%", boxSizing: "border-box",
                  background: "#0f172a", border: "1px solid #1e3a5f",
                  borderRadius: 9, padding: "9px 12px 9px 28px",
                  fontSize: 11, color: "white", fontFamily: "monospace",
                  outline: "none",
                }}
              />
            </div>

            <Divider />

            {/* ── 1. ZONE ──────────────────────────────────────── */}
            <div style={{ marginTop: 16 }}>
              <StepHeader n="1" label="Zone de simulation" done={!!captureZone?.final} />
              <button onClick={() => setEditorMode(m => m === "capture" ? "view" : "capture")} style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", borderRadius: 10,
                background: editorMode === "capture" ? "#1e3a5f" : "#0f172a",
                border: `1px solid ${editorMode === "capture" ? "#3b82f6" : "#1e3a5f"}`,
                color: editorMode === "capture" ? "#93c5fd" : "#475569",
                fontSize: 11, fontWeight: 700, cursor: "pointer",
                transition: "all 0.15s",
              }}>
                <Crosshair size={13} />
                {editorMode === "capture" ? "Dessinez le rectangle sur la carte…" : "Dessiner la zone de capture"}
                {editorMode !== "capture" && <ChevronRight size={12} style={{ marginLeft: "auto" }} />}
              </button>

              {captureZone?.final && (
                <div style={{
                  marginTop: 8, background: "#0c1f3a", border: "1px solid #1e3a5f",
                  borderRadius: 9, padding: "10px 12px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 9, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em" }}>Zone sélectionnée</span>
                    <button onClick={() => { setCaptureZone(null); setEditorMode("view"); }} style={{
                      background: "none", border: "none", color: "#334155", cursor: "pointer", padding: 0,
                    }}><X size={12} /></button>
                  </div>
                  {[
                    ["NW", captureZone.start],
                    ["SE", captureZone.end],
                  ].map(([lbl, pt]) => (
                    <div key={lbl} style={{ display: "flex", gap: 6, fontSize: 10, fontFamily: "monospace", color: "#64748b", marginBottom: 2 }}>
                      <span style={{ color: "#334155", width: 18 }}>{lbl}</span>
                      <span>{pt.lat.toFixed(5)}</span>
                      <span>{pt.lng.toFixed(5)}</span>
                    </div>
                  ))}
                  {/* Taille de la zone */}
                  {(() => {
                    const dlat = Math.abs(captureZone.end.lat - captureZone.start.lat);
                    const dlng = Math.abs(captureZone.end.lng - captureZone.start.lng);
                    const km2  = (dlat * 111) * (dlng * 111 * Math.cos(captureZone.start.lat * Math.PI / 180));
                    return (
                      <div style={{ marginTop: 6, fontSize: 10, color: "#3b82f6", fontWeight: 700 }}>
                        {km2.toFixed(2)} km²
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            <div style={{ height: 1, background: "#1e3a5f", margin: "16px 0" }} />

            {/* ── 2. PARAMÈTRES ────────────────────────────────── */}
            <StepHeader n="2" label="Paramètres" done={false} />
            <div style={{
              background: "#0f172a", border: "1px solid #1e3a5f",
              borderRadius: 10, padding: "14px", marginBottom: 16,
              display: "flex", flexDirection: "column", gap: 14,
            }}>
              <Stepper label="Véhicules"  value={vehicleCount}    onChange={setVehicleCount}    min={5}  max={500} step={5}  color="#3b82f6" />
              <Stepper label="Piétons"    value={pedestrianCount} onChange={setPedestrianCount} min={0}  max={200} step={5}  color="#22c55e" />
              <Stepper label="Durée (s)"  value={simDuration}     onChange={setSimDuration}     min={600} max={14400} step={600} color="#a78bfa" />
            </div>

            <Divider />

            {/* ── 3. ACCIDENTS ─────────────────────────────────── */}
            <div style={{ marginTop: 16 }}>
              <StepHeader n="3" label={`Accidents${accidents.length > 0 ? ` (${accidents.length})` : ""}`} done={false} />
              <button onClick={() => setEditorMode(m => m === "accident" ? "view" : "accident")} style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "10px 14px", borderRadius: 10,
                background: editorMode === "accident" ? "#450a0a" : "#0f172a",
                border: `1px solid ${editorMode === "accident" ? "#dc2626" : "#1e3a5f"}`,
                color: editorMode === "accident" ? "#fca5a5" : "#475569",
                fontSize: 11, fontWeight: 700, cursor: "pointer",
                transition: "all 0.15s",
              }}>
                <MapPin size={13} />
                {editorMode === "accident" ? "Cliquez sur la carte pour placer…" : "Placer un accident sur la carte"}
                {editorMode !== "accident" && <ChevronRight size={12} style={{ marginLeft: "auto" }} />}
              </button>

              {accidents.length > 0 && (
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" }}>
                  {accidents.map((acc, i) => (
                    <div key={acc.id} style={{
                      background: "#0f172a", border: "1px solid #1e3a5f",
                      borderRadius: 8, padding: "7px 10px",
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{
                          width: 20, height: 20, borderRadius: 5, background: "#7f1d1d",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 9, fontWeight: 900, color: "#fca5a5",
                        }}>{i + 1}</div>
                        <span style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace" }}>
                          {acc.lat.toFixed(4)}, {acc.lng.toFixed(4)}
                        </span>
                      </div>
                      <button onClick={() => removeAcc(acc.id)} style={{
                        background: "none", border: "none", color: "#334155", cursor: "pointer", padding: 2,
                      }}><X size={12} /></button>
                    </div>
                  ))}
                  {accidents.length > 1 && (
                    <button onClick={() => setAccidents([])} style={{
                      background: "none", border: "none", color: "#334155",
                      fontSize: 9, cursor: "pointer", textAlign: "left", padding: "4px 0",
                      display: "flex", alignItems: "center", gap: 4,
                    }}>
                      <Trash2 size={9} /> Tout supprimer
                    </button>
                  )}
                </div>
              )}
            </div>

            <div style={{ height: 1, background: "#1e3a5f", margin: "16px 0" }} />

            {/* ── RÉCAPITULATIF ─────────────────────────────────── */}
            <div style={{
              background: "#0f172a", border: "1px solid #1e3a5f",
              borderRadius: 10, padding: "14px", marginBottom: 16,
            }}>
              <div style={{ fontSize: 9, color: "#334155", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
                Récapitulatif
              </div>
              {[
                { label: "Zone",       val: captureZone?.final ? "Définie" : "Non définie",           ok: !!captureZone?.final },
                { label: "Véhicules",  val: vehicleCount,                                             ok: vehicleCount > 0    },
                { label: "Piétons",    val: pedestrianCount,                                          ok: true                },
                { label: "Durée",      val: `${simDuration}s (${(simDuration/3600).toFixed(1)}h)`,   ok: true                },
                { label: "Accidents",  val: accidents.length > 0 ? `${accidents.length} placé(s)` : "Aucun", ok: true       },
                { label: "Nom",        val: scenarioName.trim() || "(auto-généré)",                   ok: true                },
              ].map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, color: "#475569" }}>{r.label}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: r.ok ? "#60a5fa" : "#f87171" }}>{r.val}</span>
                </div>
              ))}
            </div>

            {/* ── LOG GÉNÉRATION ────────────────────────────────── */}
            {genLog.length > 0 && (
              <div style={{
                background: "#020c1a", border: "1px solid #1e3a5f",
                borderRadius: 10, padding: "12px 14px", marginBottom: 16,
                display: "flex", flexDirection: "column", gap: 5,
              }}>
                <div style={{ fontSize: 9, color: "#334155", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Journal</div>
                {genLog.map((l, i) => (
                  <LogLine key={i} text={l.text} status={genPhase === "loading" && i === genLog.length - 1 ? "loading" : l.status} />
                ))}
                {genPhase === "loading" && (
                  <div style={{ display: "flex", gap: 6, fontSize: 10, color: "#3b82f6", fontFamily: "monospace", alignItems: "center" }}>
                    <RefreshCw size={10} style={{ animation: "spin 1s linear infinite" }} />
                    <span>Génération en cours…</span>
                  </div>
                )}
              </div>
            )}

            {/* ── RÉSULTAT SUCCÈS ────────────────────────────────── */}
            {genPhase === "success" && genResult && (
              <div style={{
                background: "#052e16", border: "1px solid #166534",
                borderRadius: 10, padding: "12px 14px", marginBottom: 16,
              }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: "#4ade80", marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
                  <CheckCircle size={13} /> Scénario généré
                </div>
                <div style={{ fontSize: 10, color: "#16a34a", fontFamily: "monospace" }}>
                  {genResult.scenario_id}
                </div>
                {genResult.message && (
                  <div style={{ fontSize: 10, color: "#15803d", marginTop: 4 }}>{genResult.message}</div>
                )}
                <div style={{ marginTop: 8, fontSize: 10, color: "#166534" }}>
                  Utilisez le scénario depuis MapSolo (bouton Scénario)
                </div>
              </div>
            )}

            <div style={{ height: 80 }} />
          </div>

          {/* ── FOOTER ACTIONS ─────────────────────────────────── */}
          <div style={{
            padding: "12px 20px 20px",
            borderTop: "1px solid #1e3a5f",
            flexShrink: 0, display: "flex", flexDirection: "column", gap: 8,
          }}>

            {/* Bouton principal */}
            {genPhase !== "success" ? (
              <button onClick={generate} disabled={!canGenerate} style={{
                width: "100%", padding: "12px 0",
                borderRadius: 10, border: "none",
                background: !canGenerate ? "#1e293b" : genPhase === "loading" ? "#1e3a5f" : "#1e40af",
                color: !canGenerate ? "#334155" : "white",
                fontSize: 12, fontWeight: 800, cursor: canGenerate ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                boxShadow: canGenerate && genPhase !== "loading" ? "0 2px 12px #1e40af55" : "none",
                transition: "all 0.15s",
              }}>
                {genPhase === "loading"
                  ? <><RefreshCw size={14} style={{ animation: "spin 1s linear infinite" }} /> Génération en cours…</>
                  : <><Send size={13} /> Générer et sauvegarder</>
                }
              </button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button onClick={fixRoutes} disabled={fixPhase === "loading" || fixPhase === "done"} style={{
                  width: "100%", padding: "10px 0", borderRadius: 10, border: "none",
                  background: fixPhase === "done" ? "#052e16" : fixPhase === "loading" ? "#1e293b" : "#1c1400",
                  color: fixPhase === "done" ? "#4ade80" : fixPhase === "loading" ? "#334155" : "#d97706",
                  fontSize: 11, fontWeight: 700, cursor: fixPhase === "idle" ? "pointer" : "not-allowed",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                  border: `1px solid ${fixPhase === "done" ? "#166534" : "#3d2e00"}`,
                }}>
                  {fixPhase === "done" ? <><CheckCircle size={12} /> Routes validées</>
                   : fixPhase === "loading" ? <><RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} /> Validation…</>
                   : "Valider les routes (optionnel)"}
                </button>
                <button onClick={reset} style={{
                  width: "100%", padding: "8px 0", borderRadius: 10,
                  background: "none", border: "1px solid #1e3a5f",
                  color: "#475569", fontSize: 11, cursor: "pointer",
                }}>Nouveau scénario</button>
              </div>
            )}

            {/* Erreur */}
            {genPhase === "error" && (
              <button onClick={reset} style={{
                width: "100%", padding: "8px 0", borderRadius: 10,
                background: "none", border: "1px solid #7f1d1d",
                color: "#f87171", fontSize: 11, cursor: "pointer",
              }}>Recommencer</button>
            )}
          </div>
        </div>
      </div>

      {/* ══ HINT MODE ══ */}
      {(editorMode === "capture" || editorMode === "accident") && (
        <div style={{
          position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)",
          zIndex: 1200, background: editorMode === "capture" ? "#1e40af" : "#7f1d1d",
          color: "white", padding: "8px 20px", borderRadius: 99,
          fontSize: 11, fontWeight: 700, pointerEvents: "none",
          boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        }}>
          {editorMode === "capture" ? "Clic + glisser pour définir la zone" : "Cliquez sur la carte pour placer un accident"}
        </div>
      )}

      {/* ══ LIVE ALERTS ══ */}
      {liveAlerts.length > 0 && (
        <div style={{
          position: "absolute", bottom: 20, left: 16, zIndex: 1000,
          display: "flex", flexDirection: "column", gap: 6, maxWidth: 320,
          pointerEvents: "none",
        }}>
          {liveAlerts.map(a => (
            <div key={a.id} style={{
              background: "#450a0a", border: "1px solid #7f1d1d",
              borderRadius: 10, padding: "10px 14px",
              display: "flex", alignItems: "center", gap: 8,
              backdropFilter: "blur(8px)",
            }}>
              <AlertTriangle size={13} color="#f87171" style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 10, color: "#fca5a5", fontFamily: "monospace" }}>{a.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MapGlobal;