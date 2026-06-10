// frontend/src/components/screens/MapSolo.jsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import {
  Play, Square, Wifi, WifiOff, Settings, X,
  ChevronUp, ChevronDown, Trash2, Home,
  RefreshCw, FolderOpen, Users, User, Clock,
  AlertTriangle, Eye, EyeOff, List,
} from "lucide-react";
import "leaflet/dist/leaflet.css";
import apiService from "../../services/api";
import socketService from "../../services/socket";

// ── Recharts pour courbes temps réel ──────────────────────────────
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

const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:8000";
const MAX_HISTORY = 60; // points sur les courbes

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
  collision: { label: "Collision",             bg: "#dc2626", ring: "#fca5a5", glow: "#ef444455" },
  panne:     { label: "Panne / arrêt brusque", bg: "#ea580c", ring: "#fdba74", glow: "#f9731655", sym: "🔧" },
  feu_rouge: { label: "Feu grillé",            bg: "#ca8a04", ring: "#fde047", glow: "#eab30855", sym: "🚦" },
  obstacle:  { label: "Obstacle",              bg: "#9333ea", ring: "#d8b4fe", glow: "#a855f755", sym: "🚧" },
  pietons:   { label: "Piétons",               bg: "#2563eb", ring: "#93c5fd", glow: "#3b82f655", sym: "🚶" },
  inconnu:   { label: "Cause inconnue",        bg: "#4b5563", ring: "#d1d5db", glow: "#6b728055", sym: "⚠️" },
};

/* ─── Icônes véhicules ─────────────────────────────────────────── */
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
  const c = speedColor(speed);
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
  const c = speedColor(speed);
  const rot = (heading - 90 + 360) % 360;
  return L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;transform:rotate(${rot}deg);transform-origin:center">${CAR_SVG(c, 22)}</div>`,
    iconSize: [22, 22], iconAnchor: [11, 11],
  });
};

const createPedestrianIcon = () => L.divIcon({
  className: "",
  html: `<div style="width:10px;height:10px;border-radius:50%;background:#06b6d4;border:2px solid #08111e;opacity:0.9"></div>`,
  iconSize: [10, 10], iconAnchor: [5, 5],
});

/* SVG 2 voitures face-à-face avec flammes (collision) */
const COLLISION_SVG = (c) => `
<svg width="58" height="38" viewBox="0 0 58 38" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(1,9)">
    <rect x="0" y="3" width="18" height="11" rx="3" fill="${c}"/>
    <rect x="2" y="5" width="11" height="5" rx="1" fill="white" fill-opacity="0.28"/>
    <circle cx="4"  cy="15" r="2.2" fill="#1e293b"/>
    <circle cx="13" cy="15" r="2.2" fill="#1e293b"/>
    <rect x="16" y="5" width="3" height="2" rx="1" fill="white" fill-opacity="0.85"/>
  </g>
  <g transform="translate(57,9) scale(-1,1)">
    <rect x="0" y="3" width="18" height="11" rx="3" fill="${c}"/>
    <rect x="2" y="5" width="11" height="5" rx="1" fill="white" fill-opacity="0.28"/>
    <circle cx="4"  cy="15" r="2.2" fill="#1e293b"/>
    <circle cx="13" cy="15" r="2.2" fill="#1e293b"/>
    <rect x="16" y="5" width="3" height="2" rx="1" fill="white" fill-opacity="0.85"/>
  </g>
  <g transform="translate(22,0)">
    <path d="M7,22 Q8,13 10,17 Q12,9 14,17 Q15,13 16,22Z" fill="#f97316" opacity="0.97"/>
    <path d="M9,22 Q10,15 11,18 Q12,11 13,18 Q14,15 14,22Z" fill="#fbbf24" opacity="0.9"/>
    <path d="M10,22 Q11,17 11.5,19 Q12.5,13 13,19 Q12.5,17 13,22Z" fill="#fef08a" opacity="0.85"/>
    <text x="3"  y="8"  font-size="6" fill="#fbbf24">✦</text>
    <text x="16" y="7"  font-size="5" fill="#fca5a5">✦</text>
    <text x="0"  y="16" font-size="4" fill="#fed7aa">✦</text>
    <text x="17" y="16" font-size="4" fill="#fed7aa">✦</text>
  </g>
</svg>`;

const createAccidentIcon = (cause = "inconnu", blockedCount = 0) => {
  const m = ACCIDENT_META[cause] || ACCIDENT_META.inconnu;
  const isCol = cause === "collision";

  const badge = blockedCount > 0
    ? `<div style="position:absolute;top:-4px;right:-4px;background:#dc2626;color:white;
                  border-radius:999px;min-width:17px;height:17px;font-size:9px;font-weight:bold;
                  display:flex;align-items:center;justify-content:center;
                  border:2px solid #0f172a;padding:0 2px;z-index:2">${blockedCount}</div>`
    : "";

  const html = isCol
    ? `<div style="position:relative;width:62px;height:46px">
        <div style="position:absolute;inset:-6px;border-radius:14px;
                    background:${m.glow};animation:ping 0.9s infinite"></div>
        <div style="position:absolute;inset:0;display:flex;align-items:center;
                    justify-content:center;filter:drop-shadow(0 2px 6px ${m.bg})">
          ${COLLISION_SVG(m.bg)}
        </div>
        ${badge}
      </div>`
    : `<div style="position:relative;width:44px;height:44px">
        ${blockedCount > 0 ? `<div style="position:absolute;inset:0;border-radius:50%;
                    border:2px solid ${m.ring};opacity:0.6;animation:ping 1.3s infinite"></div>` : ""}
        <div style="position:absolute;inset:4px;background:${m.bg};border-radius:50%;
                    display:flex;align-items:center;justify-content:center;
                    font-size:18px;border:2px solid white;
                    box-shadow:0 2px 10px ${m.glow}">${m.sym}</div>
        ${badge}
      </div>`;

  return L.divIcon({
    className: "",
    html,
    iconSize:    isCol ? [62, 46] : [44, 44],
    iconAnchor:  isCol ? [31, 23] : [22, 22],
    popupAnchor: [0, -26],
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

/* ─── Tooltip recharts ─────────────────────────────────────────── */
const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", fontSize: 11 }}>
      <div style={{ color: "#94a3b8", marginBottom: 3 }}>t = {label}s</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontWeight: 700 }}>{p.name}: {Math.round(p.value)} km/h</div>
      ))}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   PANNEAU ANALYSE (drawer bas)
═══════════════════════════════════════════════════════════════ */
const AnalysisPanel = ({ open, onClose, vehicles, pedestrians = {}, accidents, alerts, predictions, speedHistory, onDismissAlert }) => {
  const [tab, setTab] = useState("vitesse");

  const count    = Object.keys(vehicles).length;
  const avgSpeed = count > 0 ? Math.round(Object.values(vehicles).reduce((s, v) => s + (v.speed ?? 0), 0) / count) : 0;
  const maxSpeed = count > 0 ? Math.round(Math.max(...Object.values(vehicles).map(v => v.speed ?? 0))) : 0;
  const stopped  = Object.values(vehicles).filter(v => (v.speed ?? 0) <= 1).length;

  const TABS = [
    { id: "vitesse",    label: "Vitesses"  },
    { id: "prediction", label: "Prédiction" },
    { id: "accidents",  label: `Accidents ${accidents.length > 0 ? `(${accidents.length})` : ""}` },
    { id: "alertes",    label: `Alertes ${alerts.length > 0 ? `(${alerts.length})` : ""}` },
  ];

  return (
    <div style={{
      position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 1100,
      transform: open ? "translateY(0)" : "translateY(100%)",
      transition: "transform 0.4s cubic-bezier(0.4,0,0.2,1)",
    }}>
      <div style={{
        background: "#08111e",
        borderTop: "1px solid #1e3a5f",
        borderRadius: "20px 20px 0 0",
        boxShadow: "0 -8px 40px rgba(0,0,0,0.6)",
        maxHeight: "68vh",
        display: "flex",
        flexDirection: "column",
      }}>
        {/* Handle + header */}
        <div style={{ padding: "12px 20px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
            <div style={{ width: 36, height: 3, background: "#1e3a5f", borderRadius: 99 }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span style={{ color: "#e2e8f0", fontWeight: 800, fontSize: 14, letterSpacing: "-0.3px" }}>
              Analyse du trafic
            </span>
            <button onClick={onClose} style={{ color: "#475569", background: "none", border: "none", cursor: "pointer", padding: 4 }}>
              <ChevronDown size={18} />
            </button>
          </div>

          {/* KPIs */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
            {[
              { label: "Véhicules",  val: count,            color: "#93c5fd" },
              { label: "Vit. moy",   val: `${avgSpeed} km/h`, color: "#4ade80" },
              { label: "Vit. max",   val: `${maxSpeed} km/h`, color: "#60a5fa" },
              { label: "Accidents",  val: accidents.length, color: accidents.length > 0 ? "#f87171" : "#475569" },
            ].map((k, i) => (
              <div key={i} style={{
                background: "#0f172a", border: "1px solid #1e3a5f",
                borderRadius: 10, padding: "8px 6px", textAlign: "center",
              }}>
                <div style={{ fontSize: 15, fontWeight: 900, color: k.color, fontVariantNumeric: "tabular-nums" }}>{k.val}</div>
                <div style={{ fontSize: 9, color: "#475569", marginTop: 3, textTransform: "uppercase", letterSpacing: "0.08em" }}>{k.label}</div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #1e3a5f", paddingBottom: 0 }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "6px 12px", fontSize: 11, fontWeight: 700,
                color: tab === t.id ? "#60a5fa" : "#475569",
                borderBottom: tab === t.id ? "2px solid #3b82f6" : "2px solid transparent",
                transition: "color 0.15s",
              }}>{t.label}</button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px 20px" }}>

          {/* ── TAB VITESSE ── */}
          {tab === "vitesse" && (
            <div>
              {/* Courbe vitesse moyenne */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                  Vitesse moyenne — {MAX_HISTORY}s glissantes
                </div>
                {speedHistory.length < 2 ? (
                  <div style={{ color: "#334155", fontSize: 11, textAlign: "center", padding: "20px 0" }}>
                    En attente de données…
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={120}>
                    <LineChart data={speedHistory} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" vertical={false} />
                      <XAxis dataKey="t" tick={{ fontSize: 9, fill: "#475569" }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: "#475569" }} tickLine={false} axisLine={false} domain={[0, "auto"]} />
                      <Tooltip content={<ChartTooltip />} />
                      <ReferenceLine y={50} stroke="#eab30840" strokeDasharray="4 4" />
                      <Line type="monotone" dataKey="avg" stroke="#3b82f6" strokeWidth={2}
                        dot={false} name="Moy." isAnimationActive={false} />
                      <Line type="monotone" dataKey="max" stroke="#f87171" strokeWidth={1.5}
                        dot={false} name="Max" strokeDasharray="4 4" isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
                <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 10, color: "#475569" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 16, height: 2, background: "#3b82f6", display: "inline-block", borderRadius: 1 }} /> Vitesse moy.
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 16, height: 2, background: "#f87171", display: "inline-block", borderRadius: 1 }} /> Vitesse max
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 16, height: 1, background: "#eab308", display: "inline-block", borderRadius: 1 }} /> 50 km/h
                  </span>
                </div>
              </div>

              {/* Distribution */}
              <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                Distribution
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {SPEED_BANDS.slice(0, 5).map((b, i) => {
                  const c = Object.values(vehicles).filter(v => {
                    const s = v.speed ?? 0;
                    const prev = SPEED_BANDS[i - 1]?.max ?? -1;
                    return s > prev && s <= b.max;
                  }).length;
                  const pct = count > 0 ? c / count : 0;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 40, fontSize: 9, color: "#475569", fontFamily: "monospace", flexShrink: 0 }}>{b.label}</span>
                      <div style={{ flex: 1, background: "#0f172a", borderRadius: 99, height: 6, overflow: "hidden" }}>
                        <div style={{ width: `${pct * 100}%`, height: "100%", background: b.color, borderRadius: 99, transition: "width 0.5s" }} />
                      </div>
                      <span style={{ width: 18, fontSize: 9, color: b.color, fontFamily: "monospace", textAlign: "right" }}>{c}</span>
                    </div>
                  );
                })}
              </div>

              {/* Légende couleurs compacte */}
              <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
                {SPEED_BANDS.map((b, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, background: "#0f172a", borderRadius: 6, padding: "5px 8px" }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: b.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 9, color: "#94a3b8" }}>{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── TAB PREDICTION ── */}
          {tab === "prediction" && (
            <div>
              {predictions.length === 0 ? (
                <div style={{ color: "#334155", fontSize: 11, textAlign: "center", padding: "32px 0" }}>
                  Aucune prédiction disponible — le modèle IA se charge au bout de 60 steps
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
                    Vitesses prédites par tronçon
                  </div>
                  <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={predictions.slice().reverse().slice(0, MAX_HISTORY)} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" vertical={false} />
                      <XAxis dataKey="segment_id" tick={false} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: "#475569" }} tickLine={false} axisLine={false} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0]?.payload;
                        return (
                          <div style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", fontSize: 11 }}>
                            <div style={{ color: "#94a3b8", marginBottom: 3, fontSize: 9, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>{d?.segment_id}</div>
                            <div style={{ color: "#a78bfa", fontWeight: 700 }}>Prédit: {Math.round(d?.predicted_speed ?? 0)} km/h</div>
                            <div style={{ color: "#64748b", fontSize: 9 }}>Confiance: {Math.round((d?.confidence_score ?? 0) * 100)}%</div>
                          </div>
                        );
                      }} />
                      <Line type="monotone" dataKey="predicted_speed" stroke="#a78bfa" strokeWidth={2}
                        dot={{ fill: "#a78bfa", r: 3 }} name="Prédit" isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                  <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 4 }}>
                    {predictions.slice(0, 5).map((p, i) => {
                      const s = p.predicted_speed ?? 0;
                      const horizon = p.prediction_horizon === "short" ? "10 min" : p.prediction_horizon === "medium" ? "30 min" : "1h";
                      return (
                        <div key={i} style={{
                          background: "#0f172a", border: "1px solid #1e3a5f",
                          borderRadius: 8, padding: "8px 12px",
                          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                        }}>
                          <span style={{ fontSize: 9, color: "#475569", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {(p.segment_id || "").slice(0, 22)}
                          </span>
                          <span style={{ fontSize: 11, fontWeight: 800, color: speedColor(s), flexShrink: 0 }}>{Math.round(s)} km/h</span>
                          <span style={{ fontSize: 9, color: "#334155", flexShrink: 0 }}>dans {horizon}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── TAB ACCIDENTS ── */}
          {tab === "accidents" && (
            <div>
              {accidents.length === 0 ? (
                <div style={{ color: "#334155", fontSize: 11, textAlign: "center", padding: "32px 0" }}>
                  Aucun accident dans ce scénario
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {Object.entries(pedestrians).map(([pid, p]) => (
          <Marker key={pid} position={[p.lat, p.lng]}
            icon={createPedestrianIcon()} zIndexOffset={500}>
            <Popup>
              <div style={{fontFamily:"sans-serif",fontSize:11}}>
                <div style={{fontWeight:700,color:"#06b6d4",marginBottom:3}}>{pid}</div>
                <div style={{color:"#6b7280"}}>{Math.round(p.speed||0)} km/h</div>
              </div>
            </Popup>
          </Marker>
        ))}
        {accidents.map((acc, idx) => {
                    const m = ACCIDENT_META[acc.cause] || ACCIDENT_META.inconnu;
                    const blocked = acc.blocked_count || 0;
                    return (
                      <div key={acc.id || idx} style={{
                        background: "#0f172a", border: "1px solid #1e3a5f",
                        borderRadius: 10, padding: "12px 14px",
                        borderLeft: `3px solid ${m.bg}`,
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                          <div style={{
                            width: 28, height: 28, borderRadius: "50%", background: m.bg,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            color: "white", fontWeight: 900, fontSize: 12, fontFamily: "monospace", flexShrink: 0,
                          }}>{m.sym}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{m.label}</div>
                            <div style={{ fontSize: 9, color: "#475569", fontFamily: "monospace", marginTop: 1 }}>{acc.id || `accident_${idx}`}</div>
                          </div>
                          {blocked > 0 && (
                            <div style={{
                              background: "#7f1d1d", color: "#fca5a5", fontSize: 10, fontWeight: 700,
                              padding: "2px 8px", borderRadius: 99, flexShrink: 0,
                            }}>{blocked} bloqué{blocked > 1 ? "s" : ""}</div>
                          )}
                        </div>
                        {(acc.blocked_ids || []).length > 0 && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                            {acc.blocked_ids.slice(0, 5).map(vid => (
                              <span key={vid} style={{ fontSize: 9, background: "#1e293b", color: "#64748b", padding: "2px 6px", borderRadius: 4, fontFamily: "monospace" }}>{vid}</span>
                            ))}
                            {blocked > 5 && <span style={{ fontSize: 9, color: "#334155" }}>+{blocked - 5} autres</span>}
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: "#334155", marginTop: 6 }}>
                          {Number(acc.lat || 0).toFixed(5)}, {Number(acc.lng || 0).toFixed(5)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── TAB ALERTES ── */}
          {tab === "alertes" && (
            <div>
              {alerts.length === 0 ? (
                <div style={{ color: "#334155", fontSize: 11, textAlign: "center", padding: "32px 0" }}>
                  Aucune alerte
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {alerts.map((a) => {
                    const isCrit = a.severity === "critical" || a.risk_level === "critical";
                    return (
                      <div key={a._id} style={{
                        background: "#0f172a",
                        border: `1px solid ${isCrit ? "#7f1d1d" : "#1e3a5f"}`,
                        borderLeft: `3px solid ${isCrit ? "#ef4444" : "#f97316"}`,
                        borderRadius: 10, padding: "10px 12px",
                        display: "flex", alignItems: "flex-start", gap: 10,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: isCrit ? "#fca5a5" : "#fdba74", marginBottom: 3 }}>
                            {a.title || "Alerte"}
                          </div>
                          <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.4 }}>
                            {a.message || "—"}
                          </div>
                          {(a.vehicle_id || a.distance != null || a.current_speed != null) && (
                            <div style={{ display: "flex", gap: 10, marginTop: 5, flexWrap: "wrap" }}>
                              {a.vehicle_id && <span style={{ fontSize: 9, color: "#475569", fontFamily: "monospace" }}>{a.vehicle_id}</span>}
                              {a.distance != null && <span style={{ fontSize: 9, color: "#475569" }}>{Math.round(a.distance)} m</span>}
                              {a.current_speed != null && <span style={{ fontSize: 9, color: speedColor(a.current_speed), fontWeight: 700 }}>{Math.round(a.current_speed)} km/h</span>}
                            </div>
                          )}
                          <div style={{ fontSize: 9, color: "#334155", marginTop: 4 }}>
                            {new Date(a.timestamp || Date.now()).toLocaleTimeString("fr-FR")}
                          </div>
                        </div>
                        {onDismissAlert && (
                          <button onClick={() => onDismissAlert(a._id)} style={{
                            background: "none", border: "none", color: "#334155",
                            cursor: "pointer", padding: 2, flexShrink: 0,
                          }}>
                            <X size={13} />
                          </button>
                        )}
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
   BARRE LATÉRALE SIMULATION (apparaît seulement quand running)
═══════════════════════════════════════════════════════════════ */
const SimSidebar = ({
  running, vehicles, trackedVehicleId, followMode,
  onToggleFollow, onClearTracking, onOpenScenario,
  onSetSpeed, onStop, onToggleVehicleList, showVehicleList,
}) => {
  const [expanded, setExpanded] = useState(false);
  const count = Object.keys(vehicles).length;

  if (!running) return null;

  return (
    <div style={{
      position: "absolute", right: 16, top: "50%", transform: "translateY(-50%)",
      zIndex: 1000,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      {/* Bouton principal — toggle */}
      <button onClick={() => setExpanded(e => !e)} style={{
        width: 42, height: 42, borderRadius: "50%",
        background: "#1e3a5f", border: "1px solid #2d5a8e",
        color: "#93c5fd", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        transition: "background 0.15s",
      }}>
        {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>

      {expanded && (
        <>
          {/* Vitesse simulation */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {[1, 2, 5].map(f => (
              <button key={f} onClick={() => {
                fetch(`${API_BASE}/simulation/step-delay`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ factor: f }),
                }).catch(() => {});
              }} style={{
                width: 42, height: 34, borderRadius: 8,
                background: "#0f172a", border: "1px solid #1e3a5f",
                color: "#60a5fa", fontSize: 10, fontWeight: 800,
                cursor: "pointer", transition: "background 0.12s",
              }}>×{f}</button>
            ))}
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: "#1e3a5f", margin: "2px 0" }} />

          {/* Suivre / libre */}
          <button onClick={onToggleFollow} title={followMode ? "Mode caméra auto" : "Caméra libre"} style={{
            width: 42, height: 36, borderRadius: 8,
            background: followMode && trackedVehicleId ? "#1e3a5f" : "#0f172a",
            border: `1px solid ${followMode && trackedVehicleId ? "#3b82f6" : "#1e3a5f"}`,
            color: followMode && trackedVehicleId ? "#60a5fa" : "#475569",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Eye size={14} />
          </button>

          {/* Liste véhicules */}
          <button onClick={onToggleVehicleList} title="Liste des véhicules" style={{
            width: 42, height: 36, borderRadius: 8,
            background: showVehicleList ? "#1e3a5f" : "#0f172a",
            border: "1px solid #1e3a5f",
            color: showVehicleList ? "#93c5fd" : "#475569",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <List size={14} />
          </button>

          {/* Scénario */}
          <button onClick={onOpenScenario} title="Changer de scénario" style={{
            width: 42, height: 36, borderRadius: 8,
            background: "#0f172a", border: "1px solid #1e3a5f",
            color: "#a78bfa", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Settings size={14} />
          </button>

          <div style={{ height: 1, background: "#1e3a5f", margin: "2px 0" }} />

          {/* Stop */}
          <button onClick={onStop} title="Arrêter la simulation" style={{
            width: 42, height: 36, borderRadius: 8,
            background: "#450a0a", border: "1px solid #7f1d1d",
            color: "#f87171", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Square size={14} />
          </button>
        </>
      )}

      {/* Badge véhicules */}
      {!expanded && (
        <div style={{
          background: "#0f172a", border: "1px solid #1e3a5f",
          borderRadius: 8, padding: "4px 0", textAlign: "center",
          fontSize: 10, color: "#60a5fa", fontWeight: 700, fontVariantNumeric: "tabular-nums",
        }}>{count}</div>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   SCENARIO PANEL
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
        fetch(`${API_BASE}/scenario/list`).then(r => r.json()),
        fetch(`${API_BASE}/scenario/active`).then(r => r.json()),
      ]);
      setScenarios(l.scenarios || []);
      setActiveId((l.scenarios || []).find(s => s.is_active)?.scenario_id || a.active || null);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const deploy = async (id) => {
    setDeploying(id);
    try {
      const r = await fetch(`${API_BASE}/scenario/select/${id}`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).detail);
      setActiveId(id); load(); onScenarioDeployed?.(id);
    } catch (e) { alert(`Erreur : ${e.message}`); }
    setDeploying(null);
  };

  const selectDefault = async () => {
    await fetch(`${API_BASE}/scenario/select-default`, { method: "POST" });
    setActiveId(null); load(); onScenarioDeployed?.("default");
  };

  const del = async (id) => {
    setDeleting(id); setConfirmDel(null);
    try {
      const r = await fetch(`${API_BASE}/scenario/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).detail);
      if (activeId === id) setActiveId(null);
      load();
    } catch (e) { alert(`Erreur : ${e.message}`); }
    setDeleting(null);
  };

  const fixRoutes = async () => {
    setFixingRoutes(true); setFixMessage(null);
    try {
      const r = await fetch(`${API_BASE}/scenario/fix-routes`, { method: "POST" });
      setFixMessage((await r.json()).message || "Routes régénérées");
    } catch (e) { setFixMessage(`Erreur : ${e.message}`); }
    setFixingRoutes(false);
  };

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 1200, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={onClose}>
      <div style={{
        width: "100%", maxWidth: 480,
        background: "#08111e", borderTop: "1px solid #1e3a5f",
        borderRadius: "20px 20px 0 0", maxHeight: "78vh",
        display: "flex", flexDirection: "column",
        boxShadow: "0 -8px 40px rgba(0,0,0,0.6)",
      }} onClick={e => e.stopPropagation()}>

        <div style={{ padding: "12px 20px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
            <div style={{ width: 36, height: 3, background: "#1e3a5f", borderRadius: 99 }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, borderBottom: "1px solid #1e3a5f", paddingBottom: 12 }}>
            <span style={{ color: "#e2e8f0", fontWeight: 800, fontSize: 14 }}>Scénarios</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={load} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer" }}><RefreshCw size={14} /></button>
              <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer" }}><X size={16} /></button>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {loading ? (
            <div style={{ color: "#334155", textAlign: "center", padding: "32px 0", fontSize: 12 }}>Chargement…</div>
          ) : scenarios.length === 0 ? (
            <div style={{ color: "#334155", textAlign: "center", padding: "32px 0", fontSize: 12 }}>
              Aucun scénario — créez-en un depuis la Vue Globale
            </div>
          ) : scenarios.map(sc => {
            const isActive = sc.scenario_id === activeId;
            const date = sc.generated_at
              ? new Date(sc.generated_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : "—";
            return (
              <div key={sc.scenario_id} style={{
                background: "#0f172a",
                border: `1px solid ${isActive ? "#2d5a8e" : "#1e3a5f"}`,
                borderRadius: 12, padding: "14px",
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: "#e2e8f0" }}>{sc.scenario_name || sc.scenario_id}</span>
                      {isActive && <span style={{ fontSize: 9, background: "#1e40af", color: "#93c5fd", padding: "1px 6px", borderRadius: 99, fontWeight: 700 }}>Actif</span>}
                    </div>
                    <div style={{ fontSize: 9, color: "#334155", fontFamily: "monospace", marginTop: 2 }}>{sc.scenario_id}</div>
                  </div>
                  <span style={{ fontSize: 9, color: "#334155" }}>{date}</span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 10 }}>
                  {[
                    { icon: "V", val: sc.vehicle_count ?? "—",    label: "Véhicules" },
                    { icon: "P", val: sc.pedestrian_count ?? "—", label: "Piétons"   },
                    { icon: "A", val: sc.accident_count ?? "—",   label: "Accidents" },
                  ].map((m, i) => (
                    <div key={i} style={{ background: "#0a1628", borderRadius: 8, padding: "6px 8px", textAlign: "center" }}>
                      <div style={{ fontSize: 12, fontWeight: 900, color: "#60a5fa" }}>{m.val}</div>
                      <div style={{ fontSize: 8, color: "#334155", marginTop: 2 }}>{m.label}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", gap: 6 }}>
                  {!isActive ? (
                    <button onClick={() => deploy(sc.scenario_id)} disabled={!!deploying} style={{
                      flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 11, fontWeight: 700,
                      background: "#1e3a5f", border: "1px solid #2d5a8e", color: "#93c5fd",
                      cursor: "pointer",
                    }}>
                      {deploying === sc.scenario_id ? "…" : "Utiliser"}
                    </button>
                  ) : (
                    <div style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 11, fontWeight: 700, textAlign: "center", color: "#60a5fa", background: "#0a1628", border: "1px solid #1e3a5f" }}>Actif</div>
                  )}
                  {confirmDel === sc.scenario_id ? (
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => del(sc.scenario_id)} style={{ padding: "8px 10px", borderRadius: 8, background: "#7f1d1d", border: "none", color: "#fca5a5", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                        {deleting === sc.scenario_id ? "…" : "Confirmer"}
                      </button>
                      <button onClick={() => setConfirmDel(null)} style={{ padding: "8px 10px", borderRadius: 8, background: "#1e293b", border: "none", color: "#94a3b8", fontSize: 11, cursor: "pointer" }}>
                        Annuler
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmDel(sc.scenario_id)} style={{
                      width: 34, borderRadius: 8, background: "#0f172a", border: "1px solid #1e3a5f",
                      color: "#334155", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 16px", borderTop: "1px solid #1e3a5f", flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {fixMessage && (
            <div style={{
              fontSize: 10, padding: "8px 12px", borderRadius: 8,
              background: fixMessage.startsWith("Erreur") ? "#450a0a" : "#052e16",
              border: `1px solid ${fixMessage.startsWith("Erreur") ? "#7f1d1d" : "#14532d"}`,
              color: fixMessage.startsWith("Erreur") ? "#fca5a5" : "#4ade80",
            }}>{fixMessage}</div>
          )}
          {activeId && (
            <button onClick={fixRoutes} disabled={fixingRoutes} style={{
              padding: "8px 0", borderRadius: 8, fontSize: 11, fontWeight: 700,
              background: "#1c1400", border: "1px solid #3d2e00", color: "#d97706",
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
              {fixingRoutes ? <><RefreshCw size={11} style={{ animation: "spin 1s linear infinite" }} /> Régénération…</> : "Corriger les routes (si 1 seul véhicule)"}
            </button>
          )}
          <div style={{
            background: !activeId ? "#0c1f3a" : "#0a1628",
            border: `1px solid ${!activeId ? "#2d5a8e" : "#1e3a5f"}`,
            borderRadius: 10, padding: "10px 14px",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0", display: "flex", alignItems: "center", gap: 6 }}>
                Fichiers par défaut
                {!activeId && <span style={{ fontSize: 9, background: "#1e40af", color: "#93c5fd", padding: "1px 6px", borderRadius: 99 }}>Actif</span>}
              </div>
              <div style={{ fontSize: 9, color: "#334155", fontFamily: "monospace", marginTop: 2 }}>maps/ (casa.net.xml…)</div>
            </div>
            {activeId && (
              <button onClick={selectDefault} style={{
                padding: "6px 12px", borderRadius: 8, fontSize: 10, fontWeight: 700,
                background: "#1e3a5f", border: "1px solid #2d5a8e", color: "#93c5fd", cursor: "pointer",
              }}>Utiliser</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   MAIN
═══════════════════════════════════════════════════════════════ */
const MapSolo = () => {
  const [allVehicles,       setAllVehicles]       = useState({});
  const [trackedVehicleId,  setTrackedVehicleId]  = useState(null);
  const [trackedVehicle,    setTrackedVehicle]    = useState(null);
  const [socketStatus,      setSocketStatus]      = useState("disconnected");
  const [running,           setRunning]           = useState(false);
  const [followMode,        setFollowMode]        = useState(true);
  const [allAlerts,         setAllAlerts]         = useState([]);
  const [predictions,       setPredictions]       = useState([]);
  const [accidents,         setAccidents]         = useState([]);
  const [pedestrians,       setPedestrians]       = useState({});
  const [speedHistory,      setSpeedHistory]      = useState([]);
  const [showVehicleList,   setShowVehicleList]   = useState(true);
  const [analysisOpen,      setAnalysisOpen]      = useState(false);
  const [scenarioPanelOpen, setScenarioPanelOpen] = useState(false);

  const trackedVehicleIdRef = useRef(null);
  const mountedRef          = useRef(false);
  const tickRef             = useRef(0);

  /* ── Socket ── */
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    socketService.connect();

    const onAllVehiclesState = (data) => {
      if (!data?.vehicles) return;
      setAllVehicles(data.vehicles);
      if (data.pedestrians) setPedestrians(data.pedestrians);
      const id = trackedVehicleIdRef.current;
      if (id && data.vehicles[id]) setTrackedVehicle({ id, ...data.vehicles[id] });

      // Historique vitesse
      const vals = Object.values(data.vehicles);
      if (vals.length > 0) {
        const avg = vals.reduce((s, v) => s + (v.speed ?? 0), 0) / vals.length;
        const max = Math.max(...vals.map(v => v.speed ?? 0));
        tickRef.current += 1;
        setSpeedHistory(h => {
          const next = [...h, { t: tickRef.current, avg: Math.round(avg * 10) / 10, max: Math.round(max * 10) / 10 }];
          return next.slice(-MAX_HISTORY);
        });
      }
    };

    const onVehicleState = (data) => {
      if (!data?.id || data.lat == null) return;
      setAllVehicles(p => ({ ...p, [data.id]: { lat: data.lat, lng: data.lng, speed: data.speed || 0, heading: data.heading || 0 } }));
      if (trackedVehicleIdRef.current === data.id)
        setTrackedVehicle({ id: data.id, lat: data.lat, lng: data.lng, speed: data.speed || 0, heading: data.heading || 0 });
    };

    const pushAlert = (data) => {
      const a = {
        ...data,
        _id: Date.now() + Math.random(),
        timestamp: data.timestamp || new Date().toISOString(),
        severity: data.risk_level || data.severity || "warning",
        title: data.title || "Alerte sécurité",
        message: data.message || `${data.vehicle_id || "Véhicule"} — risque détecté`,
      };
      setAllAlerts(prev => [a, ...prev].slice(0, 50));
    };

    const onSimStatus = (data) => {
      if (data.status === "started") {
        setRunning(true);
      } else if (data.status === "stopped") {
        setRunning(false);
        setAllVehicles({});
        setPedestrians({});
        setAccidents([]);
        setSpeedHistory([]);
        tickRef.current = 0;
        setTrackedVehicle(null);
        setTrackedVehicleId(null);
        trackedVehicleIdRef.current = null;
        setAllAlerts([]);
      }
    };

    socketService.on("connect",            () => setSocketStatus("connected"));
    socketService.on("disconnect",         () => { setSocketStatus("disconnected"); setRunning(false); });
    socketService.on("connect_error",      () => setSocketStatus("error"));
    socketService.on("all_vehicles_state", onAllVehiclesState);
    socketService.on("vehicle_state",      onVehicleState);
    socketService.on("emergency_alert",    pushAlert);
    socketService.on("road_alert",         d => pushAlert({ ...d, title: d.title || "Perturbation route" }));
    socketService.on("accident_alert",     d => pushAlert({ ...d, title: d.title || "Accident signalé", severity: "critical" }));
    socketService.on("accidents_state",    d => { if (d?.accidents) setAccidents(d.accidents); });
    socketService.on("collision_risk_alert", pushAlert);
    socketService.on("traffic_prediction", d => { if (d?.segment_id) setPredictions(p => [d, ...p].slice(0, 30)); });
    socketService.on("simulation_status",  onSimStatus);

    return () => {
      ["connect","disconnect","connect_error","all_vehicles_state","vehicle_state",
       "emergency_alert","road_alert","accident_alert","accidents_state",
       "collision_risk_alert","traffic_prediction","simulation_status",
      ].forEach(ev => socketService.off(ev));
      mountedRef.current = false;
    };
  }, []);

  /* ── Actions ── */
  const startSimulation = async () => {
    try {
      const r = await apiService.startSimulation();
      if (r.status === "started") {
        setRunning(true);
        setTimeout(async () => {
          try { await apiService.startJourney(); } catch {}
        }, 2000);
      }
    } catch (e) { console.error(e); }
  };

  const stopSimulation = async () => {
    try { await apiService.stopSimulation(); } catch {}
    setRunning(false); setAllVehicles({});
    setTrackedVehicle(null); setTrackedVehicleId(null);
    trackedVehicleIdRef.current = null;
  };

  const handleSelectVehicle = useCallback((id, v) => {
    setTrackedVehicleId(id);
    trackedVehicleIdRef.current = id;
    setTrackedVehicle({ id, ...v });
    setFollowMode(true);
  }, []);

  const handleClearTracking = useCallback(() => {
    setTrackedVehicleId(null);
    trackedVehicleIdRef.current = null;
    setTrackedVehicle(null);
  }, []);

  const dismissAlert = useCallback((id) => {
    setAllAlerts(p => p.filter(a => a._id !== id));
  }, []);

  /* ── Status badge ── */
  const statusLabel = socketStatus === "connected" ? "Connecté" : socketStatus === "error" ? "Erreur" : "Déconnecté";
  const statusColor = socketStatus === "connected" ? "#22c55e" : socketStatus === "error" ? "#ef4444" : "#475569";

  /* ─────────────────────────────────────────────────────────────
     RENDER
  ───────────────────────────────────────────────────────────── */
  return (
    <div style={{ height: "100%", width: "100%", position: "relative", background: "#08111e", overflow: "hidden" }}>

      {/* ══ NAVBAR fixe en haut ══ */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, zIndex: 1000,
        height: 52, background: "#08111eee", backdropFilter: "blur(12px)",
        borderBottom: "1px solid #1e3a5f",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 16px", gap: 12,
      }}>
        {/* Gauche : titre + status */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: "#e2e8f0", letterSpacing: "-0.4px", whiteSpace: "nowrap" }}>
            TMT Traffic
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 5, background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 20, padding: "3px 10px" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
            <span style={{ fontSize: 10, color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
          </div>
          {running && (
            <div style={{ fontSize: 10, color: "#60a5fa", background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 20, padding: "3px 10px", fontFamily: "monospace" }}>
              {Object.keys(allVehicles).length} véhicules
            </div>
          )}
          {trackedVehicle && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#0f172a", border: "1px solid #1e3a5f", borderRadius: 20, padding: "3px 10px" }}>
              <Eye size={10} color="#4ade80" />
              <span style={{ fontSize: 10, color: "#4ade80", fontFamily: "monospace" }}>{trackedVehicleId}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: speedColor(trackedVehicle.speed) }}>
                {Math.round(trackedVehicle.speed)} km/h
              </span>
              <button onClick={handleClearTracking} style={{ background: "none", border: "none", color: "#334155", cursor: "pointer", padding: 0, lineHeight: 1 }}>
                <X size={10} />
              </button>
            </div>
          )}
        </div>

        {/* Droite : démarrer / scénario */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button onClick={() => setScenarioPanelOpen(true)} style={{
            display: "flex", alignItems: "center", gap: 5,
            background: "#0f172a", border: "1px solid #1e3a5f",
            borderRadius: 8, padding: "6px 12px",
            fontSize: 11, fontWeight: 700, color: "#a78bfa", cursor: "pointer",
          }}>
            <Settings size={12} /> Scénario
          </button>

          {!running ? (
            <button onClick={startSimulation} style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "#1e40af", border: "1px solid #2563eb",
              borderRadius: 8, padding: "7px 16px",
              fontSize: 12, fontWeight: 800, color: "white", cursor: "pointer",
              boxShadow: "0 2px 12px #1e40af66",
            }}>
              <Play size={13} /> Démarrer
            </button>
          ) : (
            <button onClick={stopSimulation} style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "#450a0a", border: "1px solid #7f1d1d",
              borderRadius: 8, padding: "7px 16px",
              fontSize: 12, fontWeight: 800, color: "#f87171", cursor: "pointer",
            }}>
              <Square size={13} /> Arrêter
            </button>
          )}
        </div>
      </div>

      {/* ══ MAP ══ */}
      <MapContainer
        center={[33.5731, -7.5898]}
        zoom={13}
        style={{ height: "100%", width: "100%" }}
        zoomControl={false}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <CameraFollower
          position={trackedVehicle ? { lat: trackedVehicle.lat, lng: trackedVehicle.lng } : null}
          enabled={followMode && !!trackedVehicleId}
        />

        {/* Véhicules */}
        {Object.entries(allVehicles).map(([id, v]) => {
          const isTracked = id === trackedVehicleId;
          return (
            <Marker key={id} position={[v.lat, v.lng]}
              icon={isTracked ? createTrackedIcon(v.speed, v.heading) : createVehicleIcon(v.speed, v.heading)}
              eventHandlers={{ contextmenu: () => handleSelectVehicle(id, v) }}
            >
              <Popup>
                <div style={{ minWidth: 120, textAlign: "center", fontFamily: "sans-serif" }}>
                  <div style={{ fontWeight: 800, fontSize: 12, color: isTracked ? "#22c55e" : speedColor(v.speed), marginBottom: 4 }}>
                    {id}
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 16, color: speedColor(v.speed) }}>{Math.round(v.speed)} km/h</div>
                  <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>Cap: {Math.round(v.heading || 0)}°</div>
                  <button onClick={() => handleSelectVehicle(id, v)} style={{
                    marginTop: 8, width: "100%", padding: "5px 0", borderRadius: 6,
                    background: "#1e40af", border: "none", color: "white",
                    fontSize: 10, fontWeight: 700, cursor: "pointer",
                  }}>{isTracked ? "Suivi actif" : "Suivre"}</button>
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* Accidents */}
        {accidents.map((acc, idx) => {
          const cause = acc.cause || "inconnu";
          const m = ACCIDENT_META[cause] || ACCIDENT_META.inconnu;
          const blocked = acc.blocked_count || 0;
          return (
            <Marker key={acc.id || `acc_${idx}`} position={[acc.lat, acc.lng]}
              icon={createAccidentIcon(cause, blocked)} zIndexOffset={1000}
            >
              <Popup minWidth={200}>
                <div style={{ fontFamily: "sans-serif", fontSize: 12 }}>
                  <div style={{ background: m.bg, color: "white", borderRadius: 6, padding: "6px 10px", fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 900 }}>{m.sym}</span> {m.label}
                  </div>
                  <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6 }}>{acc.id || `accident_${idx}`}</div>
                  <div style={{
                    background: blocked > 0 ? "#fef2f2" : "#f0fdf4",
                    border: `1px solid ${blocked > 0 ? "#fca5a5" : "#86efac"}`,
                    borderRadius: 6, padding: "6px 8px", marginBottom: 6,
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 11, color: blocked > 0 ? "#dc2626" : "#16a34a" }}>
                      {blocked > 0 ? `${blocked} véhicule${blocked > 1 ? "s" : ""} bloqué${blocked > 1 ? "s" : ""}` : "Circulation fluide"}
                    </div>
                    {(acc.blocked_ids || []).slice(0, 4).map(vid => (
                      <div key={vid} style={{ fontSize: 10, color: "#6b7280", marginTop: 2, fontFamily: "monospace" }}>{vid}</div>
                    ))}
                  </div>
                  <div style={{ fontSize: 9, color: "#9ca3af" }}>{Number(acc.lat).toFixed(5)}, {Number(acc.lng).toFixed(5)}</div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* ══ SIDEBAR simulation (uniquement quand running) ══ */}
      <SimSidebar
        running={running}
        vehicles={allVehicles}
        trackedVehicleId={trackedVehicleId}
        followMode={followMode}
        onToggleFollow={() => setFollowMode(f => !f)}
        onClearTracking={handleClearTracking}
        onOpenScenario={() => setScenarioPanelOpen(true)}
        onStop={stopSimulation}
        onToggleVehicleList={() => setShowVehicleList(s => !s)}
        showVehicleList={showVehicleList}
      />

      {/* ══ VEHICLE LIST (panneau gauche léger) ══ */}
      {running && showVehicleList && !analysisOpen && (
        <div style={{
          position: "absolute", top: 64, left: 12, zIndex: 1000,
          background: "#08111eee", backdropFilter: "blur(8px)",
          border: "1px solid #1e3a5f", borderRadius: 12,
          width: 200, maxHeight: 320, overflow: "hidden",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{ padding: "8px 12px 6px", borderBottom: "1px solid #1e3a5f", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Véhicules ({Object.keys(allVehicles).length})
            </span>
            <button onClick={() => setShowVehicleList(false)} style={{ background: "none", border: "none", color: "#334155", cursor: "pointer" }}>
              <X size={12} />
            </button>
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {Object.entries(allVehicles).length === 0 ? (
              <div style={{ padding: "16px 12px", color: "#334155", fontSize: 10, textAlign: "center" }}>Aucun véhicule</div>
            ) : Object.entries(allVehicles).map(([id, v]) => (
              <button key={id} onClick={() => handleSelectVehicle(id, v)} style={{
                width: "100%", textAlign: "left", display: "flex", alignItems: "center",
                justifyContent: "space-between", padding: "7px 12px",
                background: trackedVehicleId === id ? "#0c1f3a" : "transparent",
                border: "none", borderBottom: "1px solid #1e3a5f10",
                cursor: "pointer", gap: 8,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: speedColor(v.speed), flexShrink: 0 }} />
                  <span style={{ fontSize: 10, fontFamily: "monospace", color: "#cbd5e1" }}>{id}</span>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, color: speedColor(v.speed), fontFamily: "monospace" }}>{Math.round(v.speed)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ══ BOUTON ANALYSE — fixe en bas au-dessus du footer ══ */}
      {!analysisOpen && (
        <div style={{
          position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
          zIndex: 1000,
        }}>
          <button onClick={() => setAnalysisOpen(true)} style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "#08111e", border: "1px solid #2d5a8e",
            borderRadius: 24, padding: "10px 24px",
            fontSize: 12, fontWeight: 700, color: "#93c5fd",
            cursor: "pointer", boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
            backdropFilter: "blur(8px)",
          }}>
            <ChevronUp size={15} />
            Analyse du trafic
            {allAlerts.length > 0 && (
              <span style={{
                background: "#7f1d1d", color: "#fca5a5",
                fontSize: 9, fontWeight: 800, padding: "1px 6px", borderRadius: 99,
              }}>{allAlerts.length}</span>
            )}
          </button>
        </div>
      )}

      {/* ══ PANNEAU ANALYSE ══ */}
      <AnalysisPanel
        open={analysisOpen}
        onClose={() => setAnalysisOpen(false)}
        vehicles={allVehicles}
        pedestrians={pedestrians}
        accidents={accidents}
        alerts={allAlerts}
        predictions={predictions}
        speedHistory={speedHistory}
        onDismissAlert={dismissAlert}
      />

      {/* Overlay sombre drawer */}
      {analysisOpen && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1050 }}
          onClick={() => setAnalysisOpen(false)} />
      )}

      {/* ══ SCENARIO PANEL ══ */}
      {scenarioPanelOpen && (
        <ScenarioPanel
          onClose={() => setScenarioPanelOpen(false)}
          onScenarioDeployed={(id) => { setScenarioPanelOpen(false); }}
        />
      )}
    </div>
  );
};

export default MapSolo;