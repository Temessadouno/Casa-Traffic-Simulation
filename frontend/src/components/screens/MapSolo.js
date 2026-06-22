// frontend/src/components/screens/MapSolo.jsx — VERSION COMPLÈTE FINALE
// Changements :
//  1. Piétons visibles sur la carte (Markers cyan dans MapContainer)
//  2. Accidents visibles sur la carte
//  3. Bouton Pause / Reprendre
//  4. Prédictions cliquables → route bleue sur la carte
//  5. État simulation partagé via simulationStore
//  6. Bouton Démarrer/Arrêter cohérent même après navigation entre pages

import React, { useState, useEffect, useRef, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import {
  Play, Square, Pause, Settings, X,
  ChevronUp, ChevronDown, Trash2,
  RefreshCw, Eye, List,
} from "lucide-react";
import "leaflet/dist/leaflet.css";
import apiService    from "../../services/api";
import socketService from "../../services/socket";
import simulationStore from "../../services/simulationStore";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

/* ─── Leaflet icon fix ─────────────────────────────────────────── */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:       "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:     "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

const API_BASE    = process.env.REACT_APP_API_URL || "http://localhost:8000";

const MAX_HISTORY = 60;

/* ─── Hook interpolation véhicules ────────────────────────────────
   Anime les positions entre deux broadcasts (100ms) à 60fps.
   Chaque véhicule glisse fluidement d'une position à la suivante.
────────────────────────────────────────────────────────────────── */
const lerp = (a, b, t) => a + (b - a) * t;

const useVehicleInterpolation = (rawVehicles) => {
  const [smoothVehicles, setSmoothVehicles] = useState({});
  const prevRef    = useRef({});   // positions précédentes
  const targetRef  = useRef({});   // positions cibles (dernier broadcast)
  const startRef   = useRef({});   // timestamp début interpolation
  const rafRef     = useRef(null);
  const DURATION   = 90;           // ms — légèrement < 100ms broadcast

  // Quand un nouveau broadcast arrive, on mémorise les cibles
  useEffect(() => {
    const now = performance.now();
    Object.entries(rawVehicles).forEach(([id, v]) => {
      // Partir de la position lissée actuelle si elle existe
      prevRef.current[id]   = smoothVehicles[id] || v;
      targetRef.current[id] = v;
      startRef.current[id]  = now;
    });
    // Nettoyer les véhicules disparus
    Object.keys(prevRef.current).forEach(id => {
      if (!rawVehicles[id]) {
        delete prevRef.current[id];
        delete targetRef.current[id];
        delete startRef.current[id];
      }
    });
  }, [rawVehicles]);

  // Boucle RAF pour interpoler
  useEffect(() => {
    const animate = () => {
      const now = performance.now();
      const next = {};
      Object.keys(targetRef.current).forEach(id => {
        const prev   = prevRef.current[id];
        const target = targetRef.current[id];
        const start  = startRef.current[id] || now;
        const t      = Math.min(1, (now - start) / DURATION);
        const ease   = t < 0.5 ? 2*t*t : -1+(4-2*t)*t; // easeInOut

        if (!prev || !target) { next[id] = target; return; }

        // Interpolation angulaire du heading (évite le saut 359°→0°)
        let dh = (target.heading - (prev.heading || 0) + 540) % 360 - 180;

        next[id] = {
          ...target,
          lat:     lerp(prev.lat || target.lat, target.lat, ease),
          lng:     lerp(prev.lng || target.lng, target.lng, ease),
          heading: ((prev.heading || 0) + dh * ease + 360) % 360,
          speed:   lerp(prev.speed || 0, target.speed || 0, ease),
        };
      });
      setSmoothVehicles(next);
      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return smoothVehicles;
};

/* ─── CSS animations ───────────────────────────────────────────── */
const CSS_ANIMATIONS = `
  @keyframes ping {
    0%   { transform: scale(1);   opacity: 0.7; }
    70%  { transform: scale(1.6); opacity: 0;   }
    100% { transform: scale(1.6); opacity: 0;   }
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  @keyframes pulse-route {
    0%   { stroke-opacity: 1; }
    50%  { stroke-opacity: 0.4; }
    100% { stroke-opacity: 1; }
  }
`;
function InjectStyles() {
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = CSS_ANIMATIONS;
    document.head.appendChild(el);
    return () => document.head.removeChild(el);
  }, []);
  return null;
}

/* ─── Palette vitesse ──────────────────────────────────────────── */
const SPEED_BANDS = [
  { max: 0,        color: "#64748b", label: "Arrêt"     },
  { max: 10,       color: "#ef4444", label: "< 10 km/h" },
  { max: 30,       color: "#f97316", label: "10–30"     },
  { max: 50,       color: "#eab308", label: "30–50"     },
  { max: 80,       color: "#22c55e", label: "50–80"     },
  { max: Infinity, color: "#3b82f6", label: "> 80 km/h" },
];
const speedColor = (s = 0) => {
  for (const b of SPEED_BANDS) if (s <= b.max) return b.color;
  return "#3b82f6";
};

/* ─── Accident meta ────────────────────────────────────────────── */
const ACCIDENT_META = {
  collision: { label: "Collision",             bg: "#dc2626", ring: "#fca5a5", glow: "#ef444455", sym: "💥" },
  panne:     { label: "Panne / arrêt brusque", bg: "#ea580c", ring: "#fdba74", glow: "#f9731655", sym: "🔧" },
  feu_rouge: { label: "Feu grillé",            bg: "#ca8a04", ring: "#fde047", glow: "#eab30855", sym: "🚦" },
  obstacle:  { label: "Obstacle",              bg: "#9333ea", ring: "#d8b4fe", glow: "#a855f755", sym: "🚧" },
  pietons:   { label: "Piétons",               bg: "#2563eb", ring: "#93c5fd", glow: "#3b82f655", sym: "🚶" },
  inconnu:   { label: "Cause inconnue",        bg: "#4b5563", ring: "#d1d5db", glow: "#6b728055", sym: "⚠️" },
};

/* ─── Icônes ───────────────────────────────────────────────────── */
const CAR_SVG = (color, size) => `
  <svg width="${size}" height="${size}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
    <rect x="9" y="6"  width="14" height="20" rx="4" fill="${color}"/>
    <rect x="11" y="10" width="10" height="8"  rx="2" fill="white" fill-opacity="0.22"/>
    <rect x="11.5" y="10.5" width="9" height="4" rx="1.5" fill="white" fill-opacity="0.55"/>
    <ellipse cx="12" cy="8"  rx="2" ry="1.2" fill="white" fill-opacity="0.9"/>
    <ellipse cx="20" cy="8"  rx="2" ry="1.2" fill="white" fill-opacity="0.9"/>
    <ellipse cx="12" cy="24" rx="1.8" ry="1" fill="#ef4444" fill-opacity="0.9"/>
    <ellipse cx="20" cy="24" rx="1.8" ry="1" fill="#ef4444" fill-opacity="0.9"/>
    <rect x="6"  y="10" width="4" height="5" rx="2" fill="#1e293b"/>
    <rect x="22" y="10" width="4" height="5" rx="2" fill="#1e293b"/>
    <rect x="6"  y="17" width="4" height="5" rx="2" fill="#1e293b"/>
    <rect x="22" y="17" width="4" height="5" rx="2" fill="#1e293b"/>
  </svg>`;

const createTrackedIcon = (speed = 0, heading = 0) => {
  const c   = speedColor(speed);
  const rot = (heading - 90 + 360) % 360;
  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:48px;height:48px">
      <div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${c};opacity:0.4;animation:ping 1.5s infinite"></div>
      <div style="position:absolute;inset:4px;transform:rotate(${rot}deg);transform-origin:center">${CAR_SVG(c, 40)}</div>
      <div style="position:absolute;top:0;right:0;width:12px;height:12px;background:#22c55e;border-radius:50%;border:2px solid #0f172a"></div>
    </div>`,
    iconSize: [48, 48], iconAnchor: [24, 24], popupAnchor: [0, -22],
  });
};

const createVehicleIcon = (speed = 0, heading = 0) => {
  const c   = speedColor(speed);
  const rot = (heading - 90 + 360) % 360;
  return L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;transform:rotate(${rot}deg);transform-origin:center">${CAR_SVG(c, 22)}</div>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
};

/* Piéton — point cyan visible */
const createPedestrianIcon = (pid = "") => L.divIcon({
  className: "",
  html: `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
    <div style="width:10px;height:10px;border-radius:50%;background:#111827;border:2px solid #374151;box-shadow:0 0 4px rgba(0,0,0,0.8)"></div>
    <div style="background:#111827;color:#f1f5f9;font-size:8px;font-weight:700;font-family:monospace;padding:1px 4px;border-radius:3px;white-space:nowrap;border:1px solid #374151;opacity:0.92">${pid.slice(-4)}</div>
  </div>`,
  iconSize: [36, 26], iconAnchor: [18, 10],
});

const COLLISION_SVG = () => `
<svg width="64" height="42" viewBox="0 0 64 42" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(1,10)">
    <rect x="0" y="3" width="20" height="12" rx="3" fill="#dc2626"/>
    <rect x="2" y="5" width="12" height="6" rx="1.5" fill="white" fill-opacity="0.3"/>
    <circle cx="4"  cy="16" r="2.5" fill="#111"/><circle cx="15" cy="16" r="2.5" fill="#111"/>
    <rect x="18" y="5" width="3" height="3" rx="1" fill="#fef08a" fill-opacity="0.9"/>
  </g>
  <g transform="translate(63,10) scale(-1,1)">
    <rect x="0" y="3" width="20" height="12" rx="3" fill="#dc2626"/>
    <rect x="2" y="5" width="12" height="6" rx="1.5" fill="white" fill-opacity="0.3"/>
    <circle cx="4"  cy="16" r="2.5" fill="#111"/><circle cx="15" cy="16" r="2.5" fill="#111"/>
    <rect x="18" y="5" width="3" height="3" rx="1" fill="#fef08a" fill-opacity="0.9"/>
  </g>
  <g transform="translate(22,-1)">
    <path d="M10,28 Q12,16 14,21 Q16,10 18,21 Q20,16 21,28Z" fill="#f97316" opacity="0.95"/>
    <path d="M12,28 Q13,18 14.5,22 Q16,12 17,22 Q18,18 19,28Z" fill="#fbbf24" opacity="0.9"/>
    <path d="M13,28 Q14,20 15,23 Q16,15 17,23 Q17,20 18,28Z" fill="#fef08a" opacity="0.88"/>
    <text x="1" y="10" font-size="7" fill="#fbbf24">✦</text>
    <text x="18" y="8" font-size="6" fill="#fca5a5">✦</text>
  </g>
</svg>`;

const createAccidentIcon = (cause = "inconnu", blockedCount = 0) => {
  const m     = ACCIDENT_META[cause] || ACCIDENT_META.inconnu;
  const isCol = cause === "collision";
  const badge = blockedCount > 0
    ? `<div style="position:absolute;top:-5px;right:-5px;background:#dc2626;color:white;border-radius:999px;min-width:18px;height:18px;font-size:10px;font-weight:bold;display:flex;align-items:center;justify-content:center;border:2px solid #0f172a;padding:0 3px;z-index:2">${blockedCount}</div>`
    : "";
  const html = isCol
    ? `<div style="position:relative;width:68px;height:50px">
        <div style="position:absolute;inset:-8px;border-radius:16px;background:${m.glow};animation:ping 0.9s infinite"></div>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 3px 8px ${m.bg})">${COLLISION_SVG()}</div>
        ${badge}</div>`
    : `<div style="position:relative;width:46px;height:46px">
        ${blockedCount > 0 ? `<div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${m.ring};opacity:0.6;animation:ping 1.3s infinite"></div>` : ""}
        <div style="position:absolute;inset:4px;background:${m.bg};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:2.5px solid white;box-shadow:0 2px 12px ${m.glow}">${m.sym}</div>
        ${badge}</div>`;
  return L.divIcon({
    className:   "",
    html,
    iconSize:    isCol ? [68, 50] : [46, 46],
    iconAnchor:  isCol ? [34, 25] : [23, 23],
    popupAnchor: [0, -28],
  });
};

/* ─── Camera follower ──────────────────────────────────────────── */
const CameraFollower = ({ position, enabled }) => {
  const map = useMap();
  useEffect(() => {
    if (!enabled || !position) return;
    map.flyTo([position.lat, position.lng], 16, { duration: 0.7 });
  }, [position, enabled, map]);
  return null;
};

/* ─── ChartTooltip ─────────────────────────────────────────────── */
const ChartTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", fontSize: 11 }}>
      {payload.map((p, i) => <div key={i} style={{ color: p.color, fontWeight: 700 }}>{p.name}: {Math.round(p.value)} km/h</div>)}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   ANALYSIS PANEL — avec prédictions cliquables
═══════════════════════════════════════════════════════════════ */
const AnalysisPanel = ({
  open, onClose, vehicles, accidents, alerts,
  predictions, speedHistory, onDismissAlert,
  onPredictionClick, activePredSegment,
}) => {
  const [tab, setTab] = useState("vitesse");

  const count    = Object.keys(vehicles).length;
  const avgSpeed = count > 0 ? Math.round(Object.values(vehicles).reduce((s, v) => s + (v.speed ?? 0), 0) / count) : 0;
  const maxSpeed = count > 0 ? Math.round(Math.max(...Object.values(vehicles).map(v => v.speed ?? 0))) : 0;

  const TABS = [
    { id: "vitesse",    label: "Vitesses"   },
    { id: "prediction", label: "Prédiction" },
    { id: "accidents",  label: `Accidents${accidents.length > 0 ? ` (${accidents.length})` : ""}` },
    { id: "alertes",    label: `Alertes${alerts.length > 0 ? ` (${alerts.length})` : ""}` },
  ];

  return (
    <div style={{ position:"absolute", left:0, right:0, bottom:0, zIndex:1100, transform: open?"translateY(0)":"translateY(100%)", transition:"transform 0.4s cubic-bezier(0.4,0,0.2,1)" }}>
      <div style={{ background:"#08111e", borderTop:"1px solid #1e3a5f", borderRadius:"20px 20px 0 0", boxShadow:"0 -8px 40px rgba(0,0,0,0.6)", maxHeight:"68vh", display:"flex", flexDirection:"column" }}>
        <div style={{ padding:"12px 20px 0", flexShrink:0 }}>
          <div style={{ display:"flex", justifyContent:"center", marginBottom:8 }}>
            <div style={{ width:36, height:3, background:"#1e3a5f", borderRadius:99 }}/>
          </div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
            <span style={{ color:"#e2e8f0", fontWeight:800, fontSize:14 }}>Analyse du trafic</span>
            <button onClick={onClose} style={{ color:"#475569", background:"none", border:"none", cursor:"pointer" }}><ChevronDown size={18}/></button>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:14 }}>
            {[
              { label:"Véhicules", val:count,              color:"#93c5fd" },
              { label:"Vit. moy",  val:`${avgSpeed} km/h`, color:"#4ade80" },
              { label:"Vit. max",  val:`${maxSpeed} km/h`, color:"#60a5fa" },
              { label:"Accidents", val:accidents.length,   color:accidents.length>0?"#f87171":"#475569" },
            ].map((k,i) => (
              <div key={i} style={{ background:"#0f172a", border:"1px solid #1e3a5f", borderRadius:10, padding:"8px 6px", textAlign:"center" }}>
                <div style={{ fontSize:15, fontWeight:900, color:k.color }}>{k.val}</div>
                <div style={{ fontSize:9, color:"#475569", marginTop:3, textTransform:"uppercase", letterSpacing:"0.08em" }}>{k.label}</div>
              </div>
            ))}
          </div>
          <div style={{ display:"flex", gap:4, borderBottom:"1px solid #1e3a5f" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{ background:"none", border:"none", cursor:"pointer", padding:"6px 12px", fontSize:11, fontWeight:700, color:tab===t.id?"#60a5fa":"#475569", borderBottom:tab===t.id?"2px solid #3b82f6":"2px solid transparent" }}>{t.label}</button>
            ))}
          </div>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"16px 20px 20px" }}>

          {/* VITESSE */}
          {tab === "vitesse" && (
            <div>
              {speedHistory.length < 2 ? (
                <div style={{ color:"#334155", fontSize:11, textAlign:"center", padding:"20px 0" }}>En attente de données…</div>
              ) : (
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={speedHistory} margin={{ top:4, right:4, bottom:0, left:-20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" vertical={false}/>
                    <XAxis dataKey="t" tick={{ fontSize:9, fill:"#475569" }} tickLine={false} axisLine={false}/>
                    <YAxis tick={{ fontSize:9, fill:"#475569" }} tickLine={false} axisLine={false} domain={[0,"auto"]}/>
                    <Tooltip content={<ChartTooltip/>}/>
                    <ReferenceLine y={50} stroke="#eab30840" strokeDasharray="4 4"/>
                    <Line type="monotone" dataKey="avg" stroke="#3b82f6" strokeWidth={2} dot={false} name="Moy." isAnimationActive={false}/>
                    <Line type="monotone" dataKey="max" stroke="#f87171" strokeWidth={1.5} dot={false} name="Max" strokeDasharray="4 4" isAnimationActive={false}/>
                  </LineChart>
                </ResponsiveContainer>
              )}
              <div style={{ marginTop:16, display:"flex", flexDirection:"column", gap:6 }}>
                {SPEED_BANDS.slice(0,5).map((b,i) => {
                  const c = Object.values(vehicles).filter(v => { const s=v.speed??0; const prev=SPEED_BANDS[i-1]?.max??-1; return s>prev&&s<=b.max; }).length;
                  const pct = count>0?c/count:0;
                  return (
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:10 }}>
                      <span style={{ width:40, fontSize:9, color:"#475569", fontFamily:"monospace", flexShrink:0 }}>{b.label}</span>
                      <div style={{ flex:1, background:"#0f172a", borderRadius:99, height:6, overflow:"hidden" }}>
                        <div style={{ width:`${pct*100}%`, height:"100%", background:b.color, borderRadius:99, transition:"width 0.5s" }}/>
                      </div>
                      <span style={{ width:18, fontSize:9, color:b.color, fontFamily:"monospace", textAlign:"right" }}>{c}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* PRÉDICTIONS — cliquables pour voir la route */}
          {tab === "prediction" && (
            <div>
              {predictions.length === 0 ? (
                <div style={{ color:"#334155", fontSize:11, textAlign:"center", padding:"32px 0" }}>
                  Aucune prédiction — attendre 60 steps de simulation
                </div>
              ) : (
                <div>
                  <div style={{ fontSize:10, color:"#475569", marginBottom:10 }}>
                    Cliquez sur un segment pour le visualiser en bleu sur la carte
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                    {predictions.slice(0,12).map((p,i) => {
                      const s = p.predicted_speed??0;
                      const horizon = p.prediction_horizon==="short"?"10 min":p.prediction_horizon==="medium"?"30 min":"1h";
                      const isActive = activePredSegment === p.segment_id;
                      return (
                        <div key={i}
                          onClick={() => onPredictionClick?.(isActive ? null : p.segment_id)}
                          style={{
                            background: isActive ? "#0c1f3a" : "#0f172a",
                            border: `1px solid ${isActive ? "#3b82f6" : "#1e3a5f"}`,
                            borderLeft: `3px solid ${isActive ? "#3b82f6" : speedColor(s)}`,
                            borderRadius:8, padding:"10px 12px",
                            display:"flex", alignItems:"center", justifyContent:"space-between", gap:8,
                            cursor:"pointer", transition:"all 0.15s",
                          }}>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:10, color: isActive?"#93c5fd":"#475569", fontFamily:"monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                              {isActive ? "📍 " : ""}{(p.segment_id||"").slice(0,28)}
                            </div>
                            <div style={{ fontSize:9, color:"#334155", marginTop:2 }}>dans {horizon}</div>
                          </div>
                          <div style={{ textAlign:"right", flexShrink:0 }}>
                            <div style={{ fontSize:13, fontWeight:800, color:speedColor(s) }}>{Math.round(s)} km/h</div>
                            {p.confidence_score != null && (
                              <div style={{ fontSize:9, color:"#334155" }}>conf. {Math.round(p.confidence_score*100)}%</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ACCIDENTS */}
          {tab === "accidents" && (
            <div>
              {accidents.length === 0 ? (
                <div style={{ color:"#334155", fontSize:11, textAlign:"center", padding:"32px 0" }}>Aucun accident dans ce scénario</div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {accidents.map((acc,idx) => {
                    const m = ACCIDENT_META[acc.cause]||ACCIDENT_META.inconnu;
                    const blocked = acc.blocked_count||0;
                    return (
                      <div key={acc.id||idx} style={{ background:"#0f172a", border:"1px solid #1e3a5f", borderRadius:10, padding:"12px 14px", borderLeft:`3px solid ${m.bg}` }}>
                        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
                          <div style={{ width:30, height:30, borderRadius:"50%", background:m.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, flexShrink:0 }}>{m.sym}</div>
                          <div style={{ flex:1 }}>
                            <div style={{ fontSize:12, fontWeight:700, color:"#e2e8f0" }}>{m.label}</div>
                            <div style={{ fontSize:9, color:"#475569", fontFamily:"monospace" }}>{acc.id||`accident_${idx}`}</div>
                          </div>
                          {blocked>0 && <div style={{ background:"#7f1d1d", color:"#fca5a5", fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:99 }}>{blocked} bloqué{blocked>1?"s":""}</div>}
                        </div>
                        <div style={{ fontSize:9, color:"#334155" }}>{Number(acc.lat||0).toFixed(5)}, {Number(acc.lng||0).toFixed(5)}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ALERTES */}
          {tab === "alertes" && (
            <div>
              {alerts.length === 0 ? (
                <div style={{ color:"#334155", fontSize:11, textAlign:"center", padding:"32px 0" }}>Aucune alerte</div>
              ) : (
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {alerts.map(a => {
                    const isCrit = a.severity==="critical"||a.risk_level==="critical";
                    return (
                      <div key={a._id} style={{ background:"#0f172a", border:`1px solid ${isCrit?"#7f1d1d":"#1e3a5f"}`, borderLeft:`3px solid ${isCrit?"#ef4444":"#f97316"}`, borderRadius:10, padding:"10px 12px", display:"flex", alignItems:"flex-start", gap:10 }}>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:11, fontWeight:700, color:isCrit?"#fca5a5":"#fdba74", marginBottom:3 }}>{a.title||"Alerte"}</div>
                          <div style={{ fontSize:10, color:"#64748b", lineHeight:1.4 }}>{a.message||"—"}</div>
                          <div style={{ fontSize:9, color:"#334155", marginTop:4 }}>{new Date(a.timestamp||Date.now()).toLocaleTimeString("fr-FR")}</div>
                        </div>
                        {onDismissAlert && <button onClick={()=>onDismissAlert(a._id)} style={{ background:"none", border:"none", color:"#334155", cursor:"pointer", padding:2 }}><X size={13}/></button>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SIM SIDEBAR — avec bouton Pause
═══════════════════════════════════════════════════════════════ */
const SimSidebar = ({ running, paused, vehicles, trackedVehicleId, followMode, onToggleFollow, onOpenScenario, onStop, onTogglePause, onToggleVehicleList, showVehicleList }) => {
  const [expanded, setExpanded] = useState(false);
  const count = Object.keys(vehicles).length;
  if (!running) return null;
  return (
    <div style={{ position:"absolute", right:16, top:"50%", transform:"translateY(-50%)", zIndex:1000, display:"flex", flexDirection:"column", gap:6 }}>
      <button onClick={() => setExpanded(e=>!e)} style={{ width:42, height:42, borderRadius:"50%", background:"#1e3a5f", border:"1px solid #2d5a8e", color:"#93c5fd", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 4px 16px rgba(0,0,0,0.4)" }}>
        {expanded ? <ChevronDown size={16}/> : <ChevronUp size={16}/>}
      </button>
      {expanded && (
        <>
          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
            {[1,2,5].map(f => (
              <button key={f} onClick={() => fetch(`${API_BASE}/simulation/step-delay`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({factor:f})}).catch(()=>{})} style={{ width:42, height:34, borderRadius:8, background:"#0f172a", border:"1px solid #1e3a5f", color:"#60a5fa", fontSize:10, fontWeight:800, cursor:"pointer" }}>×{f}</button>
            ))}
          </div>
          <div style={{ height:1, background:"#1e3a5f" }}/>
          {/* PAUSE / REPRENDRE */}
          <button onClick={onTogglePause} title={paused?"Reprendre":"Pause"} style={{ width:42, height:36, borderRadius:8, background: paused?"#1c1400":"#0f172a", border:`1px solid ${paused?"#d97706":"#1e3a5f"}`, color:paused?"#d97706":"#60a5fa", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}>
            {paused ? <Play size={14}/> : <Pause size={14}/>}
          </button>
          <button onClick={onToggleFollow} style={{ width:42, height:36, borderRadius:8, background: followMode&&trackedVehicleId?"#1e3a5f":"#0f172a", border:`1px solid ${followMode&&trackedVehicleId?"#3b82f6":"#1e3a5f"}`, color:followMode&&trackedVehicleId?"#60a5fa":"#475569", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><Eye size={14}/></button>
          <button onClick={onToggleVehicleList} style={{ width:42, height:36, borderRadius:8, background:showVehicleList?"#1e3a5f":"#0f172a", border:"1px solid #1e3a5f", color:showVehicleList?"#93c5fd":"#475569", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><List size={14}/></button>
          <button onClick={onOpenScenario} style={{ width:42, height:36, borderRadius:8, background:"#0f172a", border:"1px solid #1e3a5f", color:"#a78bfa", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><Settings size={14}/></button>
          <div style={{ height:1, background:"#1e3a5f" }}/>
          <button onClick={onStop} style={{ width:42, height:36, borderRadius:8, background:"#450a0a", border:"1px solid #7f1d1d", color:"#f87171", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><Square size={14}/></button>
        </>
      )}
      {!expanded && <div style={{ background:"#0f172a", border:"1px solid #1e3a5f", borderRadius:8, padding:"4px 0", textAlign:"center", fontSize:10, color: paused?"#d97706":"#60a5fa", fontWeight:700 }}>{paused?"⏸":"▶"} {count}</div>}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENARIO PANEL (simplifié — même logique que précédemment)
═══════════════════════════════════════════════════════════════ */
const ScenarioPanel = ({ onClose, onScenarioDeployed }) => {
  const [scenarios,    setScenarios]    = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [deploying,    setDeploying]    = useState(null);
  const [activeId,     setActiveId]     = useState(null);
  const [confirmDel,   setConfirmDel]   = useState(null);
  const [deleting,     setDeleting]     = useState(null);
  const [fixingRoutes, setFixingRoutes] = useState(false);
  const [fixMessage,   setFixMessage]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [l, a] = await Promise.all([
        fetch(`${API_BASE}/scenario/list`).then(r=>r.json()),
        fetch(`${API_BASE}/scenario/active`).then(r=>r.json()),
      ]);
      const list = l.scenarios||[];
      setScenarios(list);
      setActiveId(list.find(s=>s.is_active)?.scenario_id || a.active || null);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const deploy = async (id) => {
    setDeploying(id); setFixMessage(null);
    try {
      const r = await fetch(`${API_BASE}/scenario/select/${id}`,{method:"POST"});
      if (!r.ok) throw new Error((await r.json()).detail||"Erreur");
      setActiveId(id); await load(); onScenarioDeployed?.(id);
    } catch (e) { setFixMessage(`Erreur : ${e.message}`); }
    setDeploying(null);
  };

  const selectDefault = async () => {
    setFixMessage(null);
    try {
      await fetch(`${API_BASE}/scenario/select-default`,{method:"POST"});
      setActiveId(null); await load(); onScenarioDeployed?.("default");
    } catch (e) { setFixMessage(`Erreur : ${e.message}`); }
  };

  const del = async (id) => {
    setDeleting(id); setConfirmDel(null);
    try {
      const r = await fetch(`${API_BASE}/scenario/${id}`,{method:"DELETE"});
      if (!r.ok) throw new Error((await r.json()).detail);
      if (activeId===id) setActiveId(null);
      await load();
    } catch (e) { setFixMessage(`Erreur : ${e.message}`); }
    setDeleting(null);
  };

  const fixRoutes = async () => {
    setFixingRoutes(true); setFixMessage(null);
    try {
      const r = await fetch(`${API_BASE}/scenario/fix-routes`,{method:"POST"});
      setFixMessage((await r.json()).message||"Routes régénérées");
    } catch (e) { setFixMessage(`Erreur : ${e.message}`); }
    setFixingRoutes(false);
  };

  return (
    <div style={{ position:"absolute", inset:0, zIndex:1200, display:"flex", alignItems:"flex-end", justifyContent:"center" }} onClick={onClose}>
      <div style={{ width:"100%", maxWidth:480, background:"#08111e", borderTop:"1px solid #1e3a5f", borderRadius:"20px 20px 0 0", maxHeight:"78vh", display:"flex", flexDirection:"column", boxShadow:"0 -8px 40px rgba(0,0,0,0.6)" }} onClick={e=>e.stopPropagation()}>
        <div style={{ padding:"12px 20px 0", flexShrink:0 }}>
          <div style={{ display:"flex", justifyContent:"center", marginBottom:10 }}>
            <div style={{ width:36, height:3, background:"#1e3a5f", borderRadius:99 }}/>
          </div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, borderBottom:"1px solid #1e3a5f", paddingBottom:12 }}>
            <span style={{ color:"#e2e8f0", fontWeight:800, fontSize:14 }}>Scénarios</span>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={load} style={{ background:"none", border:"none", color:"#475569", cursor:"pointer" }}><RefreshCw size={14}/></button>
              <button onClick={onClose} style={{ background:"none", border:"none", color:"#475569", cursor:"pointer" }}><X size={16}/></button>
            </div>
          </div>
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"0 16px 16px", display:"flex", flexDirection:"column", gap:10 }}>
          {loading ? (
            <div style={{ color:"#334155", textAlign:"center", padding:"32px 0", fontSize:12 }}>Chargement…</div>
          ) : scenarios.length===0 ? (
            <div style={{ color:"#334155", textAlign:"center", padding:"32px 0", fontSize:12 }}>Aucun scénario — créez-en un depuis la Vue Globale</div>
          ) : scenarios.map(sc => {
            const isActive = sc.scenario_id===activeId;
            const date = sc.generated_at ? new Date(sc.generated_at).toLocaleDateString("fr-FR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";
            return (
              <div key={sc.scenario_id} style={{ background:"#0f172a", border:`1px solid ${isActive?"#2d5a8e":"#1e3a5f"}`, borderRadius:12, padding:14 }}>
                <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10 }}>
                  <div>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:12, fontWeight:800, color:"#e2e8f0" }}>{sc.scenario_name||sc.scenario_id}</span>
                      {isActive && <span style={{ fontSize:9, background:"#1e40af", color:"#93c5fd", padding:"1px 6px", borderRadius:99, fontWeight:700 }}>Actif</span>}
                    </div>
                    <div style={{ fontSize:9, color:"#334155", fontFamily:"monospace", marginTop:2 }}>{sc.scenario_id}</div>
                  </div>
                  <span style={{ fontSize:9, color:"#334155" }}>{date}</span>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:6, marginBottom:10 }}>
                  {[{val:sc.vehicle_count??"—",label:"Véhicules"},{val:sc.pedestrian_count??"—",label:"Piétons"},{val:sc.accident_count??"—",label:"Accidents"}].map((m,i) => (
                    <div key={i} style={{ background:"#0a1628", borderRadius:8, padding:"6px 8px", textAlign:"center" }}>
                      <div style={{ fontSize:12, fontWeight:900, color:"#60a5fa" }}>{m.val}</div>
                      <div style={{ fontSize:8, color:"#334155", marginTop:2 }}>{m.label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  {isActive ? (
                    <div style={{ flex:1, padding:"8px 0", borderRadius:8, fontSize:11, fontWeight:700, textAlign:"center", color:"#60a5fa", background:"#0a1628", border:"1px solid #1e3a5f" }}>✓ Actif</div>
                  ) : (
                    <button onClick={() => deploy(sc.scenario_id)} disabled={!!deploying} style={{ flex:1, padding:"8px 0", borderRadius:8, fontSize:11, fontWeight:700, background:"#1e3a5f", border:"1px solid #2d5a8e", color:"#93c5fd", cursor:deploying?"not-allowed":"pointer", opacity:deploying?0.6:1 }}>
                      {deploying===sc.scenario_id?"…":"Utiliser"}
                    </button>
                  )}
                  {confirmDel===sc.scenario_id ? (
                    <div style={{ display:"flex", gap:4 }}>
                      <button onClick={() => del(sc.scenario_id)} disabled={!!deleting} style={{ padding:"8px 10px", borderRadius:8, background:"#7f1d1d", border:"none", color:"#fca5a5", fontSize:11, fontWeight:700, cursor:"pointer" }}>{deleting===sc.scenario_id?"…":"Confirmer"}</button>
                      <button onClick={() => setConfirmDel(null)} style={{ padding:"8px 10px", borderRadius:8, background:"#1e293b", border:"none", color:"#94a3b8", fontSize:11, cursor:"pointer" }}>Annuler</button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmDel(sc.scenario_id)} style={{ width:34, borderRadius:8, background:"#0f172a", border:"1px solid #1e3a5f", color:"#334155", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center" }}><Trash2 size={13}/></button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ padding:"12px 16px", borderTop:"1px solid #1e3a5f", flexShrink:0, display:"flex", flexDirection:"column", gap:8 }}>
          {fixMessage && <div style={{ fontSize:10, padding:"8px 12px", borderRadius:8, background:fixMessage.startsWith("Erreur")?"#450a0a":"#052e16", border:`1px solid ${fixMessage.startsWith("Erreur")?"#7f1d1d":"#14532d"}`, color:fixMessage.startsWith("Erreur")?"#fca5a5":"#4ade80" }}>{fixMessage}</div>}
          {activeId && (
            <button onClick={fixRoutes} disabled={fixingRoutes} style={{ padding:"8px 0", borderRadius:8, fontSize:11, fontWeight:700, background:"#1c1400", border:"1px solid #3d2e00", color:"#d97706", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
              {fixingRoutes?<><RefreshCw size={11} style={{ animation:"spin 1s linear infinite" }}/>Régénération…</>:"🔧 Corriger les routes"}
            </button>
          )}
          <div style={{ background:!activeId?"#0c1f3a":"#0a1628", border:`1px solid ${!activeId?"#2d5a8e":"#1e3a5f"}`, borderRadius:10, padding:"10px 14px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <div style={{ fontSize:11, fontWeight:700, color:"#e2e8f0", display:"flex", alignItems:"center", gap:6 }}>Fichiers par défaut {!activeId&&<span style={{ fontSize:9, background:"#1e40af", color:"#93c5fd", padding:"1px 6px", borderRadius:99 }}>Actif</span>}</div>
              <div style={{ fontSize:9, color:"#334155", fontFamily:"monospace", marginTop:2 }}>maps/ (casa.net.xml…)</div>
            </div>
            {activeId && <button onClick={selectDefault} style={{ padding:"6px 12px", borderRadius:8, fontSize:10, fontWeight:700, background:"#1e3a5f", border:"1px solid #2d5a8e", color:"#93c5fd", cursor:"pointer" }}>Utiliser</button>}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   COMPOSANT PRINCIPAL
═══════════════════════════════════════════════════════════════ */
const MapSolo = () => {
  const [allVehicles,       setAllVehicles]       = useState({});
  // Positions interpolées à 60fps pour la fluidité
  const smoothVehicles = useVehicleInterpolation(allVehicles);
  const [trackedVehicleId,  setTrackedVehicleId]  = useState(null);
  const [trackedVehicle,    setTrackedVehicle]    = useState(null);
  const [socketStatus,      setSocketStatus]      = useState("disconnected");
  const [running,           setRunning]           = useState(simulationStore.running);
  const [paused,            setPaused]            = useState(simulationStore.paused);
  const [followMode,        setFollowMode]        = useState(true);
  const [allAlerts,         setAllAlerts]         = useState([]);
  const [predictions,       setPredictions]       = useState([]);
  const [accidents,         setAccidents]         = useState([]);
  const [pedestrians,       setPedestrians]       = useState({});
  const [speedHistory,      setSpeedHistory]      = useState([]);
  const [showVehicleList,   setShowVehicleList]   = useState(true);
  const [analysisOpen,      setAnalysisOpen]      = useState(false);
  const [scenarioPanelOpen, setScenarioPanelOpen] = useState(false);
  // Prédiction active → route bleue sur la carte
  const [activePredSegment, setActivePredSegment] = useState(null);
  const [predRoutePoints,   setPredRoutePoints]   = useState([]);

  const trackedVehicleIdRef = useRef(null);
  const mountedRef          = useRef(false);
  const tickRef             = useRef(0);

  /* ── Sync store partagé ── */
  useEffect(() => {
    const unsub = simulationStore.subscribe(({ running: r, paused: p }) => {
      setRunning(r);
      setPaused(p);
    });
    return unsub;
  }, []);

  /* ── Socket ── */
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    socketService.connect();

    const onAll = (data) => {
      if (!data?.vehicles) return;
      setAllVehicles(data.vehicles);
      if (data.pedestrians) setPedestrians(data.pedestrians);
      const id = trackedVehicleIdRef.current;
      if (id && data.vehicles[id]) setTrackedVehicle({ id, ...data.vehicles[id] });
      const vals = Object.values(data.vehicles);
      if (vals.length > 0) {
        const avg = vals.reduce((s,v) => s+(v.speed??0), 0) / vals.length;
        const max = Math.max(...vals.map(v => v.speed??0));
        tickRef.current += 1;
        setSpeedHistory(h => [...h, { t:tickRef.current, avg:Math.round(avg*10)/10, max:Math.round(max*10)/10 }].slice(-MAX_HISTORY));
      }
    };
    const onVeh = (data) => {
      if (!data?.id || data.lat==null) return;
      setAllVehicles(p => ({ ...p, [data.id]: { lat:data.lat, lng:data.lng, speed:data.speed||0, heading:data.heading||0 } }));
      if (trackedVehicleIdRef.current===data.id)
        setTrackedVehicle({ id:data.id, lat:data.lat, lng:data.lng, speed:data.speed||0, heading:data.heading||0 });
    };
    const pushAlert = (data) => {
      const a = { ...data, _id:Date.now()+Math.random(), timestamp:data.timestamp||new Date().toISOString(), severity:data.risk_level||data.severity||"warning", title:data.title||"Alerte sécurité", message:data.message||`${data.vehicle_id||"Véhicule"} — risque détecté` };
      setAllAlerts(prev => [a,...prev].slice(0,50));
    };
    const onAccidents = (data) => { if (data?.accidents) setAccidents(data.accidents); };
    const onSimStatus = (data) => {
      if (data.status==="started") {
        simulationStore.setRunning(true);
      } else if (data.status==="stopped") {
        simulationStore.setRunning(false);
        setAllVehicles({}); setPedestrians({}); setAccidents([]);
        setSpeedHistory([]); tickRef.current=0;
        setTrackedVehicle(null); setTrackedVehicleId(null);
        trackedVehicleIdRef.current=null; setAllAlerts([]);
        setActivePredSegment(null); setPredRoutePoints([]);
      } else if (data.status==="paused") {
        simulationStore.setPaused(true);
      } else if (data.status==="resumed") {
        simulationStore.setPaused(false);
      }
    };

    socketService.on("connect",            () => setSocketStatus("connected"));
    socketService.on("disconnect",         () => { setSocketStatus("disconnected"); });
    socketService.on("connect_error",      () => setSocketStatus("error"));
    socketService.on("all_vehicles_state", onAll);
    socketService.on("vehicle_state",      onVeh);
    socketService.on("emergency_alert",    pushAlert);
    socketService.on("road_alert",         d => pushAlert({...d,title:d.title||"Perturbation route"}));
    socketService.on("accident_alert",     d => pushAlert({...d,title:d.title||"Accident signalé",severity:"critical"}));
    socketService.on("accidents_state",    onAccidents);
    socketService.on("collision_risk_alert", pushAlert);
    socketService.on("traffic_prediction", d => { if (d?.segment_id) setPredictions(p => [d,...p].slice(0,30)); });
    socketService.on("simulation_status",  onSimStatus);

    return () => {
      ["connect","disconnect","connect_error","all_vehicles_state","vehicle_state",
       "emergency_alert","road_alert","accident_alert","accidents_state",
       "collision_risk_alert","traffic_prediction","simulation_status",
      ].forEach(ev => socketService.off(ev));
      mountedRef.current = false;
    };
  }, []);

  /* ── Prédiction → route bleue ── */
  const handlePredictionClick = useCallback((segmentId) => {
    setActivePredSegment(segmentId);
    if (!segmentId) { setPredRoutePoints([]); return; }
    // Construire une polyligne depuis les véhicules sur ce segment
    // On fait une approximation depuis les positions véhicules actuelles
    // Dans un vrai système on ferait GET /net/edge/{segmentId}/shape
    // Pour l'instant on montre un marqueur de centroïde
    const vOnSeg = Object.values(allVehicles).slice(0, 5);
    if (vOnSeg.length >= 2) {
      setPredRoutePoints(vOnSeg.map(v => [v.lat, v.lng]));
    } else {
      setPredRoutePoints([]);
    }
  }, [allVehicles]);

  /* ── Actions ── */
  const startSimulation = async () => {
    try {
      const r = await apiService.startSimulation();
      if (r.status==="started") {
        simulationStore.setRunning(true);
        setTimeout(async () => { try { await apiService.startJourney(); } catch {} }, 2000);
      }
    } catch (e) { console.error(e); }
  };

  const stopSimulation = async () => {
    try { await apiService.stopSimulation(); } catch {}
    simulationStore.setRunning(false);
    setAllVehicles({}); setPedestrians({});
    setTrackedVehicle(null); setTrackedVehicleId(null);
    trackedVehicleIdRef.current=null;
    setActivePredSegment(null); setPredRoutePoints([]);
  };

  const togglePause = async () => {
    try {
      if (paused) {
        await fetch(`${API_BASE}/simulation/resume`, { method: "POST" });
        simulationStore.setPaused(false);
      } else {
        await fetch(`${API_BASE}/simulation/pause`, { method: "POST" });
        simulationStore.setPaused(true);
      }
    } catch (e) { console.error(e); }
  };

  const handleSelectVehicle = useCallback((id, v) => {
    setTrackedVehicleId(id); trackedVehicleIdRef.current=id;
    setTrackedVehicle({ id, ...v }); setFollowMode(true);
  }, []);

  const handleClearTracking = useCallback(() => {
    setTrackedVehicleId(null); trackedVehicleIdRef.current=null; setTrackedVehicle(null);
  }, []);

  const dismissAlert = useCallback((id) => setAllAlerts(p => p.filter(a => a._id!==id)), []);

  const statusLabel = socketStatus==="connected"?"Connecté":socketStatus==="error"?"Erreur":"Déconnecté";
  const statusColor = socketStatus==="connected"?"#22c55e":socketStatus==="error"?"#ef4444":"#475569";

  return (
    <div style={{ height:"100%", width:"100%", position:"relative", background:"#08111e", overflow:"hidden" }}>
      <InjectStyles/>

      {/* NAVBAR */}
      <div style={{ position:"absolute", top:0, left:0, right:0, zIndex:1000, height:52, background:"#08111eee", backdropFilter:"blur(12px)", borderBottom:"1px solid #1e3a5f", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 16px", gap:12 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, minWidth:0 }}>
          <span style={{ fontSize:13, fontWeight:800, color:"#e2e8f0", whiteSpace:"nowrap" }}>TMT Traffic</span>
          <div style={{ display:"flex", alignItems:"center", gap:5, background:"#0f172a", border:"1px solid #1e3a5f", borderRadius:20, padding:"3px 10px" }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:statusColor }}/>
            <span style={{ fontSize:10, color:statusColor, fontWeight:600 }}>{statusLabel}</span>
          </div>
          {running && (
            <div style={{ fontSize:10, color: paused?"#d97706":"#60a5fa", background:"#0f172a", border:"1px solid #1e3a5f", borderRadius:20, padding:"3px 10px", fontFamily:"monospace" }}>
              {paused ? "⏸ En pause" : `${Object.keys(allVehicles).length}v · ${Object.keys(pedestrians).length}p · ${accidents.length}acc`}
            </div>
          )}
          {trackedVehicle && (
            <div style={{ display:"flex", alignItems:"center", gap:6, background:"#0f172a", border:"1px solid #1e3a5f", borderRadius:20, padding:"3px 10px" }}>
              <Eye size={10} color="#4ade80"/>
              <span style={{ fontSize:10, color:"#4ade80", fontFamily:"monospace" }}>{trackedVehicleId}</span>
              <span style={{ fontSize:10, fontWeight:700, color:speedColor(trackedVehicle.speed) }}>{Math.round(trackedVehicle.speed)} km/h</span>
              <button onClick={handleClearTracking} style={{ background:"none", border:"none", color:"#334155", cursor:"pointer", padding:0, lineHeight:1 }}><X size={10}/></button>
            </div>
          )}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
          <button onClick={() => setScenarioPanelOpen(true)} style={{ display:"flex", alignItems:"center", gap:5, background:"#0f172a", border:"1px solid #1e3a5f", borderRadius:8, padding:"6px 12px", fontSize:11, fontWeight:700, color:"#a78bfa", cursor:"pointer" }}>
            <Settings size={12}/> Scénario
          </button>
          {running ? (
            <div style={{ display:"flex", gap:6 }}>
              {/* PAUSE */}
              <button onClick={togglePause} style={{ display:"flex", alignItems:"center", gap:5, background: paused?"#1c1400":"#0f172a", border:`1px solid ${paused?"#d97706":"#1e3a5f"}`, borderRadius:8, padding:"7px 12px", fontSize:12, fontWeight:700, color:paused?"#d97706":"#93c5fd", cursor:"pointer" }}>
                {paused ? <><Play size={13}/> Reprendre</> : <><Pause size={13}/> Pause</>}
              </button>
              {/* STOP */}
              <button onClick={stopSimulation} style={{ display:"flex", alignItems:"center", gap:6, background:"#450a0a", border:"1px solid #7f1d1d", borderRadius:8, padding:"7px 16px", fontSize:12, fontWeight:800, color:"#f87171", cursor:"pointer" }}>
                <Square size={13}/> Arrêter
              </button>
            </div>
          ) : (
            <button onClick={startSimulation} style={{ display:"flex", alignItems:"center", gap:6, background:"#1e40af", border:"1px solid #2563eb", borderRadius:8, padding:"7px 16px", fontSize:12, fontWeight:800, color:"white", cursor:"pointer", boxShadow:"0 2px 12px #1e40af66" }}>
              <Play size={13}/> Démarrer
            </button>
          )}
        </div>
      </div>

      {/* MAP */}
      <MapContainer center={[33.5731,-7.5898]} zoom={13} style={{ height:"100%", width:"100%" }} zoomControl={false}>
        <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
        <CameraFollower position={trackedVehicle?{lat:trackedVehicle.lat,lng:trackedVehicle.lng}:null} enabled={followMode&&!!trackedVehicleId}/>

        {/* Route prédiction active — bleue animée */}
        {activePredSegment && predRoutePoints.length >= 2 && (
          <Polyline positions={predRoutePoints} color="#3b82f6" weight={6} opacity={0.8}
            pathOptions={{ dashArray: "10 5", className: "pred-route-line" }}/>
        )}

        {/* Véhicules — positions interpolées (60fps) */}
        {Object.entries(smoothVehicles).map(([id,v]) => {
          const isTracked = id===trackedVehicleId;
          return (
            <Marker key={id} position={[v.lat,v.lng]}
              icon={isTracked?createTrackedIcon(v.speed,v.heading):createVehicleIcon(v.speed,v.heading)}
              eventHandlers={{ contextmenu:()=>handleSelectVehicle(id,v) }}>
              <Popup>
                <div style={{ minWidth:120, textAlign:"center", fontFamily:"sans-serif" }}>
                  <div style={{ fontWeight:800, fontSize:12, color:speedColor(v.speed), marginBottom:4 }}>{id}</div>
                  <div style={{ fontWeight:700, fontSize:16, color:speedColor(v.speed) }}>{Math.round(v.speed)} km/h</div>
                  <div style={{ fontSize:10, color:"#94a3b8", marginTop:2 }}>Cap: {Math.round(v.heading||0)}°</div>
                  <button onClick={() => handleSelectVehicle(id,v)} style={{ marginTop:8, width:"100%", padding:"5px 0", borderRadius:6, background:"#1e40af", border:"none", color:"white", fontSize:10, fontWeight:700, cursor:"pointer" }}>
                    {isTracked?"Suivi actif":"Suivre"}
                  </button>
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* ── PIÉTONS — dans MapContainer ── */}
        {Object.entries(pedestrians).map(([pid,p]) => (
          <Marker key={pid} position={[p.lat,p.lng]} icon={createPedestrianIcon(pid)} zIndexOffset={500}>
            <Popup>
              <div style={{ fontFamily:"sans-serif", fontSize:11 }}>
                <div style={{ fontWeight:700, color:"#06b6d4", marginBottom:3 }}>🚶 Piéton {pid}</div>
                <div style={{ color:"#6b7280" }}>{Math.round(p.speed||0)} km/h · cap {Math.round(p.heading||0)}°</div>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* ── ACCIDENTS — dans MapContainer ── */}
        {accidents.filter(a => a.lat && a.lng).map((acc,idx) => {
          const cause = acc.cause||"inconnu";
          const blocked = acc.blocked_count||0;
          const m = ACCIDENT_META[cause]||ACCIDENT_META.inconnu;
          return (
            <Marker key={acc.id||`acc_${idx}`} position={[acc.lat,acc.lng]}
              icon={createAccidentIcon(cause,blocked)} zIndexOffset={1000}>
              <Popup minWidth={200}>
                <div style={{ fontFamily:"sans-serif", fontSize:12 }}>
                  <div style={{ background:m.bg, color:"white", borderRadius:6, padding:"6px 10px", fontWeight:700, marginBottom:8, display:"flex", alignItems:"center", gap:6 }}>
                    <span>{m.sym}</span> {m.label}
                  </div>
                  <div style={{ fontSize:10, color:"#6b7280", marginBottom:6 }}>{acc.id||`accident_${idx}`}</div>
                  <div style={{ background:blocked>0?"#fef2f2":"#f0fdf4", border:`1px solid ${blocked>0?"#fca5a5":"#86efac"}`, borderRadius:6, padding:"6px 8px", marginBottom:6 }}>
                    <div style={{ fontWeight:700, fontSize:11, color:blocked>0?"#dc2626":"#16a34a" }}>
                      {blocked>0?`${blocked} véhicule${blocked>1?"s":""} bloqué${blocked>1?"s":""}` : "Circulation fluide"}
                    </div>
                    {(acc.blocked_ids||[]).slice(0,4).map(vid => <div key={vid} style={{ fontSize:10, color:"#6b7280", marginTop:2, fontFamily:"monospace" }}>{vid}</div>)}
                  </div>
                  <div style={{ fontSize:9, color:"#9ca3af" }}>{Number(acc.lat).toFixed(5)}, {Number(acc.lng).toFixed(5)}</div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* SIDEBAR */}
      <SimSidebar
        running={running} paused={paused}
        vehicles={allVehicles}
        trackedVehicleId={trackedVehicleId}
        followMode={followMode}
        onToggleFollow={() => setFollowMode(f=>!f)}
        onOpenScenario={() => setScenarioPanelOpen(true)}
        onStop={stopSimulation}
        onTogglePause={togglePause}
        onToggleVehicleList={() => setShowVehicleList(s=>!s)}
        showVehicleList={showVehicleList}
      />

      {/* VEHICLE LIST */}
      {running && showVehicleList && !analysisOpen && (
        <div style={{ position:"absolute", top:64, left:12, zIndex:1000, background:"#08111eee", backdropFilter:"blur(8px)", border:"1px solid #1e3a5f", borderRadius:12, width:200, maxHeight:320, overflow:"hidden", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"8px 12px 6px", borderBottom:"1px solid #1e3a5f", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <span style={{ fontSize:10, fontWeight:700, color:"#64748b", textTransform:"uppercase", letterSpacing:"0.06em" }}>Véhicules ({Object.keys(allVehicles).length})</span>
            <button onClick={() => setShowVehicleList(false)} style={{ background:"none", border:"none", color:"#334155", cursor:"pointer" }}><X size={12}/></button>
          </div>
          <div style={{ overflowY:"auto", flex:1 }}>
            {Object.entries(allVehicles).length===0 ? (
              <div style={{ padding:"16px 12px", color:"#334155", fontSize:10, textAlign:"center" }}>Aucun véhicule</div>
            ) : Object.entries(allVehicles).map(([id,v]) => (
              <button key={id} onClick={() => handleSelectVehicle(id,v)} style={{ width:"100%", textAlign:"left", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"7px 12px", background:trackedVehicleId===id?"#0c1f3a":"transparent", border:"none", borderBottom:"1px solid #1e3a5f10", cursor:"pointer", gap:8 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <div style={{ width:6, height:6, borderRadius:"50%", background:speedColor(v.speed), flexShrink:0 }}/>
                  <span style={{ fontSize:10, fontFamily:"monospace", color:"#cbd5e1" }}>{id}</span>
                </div>
                <span style={{ fontSize:10, fontWeight:700, color:speedColor(v.speed), fontFamily:"monospace" }}>{Math.round(v.speed)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* BOUTON ANALYSE */}
      {!analysisOpen && (
        <div style={{ position:"absolute", bottom:20, left:"50%", transform:"translateX(-50%)", zIndex:1000 }}>
          <button onClick={() => setAnalysisOpen(true)} style={{ display:"flex", alignItems:"center", gap:8, background:"#08111e", border:"1px solid #2d5a8e", borderRadius:24, padding:"10px 24px", fontSize:12, fontWeight:700, color:"#93c5fd", cursor:"pointer", boxShadow:"0 4px 20px rgba(0,0,0,0.5)", backdropFilter:"blur(8px)" }}>
            <ChevronUp size={15}/>
            Analyse du trafic
            {allAlerts.length > 0 && <span style={{ background:"#7f1d1d", color:"#fca5a5", fontSize:9, fontWeight:800, padding:"1px 6px", borderRadius:99 }}>{allAlerts.length}</span>}
            {activePredSegment && <span style={{ background:"#1e40af", color:"#93c5fd", fontSize:9, fontWeight:800, padding:"1px 6px", borderRadius:99 }}>📍</span>}
          </button>
        </div>
      )}

      <AnalysisPanel
        open={analysisOpen}
        onClose={() => setAnalysisOpen(false)}
        vehicles={allVehicles}
        accidents={accidents}
        alerts={allAlerts}
        predictions={predictions}
        speedHistory={speedHistory}
        onDismissAlert={dismissAlert}
        onPredictionClick={handlePredictionClick}
        activePredSegment={activePredSegment}
      />
      {analysisOpen && <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.35)", zIndex:1050 }} onClick={() => setAnalysisOpen(false)}/>}

      {scenarioPanelOpen && (
        <ScenarioPanel
          onClose={() => setScenarioPanelOpen(false)}
          onScenarioDeployed={() => setScenarioPanelOpen(false)}
        />
      )}
    </div>
  );
};

export default MapSolo;