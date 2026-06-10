// frontend/src/components/screens/Diagnostic.jsx
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  Activity, RefreshCw, Wifi, WifiOff, Database,
  Brain, AlertTriangle, CheckCircle, X,
} from "lucide-react";
import apiService from "../../services/api";
import socketService from "../../services/socket";

/* ─── Design tokens ─────────────────────────────────────────────
   Noir charbon #08111e, bleu marine #0f172a, accent bleu #3b82f6,
   accent cyan #06b6d4, texte #e2e8f0, muet #475569
─────────────────────────────────────────────────────────────── */
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
  text:   "#e2e8f0",
  muted:  "#475569",
  dim:    "#334155",
};

const MAX_HIST = 60;

/* ─── Helpers ───────────────────────────────────────────────── */
const speedColor = (s = 0) => {
  if (s <= 0)  return T.muted;
  if (s <= 10) return T.red;
  if (s <= 30) return T.orange;
  if (s <= 50) return "#eab308";
  if (s <= 80) return T.green;
  return T.accent;
};

const fmt = (v, decimals = 1) =>
  v == null || v === "" ? "—" : typeof v === "number" ? v.toFixed(decimals) : v;

/* ─── Shared tooltip ────────────────────────────────────────── */
const ChartTip = ({ active, payload, label, unit = "km/h" }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: T.bg2, border: `1px solid ${T.border}`,
      borderRadius: 8, padding: "7px 12px", fontSize: 11,
    }}>
      <div style={{ color: T.muted, marginBottom: 4 }}>t = {label}s</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontWeight: 700 }}>
          {p.name}: {fmt(p.value)} {unit}
        </div>
      ))}
    </div>
  );
};

/* ─── Section header ────────────────────────────────────────── */
const SectionHead = ({ label, sub }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ fontSize: 10, fontWeight: 800, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
    {sub && <div style={{ fontSize: 9, color: T.dim, marginTop: 2 }}>{sub}</div>}
  </div>
);

/* ─── KPI card ──────────────────────────────────────────────── */
const KpiCard = ({ label, value, unit, color, sub }) => (
  <div style={{
    background: T.bg2, border: `1px solid ${T.border}`,
    borderRadius: 12, padding: "14px 16px",
  }}>
    <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>{label}</div>
    <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
      <span style={{ fontSize: 26, fontWeight: 900, color: color || T.text, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{value ?? "—"}</span>
      {unit && <span style={{ fontSize: 11, color: T.muted }}>{unit}</span>}
    </div>
    {sub && <div style={{ fontSize: 10, color: T.dim, marginTop: 5 }}>{sub}</div>}
  </div>
);

/* ─── Alert row ─────────────────────────────────────────────── */
const AlertRow = ({ alert, onDismiss }) => {
  const crit = alert.severity === "critical" || alert.risk_level === "critical";
  return (
    <div style={{
      background: T.bg2,
      borderLeft: `3px solid ${crit ? T.red : T.orange}`,
      borderRadius: "0 8px 8px 0",
      padding: "8px 12px",
      display: "flex", alignItems: "flex-start", gap: 10,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: crit ? "#fca5a5" : "#fdba74", marginBottom: 2 }}>
          {alert.title || "Alerte"}
        </div>
        <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.4 }}>{alert.message || "—"}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
          {alert.vehicle_id && <span style={{ fontSize: 9, color: T.dim, fontFamily: "monospace" }}>{alert.vehicle_id}</span>}
          {alert.segment_id && <span style={{ fontSize: 9, color: T.dim, fontFamily: "monospace" }}>{alert.segment_id?.slice(0, 20)}</span>}
          {alert.deviation != null && <span style={{ fontSize: 9, color: T.orange }}>déviation {fmt(alert.deviation)}σ</span>}
          <span style={{ fontSize: 9, color: T.dim }}>{new Date(alert.timestamp || Date.now()).toLocaleTimeString("fr-FR")}</span>
        </div>
      </div>
      {onDismiss && (
        <button onClick={onDismiss} style={{ background: "none", border: "none", color: T.dim, cursor: "pointer", padding: 2, flexShrink: 0 }}>
          <X size={12} />
        </button>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════
   MAIN
═══════════════════════════════════════════════════════════════ */
const Diagnostic = () => {
  /* ── Données live ── */
  const [vehicles,     setVehicles]     = useState({});     // {id: {speed,lat,lng,heading}}
  const [alerts,       setAlerts]       = useState([]);
  const [anomalies,    setAnomalies]    = useState([]);
  const [predictions,  setPredictions]  = useState([]);
  const [accidents,    setAccidents]    = useState([]);
  const [simRunning,   setSimRunning]   = useState(false);
  const [socketOk,     setSocketOk]     = useState(false);

  /* ── Données REST ── */
  const [restStats,    setRestStats]    = useState(null);
  const [journeys,     setJourneys]     = useState([]);
  const [aiInfo,       setAiInfo]       = useState(null);
  const [refreshing,   setRefreshing]   = useState(false);

  /* ── Historiques pour graphes ── */
  const [speedHist,    setSpeedHist]    = useState([]);   // {t, avg, max, min}
  const [volumeHist,   setVolumeHist]   = useState([]);   // {t, count, stopped}
  const [anomalyHist,  setAnomalyHist]  = useState([]);   // {t, count}
  const [predHist,     setPredHist]     = useState([]);   // dernières prédictions par segment

  const tickRef    = useRef(0);
  const mountedRef = useRef(false);

  /* ── Socket ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    socketService.connect();

    socketService.on("connect",    () => setSocketOk(true));
    socketService.on("disconnect", () => setSocketOk(false));

    socketService.on("all_vehicles_state", (d) => {
      if (!d?.vehicles) return;
      setVehicles(d.vehicles);
      const vals  = Object.values(d.vehicles);
      const count = vals.length;
      if (count === 0) return;
      const avg     = vals.reduce((s, v) => s + (v.speed ?? 0), 0) / count;
      const max     = Math.max(...vals.map(v => v.speed ?? 0));
      const min     = Math.min(...vals.map(v => v.speed ?? 0));
      const stopped = vals.filter(v => (v.speed ?? 0) <= 1).length;
      tickRef.current += 1;
      const t = tickRef.current;
      setSpeedHist(h  => [...h,  { t, avg: +avg.toFixed(1), max: +max.toFixed(1), min: +min.toFixed(1) }].slice(-MAX_HIST));
      setVolumeHist(h => [...h,  { t, count, stopped }].slice(-MAX_HIST));
    });

    socketService.on("simulation_status", (d) => {
      setSimRunning(d?.status === "started");
      if (d?.status === "stopped") {
        setVehicles({});
        setSpeedHist([]); setVolumeHist([]); setAnomalyHist([]);
        tickRef.current = 0;
      }
    });

    socketService.on("emergency_alert", (d) => {
      if (!d) return;
      const a = { ...d, _id: Date.now() + Math.random(), timestamp: d.timestamp || new Date().toISOString() };
      setAlerts(p => [a, ...p].slice(0, 50));
    });

    socketService.on("traffic_anomaly", (d) => {
      if (!d) return;
      setAnomalies(p => [{ ...d, _id: Date.now() }, ...p].slice(0, 100));
      setAnomalyHist(h => {
        const t = tickRef.current;
        const last = h[h.length - 1];
        if (last && last.t === t) return [...h.slice(0, -1), { ...last, count: last.count + 1 }];
        return [...h, { t, count: 1 }].slice(-MAX_HIST);
      });
    });

    socketService.on("traffic_prediction", (d) => {
      if (!d?.segment_id) return;
      setPredictions(p => [d, ...p].slice(0, 40));
      setPredHist(h => {
        const t = tickRef.current;
        return [...h, { t, speed: +(d.predicted_speed || 0).toFixed(1), conf: +((d.confidence_score || 0) * 100).toFixed(0) }].slice(-MAX_HIST);
      });
    });

    socketService.on("accidents_state", (d) => {
      if (d?.accidents) setAccidents(d.accidents);
    });

    return () => {
      ["connect","disconnect","all_vehicles_state","simulation_status",
       "emergency_alert","traffic_anomaly","traffic_prediction","accidents_state",
      ].forEach(ev => socketService.off(ev));
      mountedRef.current = false;
    };
  }, []);

  /* ── Fetch REST ─────────────────────────────────────────────── */
  const fetchRest = useCallback(async (showLoader = false) => {
    if (showLoader) setRefreshing(true);
    try {
      const [statsRes, journeysRes, aiRes] = await Promise.allSettled([
        apiService.getTrafficStatistics(),
        apiService.getJourneys(20),
        apiService.getAIInfo(),
      ]);
      if (statsRes.status   === "fulfilled") setRestStats(statsRes.value);
      if (journeysRes.status === "fulfilled") setJourneys(journeysRes.value || []);
      if (aiRes.status      === "fulfilled") setAiInfo(aiRes.value);
    } catch {}
    if (showLoader) setRefreshing(false);
  }, []);

  useEffect(() => { fetchRest(); }, [fetchRest]);

  /* ── Dérivés ────────────────────────────────────────────────── */
  const vList  = Object.entries(vehicles);
  const vCount = vList.length;

  const speedStats = useMemo(() => {
    if (vCount === 0) return { avg: 0, max: 0, stopped: 0, slow: 0, fast: 0 };
    const vals = Object.values(vehicles);
    return {
      avg:     +(vals.reduce((s, v) => s + (v.speed ?? 0), 0) / vCount).toFixed(1),
      max:     +Math.max(...vals.map(v => v.speed ?? 0)).toFixed(1),
      stopped: vals.filter(v => (v.speed ?? 0) <= 1).length,
      slow:    vals.filter(v => (v.speed ?? 0) > 1 && (v.speed ?? 0) <= 30).length,
      fast:    vals.filter(v => (v.speed ?? 0) > 80).length,
    };
  }, [vehicles, vCount]);

  const journeyStats = useMemo(() => {
    const done  = journeys.filter(j => j?.status === "completed").length;
    const going = journeys.filter(j => j?.status === "in_progress").length;
    const total = journeys.reduce((s, j) => s + (j?.steps_count ?? 0), 0);
    return { done, going, total, rate: journeys.length > 0 ? Math.round(done / journeys.length * 100) : 0 };
  }, [journeys]);

  const recentAnoms = useMemo(() => {
    const cut = Date.now() - 10 * 60 * 1000;
    return anomalies.filter(a => a?.timestamp && new Date(a.timestamp).getTime() > cut);
  }, [anomalies]);

  const critCount = alerts.filter(a => a.severity === "critical" || a.risk_level === "critical").length;

  const congColor = {
    low: T.green, medium: "#eab308", high: T.red, unknown: T.muted,
  }[restStats?.congestion_level] || T.muted;

  /* ─── Speed distribution pour bar chart ── */
  const speedDistrib = useMemo(() => {
    if (vCount === 0) return [];
    const vals = Object.values(vehicles);
    return [
      { label: "Arrêt",  count: vals.filter(v => (v.speed ?? 0) <= 1).length,                                   fill: T.muted   },
      { label: "< 30",   count: vals.filter(v => (v.speed ?? 0) > 1  && (v.speed ?? 0) <= 30).length,          fill: T.orange  },
      { label: "30–50",  count: vals.filter(v => (v.speed ?? 0) > 30 && (v.speed ?? 0) <= 50).length,          fill: "#eab308" },
      { label: "50–80",  count: vals.filter(v => (v.speed ?? 0) > 50 && (v.speed ?? 0) <= 80).length,          fill: T.green   },
      { label: "> 80",   count: vals.filter(v => (v.speed ?? 0) > 80).length,                                   fill: T.accent  },
    ];
  }, [vehicles, vCount]);

  /* ═══ RENDER ═════════════════════════════════════════════════ */
  return (
    <div style={{
      height: "100%", overflowY: "auto",
      background: T.bg0, color: T.text,
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 24px 48px" }}>

        {/* ══ NAVBAR ════════════════════════════════════════════ */}
        <div style={{
          position: "sticky", top: 0, zIndex: 100,
          background: T.bg0 + "f0", backdropFilter: "blur(12px)",
          borderBottom: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 0", gap: 12, marginBottom: 32,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: T.text, letterSpacing: "-0.4px" }}>
              Diagnostic
            </div>
            <div style={{ fontSize: 10, color: T.muted, marginTop: 2, fontFamily: "monospace" }}>
              Surveillance SUMO · Casablanca
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Socket status */}
            <div style={{
              display: "flex", alignItems: "center", gap: 5,
              background: T.bg2, border: `1px solid ${T.border}`,
              borderRadius: 20, padding: "4px 10px", fontSize: 10, fontWeight: 600,
              color: socketOk ? T.green : T.muted,
            }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: socketOk ? T.green : T.muted }} />
              {socketOk ? "Temps réel actif" : "Déconnecté"}
            </div>
            {/* SUMO status */}
            <div style={{
              display: "flex", alignItems: "center", gap: 5,
              background: T.bg2, border: `1px solid ${simRunning ? "#166534" : T.border}`,
              borderRadius: 20, padding: "4px 10px", fontSize: 10, fontWeight: 700,
              color: simRunning ? T.green : T.muted,
            }}>
              <Activity size={11} />
              SUMO {simRunning ? "actif" : "inactif"}
            </div>
            {/* Refresh */}
            <button onClick={() => fetchRest(true)} disabled={refreshing} style={{
              width: 32, height: 32, borderRadius: 8, border: `1px solid ${T.border}`,
              background: T.bg2, color: T.muted, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <RefreshCw size={13} style={refreshing ? { animation: "spin 1s linear infinite" } : {}} />
            </button>
          </div>
        </div>

        {/* ══ KPIs PRINCIPAUX ═══════════════════════════════════ */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 32 }}>
          <KpiCard label="Véhicules actifs"  value={vCount}                 color={T.cyan}   sub={vCount > 0 ? `${speedStats.stopped} à l'arrêt` : "Simulation inactive"} />
          <KpiCard label="Vitesse moyenne"   value={fmt(speedStats.avg)}    unit="km/h"       color={speedColor(speedStats.avg)} sub={`max ${fmt(speedStats.max)} km/h`} />
          <KpiCard label="Congestion"        value={restStats?.congestion_level ?? "—"} color={congColor} sub={`${restStats?.total_segments ?? 0} segments surveillés`} />
          <KpiCard label="Anomalies (10 min)" value={recentAnoms.length}   color={recentAnoms.length > 0 ? T.orange : T.green} sub={`${anomalies.length} total cumulées`} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 40 }}>
          <KpiCard label="Trajets enregistrés" value={journeys.length}   color={T.purple} sub={`${journeyStats.done} terminés`} />
          <KpiCard label="Taux de complétion"  value={`${journeyStats.rate}%`}  color={journeyStats.rate > 80 ? T.green : T.orange} />
          <KpiCard label="Alertes critiques"   value={critCount}        color={critCount > 0 ? T.red : T.green} sub={`${alerts.length} total`} />
          <KpiCard label="Modèle IA"           value={aiInfo?.enabled ? "Actif" : "Fallback"} color={aiInfo?.enabled ? T.cyan : T.muted} sub={aiInfo?.model_type || "—"} />
        </div>

        {/* ══ GRAPHES TEMPS RÉEL ════════════════════════════════ */}
        <div style={{ marginBottom: 40 }}>
          <SectionHead label="Métriques temps réel" sub="Données live via WebSocket — mise à jour à chaque step SUMO" />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>

            {/* Courbe vitesse */}
            <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 14, padding: "18px 20px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 14 }}>
                Vitesse — {MAX_HIST}s glissantes
              </div>
              {speedHist.length < 2 ? (
                <div style={{ height: 130, display: "flex", alignItems: "center", justifyContent: "center", color: T.dim, fontSize: 11 }}>
                  En attente de données…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={130}>
                  <AreaChart data={speedHist} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                    <defs>
                      <linearGradient id="gAvg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.accent} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={T.accent} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                    <XAxis dataKey="t" tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} interval="preserveEnd" />
                    <YAxis tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} domain={[0, "auto"]} />
                    <Tooltip content={<ChartTip />} />
                    <ReferenceLine y={50} stroke="#eab30840" strokeDasharray="4 4" />
                    <Area type="monotone" dataKey="avg" stroke={T.accent} strokeWidth={2} fill="url(#gAvg)" name="Moy." isAnimationActive={false} dot={false} />
                    <Line type="monotone" dataKey="max" stroke={T.red}    strokeWidth={1.5} strokeDasharray="4 3" name="Max" isAnimationActive={false} dot={false} />
                    <Line type="monotone" dataKey="min" stroke={T.green}  strokeWidth={1}   strokeDasharray="2 4" name="Min" isAnimationActive={false} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
              <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 9, color: T.muted }}>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 14, height: 2, background: T.accent, display: "inline-block" }} />Moy.</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 14, height: 2, background: T.red, display: "inline-block" }} />Max</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 14, height: 2, background: T.green, display: "inline-block" }} />Min</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 14, height: 1, background: "#eab308", display: "inline-block" }} />50 km/h</span>
              </div>
            </div>

            {/* Courbe volume */}
            <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 14, padding: "18px 20px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 14 }}>
                Volume de trafic — {MAX_HIST}s
              </div>
              {volumeHist.length < 2 ? (
                <div style={{ height: 130, display: "flex", alignItems: "center", justifyContent: "center", color: T.dim, fontSize: 11 }}>
                  En attente de données…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={130}>
                  <AreaChart data={volumeHist} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                    <defs>
                      <linearGradient id="gVol" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.cyan} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={T.cyan} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                    <XAxis dataKey="t" tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} interval="preserveEnd" />
                    <YAxis tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} domain={[0, "auto"]} />
                    <Tooltip content={p => <ChartTip {...p} unit="veh." />} />
                    <Area type="monotone" dataKey="count"   stroke={T.cyan}  strokeWidth={2} fill="url(#gVol)" name="Total"   isAnimationActive={false} dot={false} />
                    <Line type="monotone" dataKey="stopped" stroke={T.muted} strokeWidth={1.5} strokeDasharray="3 3" name="Arrêtés" isAnimationActive={false} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
              <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 9, color: T.muted }}>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 14, height: 2, background: T.cyan, display: "inline-block" }} />Total</span>
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 14, height: 2, background: T.muted, display: "inline-block" }} />Arrêtés</span>
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

            {/* Distribution vitesses */}
            <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 14, padding: "18px 20px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 14 }}>
                Distribution des vitesses
              </div>
              {speedDistrib.every(d => d.count === 0) ? (
                <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: T.dim, fontSize: 11 }}>
                  Aucun véhicule
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={speedDistrib} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} horizontal={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 9, fill: T.muted }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} />
                    <Tooltip content={p => <ChartTip {...p} unit="veh." />} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {speedDistrib.map((d, i) => (
                        <Cell key={i} fill={d.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Prédictions IA */}
            <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 14, padding: "18px 20px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 14, display: "flex", alignItems: "center", gap: 6 }}>
                <Brain size={11} color={T.purple} /> Vitesses prédites — IA
              </div>
              {predHist.length < 2 ? (
                <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: T.dim, fontSize: 11 }}>
                  {aiInfo?.enabled ? "En attente des prédictions (60 steps)…" : "Modèle IA non chargé — fallback actif"}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={predHist} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                    <XAxis dataKey="t" tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} interval="preserveEnd" />
                    <YAxis tick={{ fontSize: 8, fill: T.dim }} tickLine={false} axisLine={false} />
                    <Tooltip content={<ChartTip />} />
                    <Line type="monotone" dataKey="speed" stroke={T.purple} strokeWidth={2} name="Prédit" isAnimationActive={false} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>

        {/* ══ ÉTAT DU RÉSEAU (REST) ══════════════════════════════ */}
        <div style={{ marginBottom: 40 }}>
          <SectionHead label="État du réseau" sub="Données REST — actualisées manuellement ou au démarrage" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            {[
              { label: "Vitesse moy. réseau", val: `${restStats?.average_speed ?? "—"} km/h`,  color: speedColor(restStats?.average_speed) },
              { label: "Vitesse médiane",     val: `${restStats?.median_speed   ?? "—"} km/h`,  color: T.text   },
              { label: "Segments actifs",     val: restStats?.total_segments   ?? "—",          color: T.cyan   },
              { label: "Congestion globale",  val: restStats?.congestion_level ?? "—",          color: congColor },
            ].map((k, i) => (
              <div key={i} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 9, color: T.dim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{k.label}</div>
                <div style={{ fontSize: 18, fontWeight: 900, color: k.color }}>{k.val}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ══ ACCIDENTS ════════════════════════════════════════ */}
        {accidents.length > 0 && (
          <div style={{ marginBottom: 40 }}>
            <SectionHead label={`Accidents actifs (${accidents.length})`} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 10 }}>
              {accidents.map((acc, i) => (
                <div key={acc.id || i} style={{
                  background: T.bg2, border: `1px solid ${T.border}`,
                  borderLeft: `3px solid ${T.red}`,
                  borderRadius: "0 10px 10px 0", padding: "10px 14px",
                }}>
                  <div style={{ fontWeight: 700, fontSize: 11, color: "#fca5a5", marginBottom: 4 }}>
                    {acc.cause || "Cause inconnue"}
                  </div>
                  <div style={{ fontSize: 9, color: T.dim, fontFamily: "monospace" }}>{acc.id}</div>
                  {(acc.blocked_count || 0) > 0 && (
                    <div style={{ marginTop: 6, fontSize: 10, color: T.orange }}>{acc.blocked_count} véhicule(s) bloqué(s)</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ ANOMALIES RÉCENTES ════════════════════════════════ */}
        {recentAnoms.length > 0 && (
          <div style={{ marginBottom: 40 }}>
            <SectionHead label={`Anomalies détectées (10 min — ${recentAnoms.length})`} sub="Déviation SUMO vs prédiction IA" />
            <div style={{
              background: T.bg1, border: `1px solid ${T.border}`,
              borderRadius: 12, overflow: "hidden", maxHeight: 260, overflowY: "auto",
            }}>
              {recentAnoms.slice(0, 20).map((a, i) => (
                <div key={a._id || i} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "9px 16px", borderBottom: `1px solid ${T.border}`,
                  fontSize: 10, fontFamily: "monospace",
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ color: T.orange, fontWeight: 700 }}>{a.segment_id?.slice(0, 22)}</span>
                    {a.metric_name && <span style={{ color: T.dim, marginLeft: 8 }}>{a.metric_name}</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                    {a.expected_value != null && a.actual_value != null && (
                      <span style={{ color: T.muted }}>
                        prévu {fmt(a.expected_value)} → réel {fmt(a.actual_value)} km/h
                      </span>
                    )}
                    <span style={{
                      background: a.severity === "high" ? "#7f1d1d" : "#3d2000",
                      color: a.severity === "high" ? "#fca5a5" : "#fdba74",
                      padding: "2px 8px", borderRadius: 99, fontSize: 9, fontWeight: 700,
                    }}>{a.severity || "medium"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ ALERTES ══════════════════════════════════════════ */}
        {alerts.length > 0 && (
          <div style={{ marginBottom: 40 }}>
            <SectionHead label={`Journal d'alertes (${alerts.length})`} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 340, overflowY: "auto" }}>
              {alerts.slice(0, 15).map(a => (
                <AlertRow key={a._id} alert={a} onDismiss={() => setAlerts(p => p.filter(x => x._id !== a._id))} />
              ))}
            </div>
          </div>
        )}

        {/* ══ TRAJETS ══════════════════════════════════════════ */}
        <div style={{ marginBottom: 40 }}>
          <SectionHead label={`Historique des trajets (${journeys.length})`} />
          {journeys.length === 0 ? (
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: "32px", textAlign: "center", color: T.dim, fontSize: 11 }}>
              Aucun trajet enregistré — lancez une simulation depuis MapSolo
            </div>
          ) : (
            <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
              {/* Header table */}
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", padding: "8px 16px", borderBottom: `1px solid ${T.border}` }}>
                {["Trajet", "Statut", "Étapes", "Anomalies"].map((h, i) => (
                  <div key={i} style={{ fontSize: 9, fontWeight: 700, color: T.dim, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</div>
                ))}
              </div>
              {journeys.slice(0, 10).map((j, i) => {
                const done = j.status === "completed";
                return (
                  <div key={j.journey_id || i} style={{
                    display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr",
                    padding: "10px 16px", borderBottom: `1px solid ${T.border}`,
                    fontSize: 10,
                  }}>
                    <div>
                      <div style={{ fontFamily: "monospace", color: T.text, fontSize: 9 }}>{j.journey_id}</div>
                      {j.start_time && <div style={{ color: T.dim, fontSize: 9, marginTop: 2 }}>{new Date(j.start_time).toLocaleString("fr-FR")}</div>}
                    </div>
                    <div>
                      <span style={{
                        background: done ? "#052e16" : "#1c1400",
                        color: done ? T.green : T.orange,
                        border: `1px solid ${done ? "#166534" : "#3d2e00"}`,
                        padding: "2px 8px", borderRadius: 99, fontSize: 9, fontWeight: 700,
                      }}>{j.status || "—"}</span>
                    </div>
                    <div style={{ color: T.muted }}>{j.steps_count ?? "—"}</div>
                    <div style={{ color: j.anomalies_detected > 0 ? T.orange : T.green }}>{j.anomalies_detected ?? 0}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ══ INFRASTRUCTURE ═══════════════════════════════════ */}
        <div>
          <SectionHead label="Infrastructure" />
          <div style={{
            background: T.bg2, border: `1px solid ${T.border}`,
            borderRadius: 12, padding: "16px 20px",
            display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10,
            fontFamily: "monospace",
          }}>
            {[
              ["Réseau",        "Casablanca, MA"  ],
              ["Moteur",        "SUMO 1.26.0"     ],
              ["Topologie",     "casa.net.xml"    ],
              ["Demande",       "casa.rou.xml"    ],
              ["Step length",   "0.5 s"           ],
              ["Backend",       "FastAPI + TraCI" ],
              ["Datastore",     "MongoDB"         ],
              ["IA",            aiInfo?.model_type || (aiInfo?.enabled ? "Actif" : "Fallback")],
            ].map(([k, v], i) => (
              <div key={i} style={{ fontSize: 10 }}>
                <span style={{ color: T.dim }}>{k}: </span>
                <span style={{ color: T.muted }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};

export default Diagnostic;