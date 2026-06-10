// frontend/src/components/screens/Historique.jsx
import React, { useState, useEffect, useCallback, useMemo, memo } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Clock, MapPin, Route, RefreshCw, Navigation,
  TrendingUp, AlertTriangle, Brain, Download, X,
  ChevronDown, ChevronUp, Filter, Calendar, Gauge,
} from "lucide-react";
import "leaflet/dist/leaflet.css";
import apiService from "../../services/api";

/* ─── Leaflet fix ─────────────────────────────────── */
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:       "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:     "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

/* ─── Design tokens ───────────────────────────────── */
const T = {
  bg0:    "#05090f",
  bg1:    "#08111e",
  bg2:    "#0f172a",
  bg3:    "#1e293b",
  border: "#1e3a5f",
  accent: "#3b82f6",
  cyan:   "#06b6d4",
  green:  "#22c55e",
  orange: "#f97316",
  red:    "#ef4444",
  purple: "#a78bfa",
  yellow: "#eab308",
  text:   "#e2e8f0",
  muted:  "#475569",
  dim:    "#334155",
};

/* ─── Helpers ─────────────────────────────────────── */
const speedColor = (s = 0) => {
  if (s <= 1)  return T.muted;
  if (s <= 10) return T.red;
  if (s <= 30) return T.orange;
  if (s <= 50) return T.yellow;
  if (s <= 80) return T.green;
  return T.accent;
};

const fmtDate = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
};

const fmtDuration = (start, end) => {
  if (!start || !end) return "—";
  const s = Math.max(0, Math.floor((new Date(end) - new Date(start)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return `${m} min ${r}s`;
};

const fmtDist = (positions) => {
  let d = 0;
  for (let i = 1; i < positions.length; i++) {
    const [la1, lo1] = positions[i - 1], [la2, lo2] = positions[i];
    const R = 6371;
    const dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dLa/2)**2 + Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;
    d += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return d;
};

/* ─── Leaflet icons ───────────────────────────────── */
const dotIcon = (color) => L.divIcon({
  className: "",
  html: `<div style="width:8px;height:8px;border-radius:50%;background:${color};border:2px solid #08111e"></div>`,
  iconSize: [8, 8], iconAnchor: [4, 4],
});

const endpointIcon = (color, label) => L.divIcon({
  className: "",
  html: `<div style="background:${color};color:white;border-radius:50%;width:26px;height:26px;
               display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;
               border:2px solid #08111e;box-shadow:0 2px 8px ${color}66">${label}</div>`,
  iconSize: [26, 26], iconAnchor: [13, 13],
});

/* ─── FitBounds ───────────────────────────────────── */
const FitBounds = ({ positions }) => {
  const map = useMap();
  useEffect(() => {
    if (positions?.length > 1) {
      try { map.fitBounds(positions, { padding: [40, 40] }); } catch {}
    }
  }, [positions, map]);
  return null;
};

/* ─── Tooltip recharts ────────────────────────────── */
const ChartTip = ({ active, payload, label, unit = "km/h" }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: "7px 12px", fontSize: 11 }}>
      <div style={{ color: T.muted, marginBottom: 4 }}>Étape {label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontWeight: 700 }}>{p.name}: {Math.round(p.value)} {unit}</div>
      ))}
    </div>
  );
};

/* ─── KPI mini ────────────────────────────────────── */
const KpiMini = ({ label, value, color }) => (
  <div style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 14px", textAlign: "center" }}>
    <div style={{ fontSize: 18, fontWeight: 900, color: color || T.text, fontVariantNumeric: "tabular-nums" }}>{value ?? "—"}</div>
    <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 4 }}>{label}</div>
  </div>
);

/* ─── Export image PNG ────────────────────────────── */
const loadHtml2Canvas = () =>
  window.html2canvas
    ? Promise.resolve()
    : new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });

/* Projette des coordonnées GPS vers un canvas SVG (Mercator simple) */
const gpsToSvg = (lat, lng, bounds, W, H, pad = 20) => {
  const { minLat, maxLat, minLng, maxLng } = bounds;
  const x = pad + ((lng - minLng) / (maxLng - minLng)) * (W - pad * 2);
  const y = pad + (1 - (lat - minLat) / (maxLat - minLat)) * (H - pad * 2);
  return { x, y };
};

const buildMapSvg = (positions, steps, W = 836, H = 280) => {
  if (positions.length < 2) return "";
  const lats = positions.map(p => p[0]);
  const lngs = positions.map(p => p[1]);
  const bounds = {
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
    minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
  };
  // Padding proportionnel pour ne pas coller les bords
  const dLat = bounds.maxLat - bounds.minLat || 0.001;
  const dLng = bounds.maxLng - bounds.minLng || 0.001;
  bounds.minLat -= dLat * 0.12; bounds.maxLat += dLat * 0.12;
  bounds.minLng -= dLng * 0.12; bounds.maxLng += dLng * 0.12;

  const speedC = s => {
    if (!s || s <= 1) return "#475569";
    if (s <= 10) return "#ef4444";
    if (s <= 30) return "#f97316";
    if (s <= 50) return "#eab308";
    if (s <= 80) return "#22c55e";
    return "#3b82f6";
  };

  // Segments colorés
  const segs = positions.slice(1).map((_, i) => {
    const a = gpsToSvg(positions[i][0],   positions[i][1],   bounds, W, H);
    const b = gpsToSvg(positions[i+1][0], positions[i+1][1], bounds, W, H);
    const c = speedC(steps[i+1]?.speed || 0);
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/>`;
  }).join("");

  // Marqueurs départ / arrivée
  const A = gpsToSvg(positions[0][0], positions[0][1], bounds, W, H);
  const B = gpsToSvg(positions[positions.length-1][0], positions[positions.length-1][1], bounds, W, H);
  const markers = `
    <circle cx="${A.x.toFixed(1)}" cy="${A.y.toFixed(1)}" r="8" fill="#22c55e" stroke="#05090f" stroke-width="2"/>
    <text x="${A.x.toFixed(1)}" y="${(A.y+4).toFixed(1)}" text-anchor="middle" fill="white" font-size="9" font-weight="900" font-family="system-ui">A</text>
    <circle cx="${B.x.toFixed(1)}" cy="${B.y.toFixed(1)}" r="8" fill="#ef4444" stroke="#05090f" stroke-width="2"/>
    <text x="${B.x.toFixed(1)}" y="${(B.y+4).toFixed(1)}" text-anchor="middle" fill="white" font-size="9" font-weight="900" font-family="system-ui">B</text>`;

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"
    style="border-radius:10px;background:#0f172a;border:1px solid #1e3a5f">
    <rect width="${W}" height="${H}" fill="#0f172a" rx="10"/>
    ${segs}${markers}
  </svg>`;
};

/* Clone les SVG Recharts visibles dans un conteneur DOM */
const cloneChartsSvg = (containerEl) => {
  if (!containerEl) return [];
  const charts = [];
  containerEl.querySelectorAll(".recharts-wrapper svg").forEach(svg => {
    const clone = svg.cloneNode(true);
    // Forcer les couleurs de texte (les classes CSS ne suivent pas hors contexte)
    clone.querySelectorAll("text").forEach(t => {
      if (!t.getAttribute("fill") || t.getAttribute("fill") === "currentColor")
        t.setAttribute("fill", "#94a3b8");
    });
    clone.querySelectorAll(".recharts-cartesian-grid line").forEach(l => l.setAttribute("stroke", "#1e3a5f"));
    const w = svg.getAttribute("width")  || svg.getBoundingClientRect().width  || 400;
    const h = svg.getAttribute("height") || svg.getBoundingClientRect().height || 120;
    clone.setAttribute("width",  w);
    clone.setAttribute("height", h);
    charts.push({ svgStr: clone.outerHTML, w: +w, h: +h });
  });
  return charts;
};

const exportImage = async (journey, stats, detailEl) => {
  try {
    await loadHtml2Canvas();

    const bg0 = "#05090f", bg2 = "#0f172a", border = "#1e3a5f";
    const muted = "#475569", dim = "#334155";
    const green = "#22c55e", cyan = "#06b6d4", accent = "#3b82f6", orange = "#f97316";

    const wrap = document.createElement("div");
    wrap.style.cssText = [
      "position:fixed","top:-9999px","left:-9999px",
      "width:900px","padding:32px",
      `background:${bg0}`,"color:#e2e8f0",
      "font-family:system-ui,-apple-system,sans-serif",
    ].join(";");
    document.body.appendChild(wrap);

    // ── En-tête ──────────────────────────────────────────────────
    const done = journey.status === "completed";
    wrap.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;
                  margin-bottom:22px;padding-bottom:16px;border-bottom:1px solid ${border}">
        <div>
          <div style="font-size:18px;font-weight:900;letter-spacing:-0.5px;color:#e2e8f0">
            TMT Traffic — Analyse de trajet
          </div>
          <div style="font-size:11px;color:${muted};margin-top:3px;font-family:monospace">
            ${journey.journey_id}
          </div>
        </div>
        <div style="text-align:right;font-size:10px;color:${muted}">
          <div>${new Date(journey.start_time||Date.now()).toLocaleString("fr-FR")}</div>
          <div style="margin-top:2px">Casablanca · SUMO Simulation</div>
          <div style="margin-top:4px;display:inline-flex;align-items:center;gap:5px;
                      background:${done?"#052e16":"#0c1f3a"};color:${done?green:cyan};
                      border:1px solid ${done?"#166534":"#1e3a5f"};
                      border-radius:99px;padding:2px 10px;font-size:9px;font-weight:700">
            ${done?"Trajet terminé":"En cours"}
          </div>
        </div>
      </div>`;

    // ── KPIs ─────────────────────────────────────────────────────
    const kpis = [
      { label:"Distance",     val: stats.dist ? `${stats.dist} km`  : "—", color:cyan    },
      { label:"Vit. moyenne", val: stats.avg  ? `${stats.avg} km/h` : "—", color:green   },
      { label:"Vit. max",     val: stats.max  ? `${stats.max} km/h` : "—", color:"#ef4444"},
      { label:"Vit. min",     val: stats.min  ? `${stats.min} km/h` : "—", color:green   },
      { label:"Étapes GPS",   val: stats.steps ?? "—",                      color:muted   },
      { label:"Anomalies",    val: stats.anoms ?? 0, color:(stats.anoms??0)>0?orange:green},
    ].map(k=>`
      <div style="background:${bg2};border:1px solid ${border};border-radius:10px;
                  padding:12px 10px;text-align:center">
        <div style="font-size:20px;font-weight:900;color:${k.color};
                    font-variant-numeric:tabular-nums">${k.val}</div>
        <div style="font-size:9px;color:${muted};text-transform:uppercase;
                    letter-spacing:0.07em;margin-top:5px">${k.label}</div>
      </div>`).join("");

    wrap.innerHTML += `
      <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:20px">
        ${kpis}
      </div>`;

    // ── Carte SVG ────────────────────────────────────────────────
    const mapSvg = buildMapSvg(stats.positions || [], stats.stepsFull || []);
    if (mapSvg) {
      wrap.innerHTML += `
        <div style="margin-bottom:16px">
          <div style="font-size:9px;font-weight:700;color:${muted};text-transform:uppercase;
                      letter-spacing:0.07em;margin-bottom:8px">Trajectoire</div>
          ${mapSvg}
        </div>`;

      // Légende vitesse
      const legend = [
        ["Arrêt","#475569"],["< 30 km/h","#f97316"],
        ["30–50","#eab308"],["50–80","#22c55e"],["> 80","#3b82f6"],
      ].map(([l,c])=>`
        <span style="display:inline-flex;align-items:center;gap:5px;font-size:9px;color:${muted}">
          <span style="width:16px;height:3px;background:${c};display:inline-block;border-radius:2px"></span>${l}
        </span>`).join("");
      wrap.innerHTML += `
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px;
                    padding:8px 12px;background:${bg2};border:1px solid ${border};border-radius:8px">
          ${legend}
        </div>`;
    }

    // ── Graphes Recharts (clonés depuis le DOM) ──────────────────
    const charts = cloneChartsSvg(detailEl);
    if (charts.length > 0) {
      wrap.innerHTML += `
        <div style="margin-bottom:16px">
          <div style="font-size:9px;font-weight:700;color:${muted};text-transform:uppercase;
                      letter-spacing:0.07em;margin-bottom:10px">Graphes d'analyse</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            ${charts.map(c=>`
              <div style="background:${bg2};border:1px solid ${border};border-radius:10px;
                          padding:12px;overflow:hidden">
                ${c.svgStr}
              </div>`).join("")}
          </div>
        </div>`;
    }

    // ── Anomalies ────────────────────────────────────────────────
    const anomalies = journey.anomalies || [];
    if (anomalies.length > 0) {
      const rows = anomalies.slice(0,8).map(a=>`
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:7px 12px;border-bottom:1px solid ${border}10;
                    font-size:9px;font-family:monospace">
          <span style="color:${orange};font-weight:700">${(a.segment_id||"").slice(0,24)}</span>
          ${a.expected_value!=null&&a.actual_value!=null
            ? `<span style="color:${muted}">prévu ${a.expected_value.toFixed(1)} → réel ${a.actual_value.toFixed(1)} km/h</span>`
            : ""}
          <span style="background:${a.severity==="high"?"#7f1d1d":"#3d2000"};
                       color:${a.severity==="high"?"#fca5a5":"#fdba74"};
                       padding:1px 7px;border-radius:99px;font-size:8px;font-weight:700">
            ${a.severity||"medium"}
          </span>
        </div>`).join("");
      wrap.innerHTML += `
        <div style="margin-bottom:16px">
          <div style="font-size:9px;font-weight:700;color:${orange};text-transform:uppercase;
                      letter-spacing:0.07em;margin-bottom:8px">
            Anomalies détectées (${anomalies.length})
          </div>
          <div style="background:${bg2};border:1px solid ${border};border-radius:10px;overflow:hidden">
            ${rows}
          </div>
        </div>`;
    }

    // ── Footer ───────────────────────────────────────────────────
    wrap.innerHTML += `
      <div style="margin-top:16px;padding-top:12px;border-top:1px solid ${border};
                  display:flex;justify-content:space-between;font-size:9px;color:${dim}">
        <span>Généré le ${new Date().toLocaleString("fr-FR")}</span>
        <span>TMT Traffic Control · Casablanca · ${journey.journey_id}</span>
      </div>`;

    const canvas = await window.html2canvas(wrap, {
      useCORS: true, allowTaint: true,
      backgroundColor: bg0, scale: 2, logging: false,
      width: 900,
    });
    document.body.removeChild(wrap);

    const a = Object.assign(document.createElement("a"), {
      href:     canvas.toDataURL("image/png"),
      download: `trajet_${journey.journey_id}.png`,
    });
    a.click();
  } catch (err) {
    console.error("Export PNG:", err);
    alert("Export PNG échoué — " + err.message);
  }
};


/* ══════════════════════════════════════════════════
   TRAJECTORY DETAIL
══════════════════════════════════════════════════ */
const TrajectoryDetail = memo(({ journey, exportRef }) => {
  const steps      = journey?.steps       ?? [];
  const anomalies  = journey?.anomalies   ?? [];
  const predictions = journey?.predictions ?? [];

  const positions = useMemo(
    () => steps.filter(s => s.coords?.lat && s.coords?.lng).map(s => [s.coords.lat, s.coords.lng]),
    [steps]
  );
  const speeds  = steps.map(s => s.speed || 0).filter(s => s > 0);
  const avg     = speeds.length ? +(speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1) : 0;
  const max     = speeds.length ? +Math.max(...speeds).toFixed(1) : 0;
  const min     = speeds.length ? +Math.min(...speeds).toFixed(1) : 0;
  const dist    = positions.length > 1 ? fmtDist(positions).toFixed(2) : "—";

  /* Données courbe vitesse — 1 point toutes les 5 étapes */
  const speedSeries = useMemo(() =>
    steps
      .filter((_, i) => i % 5 === 0)
      .map((s, i) => ({ i: i * 5, speed: +(s.speed || 0).toFixed(1) })),
    [steps]
  );

  /* Distribution vitesses */
  const distrib = useMemo(() => {
    const bands = [
      { label: "Arrêt",  max: 1,        fill: T.muted   },
      { label: "< 30",   max: 30,       fill: T.orange  },
      { label: "30–50",  max: 50,       fill: T.yellow  },
      { label: "50–80",  max: 80,       fill: T.green   },
      { label: "> 80",   max: Infinity, fill: T.accent  },
    ];
    return bands.map((b, i) => ({
      ...b,
      count: speeds.filter(s => {
        const prev = bands[i - 1]?.max ?? -1;
        return s > prev && s <= b.max;
      }).length,
    }));
  }, [speeds]);

  /* Polylines colorées par vitesse */
  const coloredSegments = useMemo(() => {
    const segs = [];
    for (let i = 1; i < positions.length; i++) {
      segs.push({ pos: [positions[i-1], positions[i]], color: speedColor(steps[i]?.speed || 0) });
    }
    return segs;
  }, [positions, steps]);

  // Stats exportables
  const exportStats = {
    dist, avg, max, min,
    dur:      steps.length > 0 ? `${steps.length} pts` : "—",
    steps:    steps.length,
    anoms:    (journey?.anomalies ?? []).length,
    positions,          // pour la carte SVG
    stepsFull: steps,   // pour les couleurs de segments
  };

  if (positions.length < 2) return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: "32px", textAlign: "center", color: T.muted, fontSize: 11 }}>
      <MapPin size={24} style={{ margin: "0 auto 8px", color: T.dim }} />
      Pas assez de données GPS ({positions.length} point{positions.length > 1 ? "s" : ""})
    </div>
  );

  return (
    <div ref={exportRef} style={{ display: "flex", flexDirection: "column", gap: 14 }}>

      {/* KPIs trajet */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        <KpiMini label="Distance"    value={`${dist} km`}  color={T.cyan}   />
        <KpiMini label="Vit. moy."   value={`${avg} km/h`} color={speedColor(avg)} />
        <KpiMini label="Vit. max"    value={`${max} km/h`} color={T.red}    />
        <KpiMini label="Vit. min"    value={`${min} km/h`} color={T.green}  />
      </div>

      {/* Bouton export PNG */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          onClick={() => exportImage(journey, exportStats, exportRef?.current)}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "#0c1f3a", border: `1px solid ${T.accent}55`,
            borderRadius: 8, padding: "7px 14px",
            fontSize: 11, fontWeight: 700, color: T.accent, cursor: "pointer",
          }}
        >
          <Download size={12} /> Exporter en PNG
        </button>
      </div>

      {/* Carte trajectoire */}
      <div style={{ borderRadius: 12, overflow: "hidden", border: `1px solid ${T.border}`, height: 320 }}>
        <MapContainer center={positions[0]} zoom={14} style={{ height: "100%", width: "100%" }}>
          <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <FitBounds positions={positions} />

          {/* Segments colorés par vitesse */}
          {coloredSegments.map((seg, i) => (
            <Polyline key={i} positions={seg.pos} color={seg.color} weight={3} opacity={0.85} />
          ))}

          {/* Points de vitesse tous les 15 pas */}
          {steps.filter((_, i) => i % 15 === 0 && steps[i].coords?.lat).map((s, i) => (
            <Marker key={i} position={[s.coords.lat, s.coords.lng]} icon={dotIcon(speedColor(s.speed))}>
              <Popup>
                <div style={{ fontFamily: "sans-serif", fontSize: 11 }}>
                  <div style={{ fontWeight: 700, color: speedColor(s.speed), marginBottom: 3 }}>{Math.round(s.speed || 0)} km/h</div>
                  <div style={{ color: "#6b7280" }}>{new Date(s.timestamp).toLocaleTimeString("fr-FR")}</div>
                </div>
              </Popup>
            </Marker>
          ))}

          {/* Départ / Arrivée */}
          <Marker position={positions[0]} icon={endpointIcon(T.green, "A")}>
            <Popup><div style={{ fontFamily: "sans-serif", fontSize: 11 }}><b style={{ color: T.green }}>Départ</b><br />{fmtDate(journey.start_time)}</div></Popup>
          </Marker>
          <Marker position={positions[positions.length - 1]} icon={endpointIcon(T.red, "B")}>
            <Popup><div style={{ fontFamily: "sans-serif", fontSize: 11 }}><b style={{ color: T.red }}>Arrivée</b><br />{fmtDate(journey.end_time)}</div></Popup>
          </Marker>
        </MapContainer>
      </div>

      {/* Légende vitesse carte */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 9, color: T.muted }}>
        {[
          ["Arrêt", T.muted], ["< 30 km/h", T.orange], ["30–50", T.yellow], ["50–80", T.green], ["> 80", T.accent]
        ].map(([l, c]) => (
          <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 16, height: 3, background: c, display: "inline-block", borderRadius: 2 }} />{l}
          </span>
        ))}
      </div>

      {/* Graphes en 2 colonnes */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>

        {/* Courbe vitesse */}
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 16px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
            Profil de vitesse
          </div>
          {speedSeries.length < 2 ? (
            <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", color: T.dim, fontSize: 10 }}>Données insuffisantes</div>
          ) : (
            <ResponsiveContainer width="100%" height={100}>
              <AreaChart data={speedSeries} margin={{ top: 2, right: 4, bottom: 0, left: -24 }}>
                <defs>
                  <linearGradient id="gSpd" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={T.accent} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={T.accent} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis dataKey="i" tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} interval="preserveEnd" />
                <YAxis tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} domain={[0, "auto"]} />
                <Tooltip content={<ChartTip />} />
                <Area type="monotone" dataKey="speed" stroke={T.accent} strokeWidth={2} fill="url(#gSpd)" name="Vitesse" isAnimationActive={false} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Distribution vitesses */}
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 16px" }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
            Distribution
          </div>
          {distrib.every(d => d.count === 0) ? (
            <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", color: T.dim, fontSize: 10 }}>Aucune donnée</div>
          ) : (
            <ResponsiveContainer width="100%" height={100}>
              <BarChart data={distrib} margin={{ top: 2, right: 4, bottom: 0, left: -24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false} />
                <XAxis dataKey="label" tick={{ fontSize: 8, fill: T.muted }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} />
                <Tooltip content={p => <ChartTip {...p} unit="pts" />} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false} name="Points">
                  {distrib.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Anomalies */}
      {anomalies.length > 0 && (
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: T.orange, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
            <AlertTriangle size={10} /> Anomalies ({anomalies.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 200, overflowY: "auto" }}>
            {anomalies.slice(0, 15).map((a, i) => (
              <div key={i} style={{
                background: T.bg2, border: `1px solid ${T.border}`,
                borderLeft: `3px solid ${a.severity === "high" ? T.red : T.orange}`,
                borderRadius: "0 8px 8px 0", padding: "8px 12px",
                fontSize: 10, fontFamily: "monospace",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: T.orange, fontWeight: 700 }}>{a.segment_id?.slice(0, 22)}</span>
                  {a.expected_value != null && a.actual_value != null && (
                    <span style={{ color: T.muted, marginLeft: 8 }}>
                      prévu {a.expected_value?.toFixed(1)} → réel {a.actual_value?.toFixed(1)} km/h
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 9, color: T.dim }}>{new Date(a.timestamp).toLocaleTimeString("fr-FR")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Prédictions */}
      {predictions.length > 0 && (
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, color: T.purple, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
            <Brain size={10} /> Prédictions IA ({predictions.length})
          </div>
          <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", maxHeight: 200, overflowY: "auto" }}>
            {predictions.slice(0, 10).map((p, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "8px 14px", borderBottom: `1px solid ${T.border}`,
                fontSize: 10, fontFamily: "monospace",
              }}>
                <span style={{ color: T.muted, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{p.segment_id?.slice(0, 24)}</span>
                <span style={{ color: speedColor(p.predicted_speed), fontWeight: 700, marginLeft: 12 }}>{Math.round(p.predicted_speed || 0)} km/h</span>
                <span style={{ color: T.dim, marginLeft: 12 }}>{Math.round((p.confidence_score || 0) * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Log positions */}
      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", maxHeight: 180, overflowY: "auto" }}>
        <div style={{ padding: "8px 14px", borderBottom: `1px solid ${T.border}`, fontSize: 9, color: T.dim, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Log de positions ({steps.length} enregistrements)
        </div>
        {steps.slice(0, 30).map((s, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "28px 1fr 60px 60px",
            padding: "5px 14px", borderBottom: `1px solid ${T.border}10`,
            fontSize: 9, fontFamily: "monospace", alignItems: "center",
          }}>
            <span style={{ color: T.dim }}>{i + 1}</span>
            <span style={{ color: T.muted }}>{s.coords?.lat?.toFixed(5)}, {s.coords?.lng?.toFixed(5)}</span>
            <span style={{ color: speedColor(s.speed || 0), fontWeight: 700, textAlign: "right" }}>{Math.round(s.speed || 0)} km/h</span>
            <span style={{ color: T.dim, textAlign: "right" }}>{s.timestamp ? new Date(s.timestamp).toLocaleTimeString("fr-FR") : "—"}</span>
          </div>
        ))}
        {steps.length > 30 && (
          <div style={{ padding: "8px 14px", fontSize: 9, color: T.dim, textAlign: "center" }}>+{steps.length - 30} positions supplémentaires</div>
        )}
      </div>
    </div>
  );
});
TrajectoryDetail.displayName = "TrajectoryDetail";

/* ══════════════════════════════════════════════════
   JOURNEY ROW
══════════════════════════════════════════════════ */
const JourneyRow = memo(({ j, selected, onSelect, onExport }) => {
  const detailRef = React.useRef(null);
  const done    = j.status === "completed";
  const going   = j.status === "in_progress";
  const anomN   = j.anomalies_detected ?? j.anomalies_count ?? 0;
  const predN   = j.predictions_made   ?? 0;
  const dur     = fmtDuration(j.start_time, j.end_time);

  return (
    <div style={{
      background: selected ? "#0c1f3a" : T.bg2,
      border: `1px solid ${selected ? T.accent : T.border}`,
      borderRadius: 12, overflow: "hidden",
      transition: "border-color 0.15s",
    }}>
      {/* Header — div cliquable (évite button-in-button) */}
      <div
        role="button" tabIndex={0}
        onClick={() => onSelect(j.journey_id)}
        onKeyDown={e => e.key === "Enter" && onSelect(j.journey_id)}
        style={{
          width: "100%", textAlign: "left", cursor: "pointer",
          padding: "14px 16px",
          display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* ID + badges */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: T.text, fontFamily: "monospace" }}>{j.journey_id}</span>
            <span style={{
              fontSize: 9, fontWeight: 700, padding: "1px 7px", borderRadius: 99,
              background: done ? "#052e16" : going ? "#0c1f3a" : T.bg3,
              color: done ? T.green : going ? T.cyan : T.muted,
              border: `1px solid ${done ? "#166534" : going ? "#1e3a5f" : T.border}`,
            }}>{done ? "Terminé" : going ? "En cours" : j.status}</span>
            {anomN > 0 && (
              <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 99, background: "#1c0e00", color: T.orange, border: "1px solid #3d2000" }}>
                {anomN} anomalie{anomN > 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* Méta */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 10, color: T.muted, fontFamily: "monospace" }}>
            <span>{fmtDate(j.start_time)}</span>
            {j.end_time && <><span style={{ color: T.dim }}>→</span><span>{fmtDate(j.end_time)}</span></>}
          </div>

          {/* Chips */}
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            {[
              { val: `${j.steps_count ?? 0} étapes`, show: true },
              { val: dur,                             show: !!j.end_time },
              { val: `${predN} prédictions`,          show: predN > 0 },
            ].filter(c => c.show).map((c, i) => (
              <span key={i} style={{ fontSize: 9, background: T.bg3, color: T.muted, padding: "2px 8px", borderRadius: 99, border: `1px solid ${T.border}` }}>{c.val}</span>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <div style={{ color: T.muted }}>
            {selected ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </div>
        </div>
      </div>

      {/* Détail dépliable */}
      {selected && (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: "16px" }}>
          <TrajectoryDetail journey={j.__detail || j} exportRef={detailRef} />
        </div>
      )}
    </div>
  );
});
JourneyRow.displayName = "JourneyRow";

/* ══════════════════════════════════════════════════
   MAIN
══════════════════════════════════════════════════ */
const Historique = () => {
  const [journeys,    setJourneys]    = useState([]);
  const [details,     setDetails]     = useState({});   // {journey_id: detailData}
  const [loading,     setLoading]     = useState(true);
  const [detailLoad,  setDetailLoad]  = useState(null);
  const [selectedId,  setSelectedId]  = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [filters,     setFilters]     = useState({ status: "all", sort: "date_desc", from: "" });

  /* Fetch list */
  const fetchList = useCallback(async () => {
    setLoading(true);
    try { setJourneys(await apiService.getJourneys(50) || []); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchList(); }, [fetchList]);

  /* Select / fetch detail */
  const handleSelect = useCallback(async (id) => {
    if (selectedId === id) { setSelectedId(null); return; }
    setSelectedId(id);
    if (!details[id]) {
      setDetailLoad(id);
      try {
        const d = await apiService.getJourneyById(id);
        setDetails(p => ({ ...p, [id]: d }));
      } catch {}
      setDetailLoad(null);
    }
  }, [selectedId, details]);

  const handleExport = useCallback(() => {}, []);

  /* Filtered list */
  const filtered = useMemo(() => {
    let list = [...journeys];
    if (filters.status !== "all") list = list.filter(j => j.status === filters.status);
    if (filters.from)             list = list.filter(j => new Date(j.start_time) >= new Date(filters.from));
    list.sort((a, b) => {
      if (filters.sort === "date_asc")  return new Date(a.start_time) - new Date(b.start_time);
      if (filters.sort === "steps")     return (b.steps_count ?? 0) - (a.steps_count ?? 0);
      if (filters.sort === "anomalies") return ((b.anomalies_detected ?? 0) - (a.anomalies_detected ?? 0));
      return new Date(b.start_time) - new Date(a.start_time); // date_desc default
    });
    return list;
  }, [journeys, filters]);

  /* Stats */
  const stats = useMemo(() => ({
    total:  journeys.length,
    done:   journeys.filter(j => j.status === "completed").length,
    going:  journeys.filter(j => j.status === "in_progress").length,
    steps:  journeys.reduce((s, j) => s + (j.steps_count ?? 0), 0),
    anoms:  journeys.reduce((s, j) => s + (j.anomalies_detected ?? j.anomalies_count ?? 0), 0),
    preds:  journeys.reduce((s, j) => s + (j.predictions_made ?? 0), 0),
  }), [journeys]);

  /* ═══ RENDER ══════════════════════════════════════════════ */
  return (
    <div style={{
      height: "100%", overflowY: "auto",
      background: T.bg0, color: T.text,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 20px 48px" }}>

        {/* ── Navbar ── */}
        <div style={{
          position: "sticky", top: 0, zIndex: 100,
          background: T.bg0 + "f0", backdropFilter: "blur(12px)",
          borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 0", marginBottom: 28,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: T.text, letterSpacing: "-0.4px" }}>Historique</div>
            <div style={{ fontSize: 10, color: T.muted, marginTop: 2 }}>Trajets du véhicule ego · Analyse de trajectoire</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setShowFilters(f => !f)} style={{
              height: 32, padding: "0 12px", borderRadius: 8,
              border: `1px solid ${showFilters ? T.accent : T.border}`,
              background: showFilters ? "#0c1f3a" : T.bg2,
              color: showFilters ? T.accent : T.muted,
              fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
            }}>
              <Filter size={11} /> Filtres
            </button>
            <button onClick={fetchList} disabled={loading} style={{
              width: 32, height: 32, borderRadius: 8, border: `1px solid ${T.border}`,
              background: T.bg2, color: T.muted, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <RefreshCw size={12} style={loading ? { animation: "spin 1s linear infinite" } : {}} />
            </button>
          </div>
        </div>

        {/* ── KPIs ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 24 }}>
          {[
            { label: "Total",       val: stats.total, color: T.text   },
            { label: "Terminés",    val: stats.done,  color: T.green  },
            { label: "En cours",    val: stats.going, color: T.cyan   },
            { label: "Étapes",      val: stats.steps.toLocaleString(), color: T.accent },
            { label: "Anomalies",   val: stats.anoms, color: stats.anoms > 0 ? T.orange : T.green },
            { label: "Prédictions", val: stats.preds, color: T.purple },
          ].map((k, i) => (
            <div key={i} style={{
              background: T.bg2, border: `1px solid ${T.border}`,
              borderRadius: 10, padding: "10px 8px", textAlign: "center",
            }}>
              <div style={{ fontSize: 17, fontWeight: 900, color: k.color, fontVariantNumeric: "tabular-nums" }}>{k.val}</div>
              <div style={{ fontSize: 8, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginTop: 4 }}>{k.label}</div>
            </div>
          ))}
        </div>

        {/* ── Filtres ── */}
        {showFilters && (
          <div style={{
            background: T.bg2, border: `1px solid ${T.border}`,
            borderRadius: 10, padding: "14px 16px", marginBottom: 16,
            display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center",
          }}>
            {[
              { name: "status", options: [["all","Tous les statuts"],["completed","Terminés"],["in_progress","En cours"]] },
              { name: "sort",   options: [["date_desc","Plus récent"],["date_asc","Plus ancien"],["steps","Plus d'étapes"],["anomalies","Plus d'anomalies"]] },
            ].map(f => (
              <select key={f.name} value={filters[f.name]}
                onChange={e => setFilters(p => ({ ...p, [f.name]: e.target.value }))}
                style={{
                  background: T.bg3, border: `1px solid ${T.border}`,
                  borderRadius: 7, padding: "6px 10px", fontSize: 11, color: T.text,
                  outline: "none", cursor: "pointer",
                }}>
                {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ))}
            <div style={{ position: "relative" }}>
              <Calendar size={10} style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: T.muted, pointerEvents: "none" }} />
              <input type="date" value={filters.from}
                onChange={e => setFilters(p => ({ ...p, from: e.target.value }))}
                style={{
                  background: T.bg3, border: `1px solid ${T.border}`,
                  borderRadius: 7, padding: "6px 10px 6px 24px", fontSize: 11, color: T.text, outline: "none",
                }} />
            </div>
            <button onClick={() => setFilters({ status: "all", sort: "date_desc", from: "" })} style={{
              background: "none", border: "none", color: T.dim, fontSize: 10, cursor: "pointer",
            }}>Réinitialiser</button>
          </div>
        )}

        {/* ── Liste ── */}
        {loading ? (
          <div style={{ textAlign: "center", padding: "64px 0", color: T.muted, fontSize: 11 }}>
            <RefreshCw size={22} style={{ margin: "0 auto 10px", animation: "spin 1s linear infinite", color: T.accent, display: "block" }} />
            Chargement des trajets…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: "48px 32px", textAlign: "center" }}>
            <MapPin size={28} style={{ color: T.dim, margin: "0 auto 10px", display: "block" }} />
            <div style={{ color: T.muted, fontSize: 12, marginBottom: 4 }}>Aucun trajet enregistré</div>
            <div style={{ color: T.dim, fontSize: 10 }}>Lancez une simulation depuis MapSolo pour générer des données</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.map(j => {
              const d = details[j.journey_id];
              const isLoading = detailLoad === j.journey_id;
              const enriched = d ? { ...j, ...d, __detail: d } : j;
              return (
                <div key={j.journey_id}>
                  <JourneyRow
                    j={enriched}
                    selected={selectedId === j.journey_id}
                    onSelect={handleSelect}
                    onExport={handleExport}
                  />
                  {selectedId === j.journey_id && isLoading && (
                    <div style={{ textAlign: "center", padding: "24px 0", color: T.muted, fontSize: 11 }}>
                      <RefreshCw size={16} style={{ animation: "spin 1s linear infinite", color: T.accent, display: "inline-block", marginRight: 6 }} />
                      Chargement de la trajectoire…
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default Historique;