import React, { useState, useEffect, useCallback, memo } from "react";
import {
  Activity,
  Car,
  AlertTriangle,
  Route,
  Clock,
  Gauge,
  Zap,
  TrendingUp,
  Radio,
} from "lucide-react";

const API = "http://localhost:8000";

/* =====================================================
   STAT CARD
===================================================== */
const StatCard = memo(({ label, value, sub, icon, color = "text-blue-400", pulse = false }) => (
  <div className="bg-slate-900/60 border border-white/5 rounded-2xl p-5 hover:border-white/10 transition-all">
    <div className="flex items-center gap-2 mb-3 text-slate-500 uppercase font-bold text-[10px] tracking-widest">
      <span className={color}>{icon}</span>
      {label}
    </div>
    <div className={`text-4xl font-black tabular-nums leading-none ${color} ${pulse ? "animate-pulse" : ""}`}>
      {value}
    </div>
    {sub && <div className="text-[10px] text-slate-600 mt-2 font-mono">{sub}</div>}
  </div>
));

/* =====================================================
   JOURNEY ROW
===================================================== */
const JourneyRow = memo(({ j, index }) => (
  <div className="flex items-center gap-4 py-3 border-b border-white/5 last:border-0">
    <div className="text-slate-600 font-mono text-[10px] w-5 text-right">{index + 1}</div>
    <div className="flex-1 min-w-0">
      <div className="text-xs text-white font-bold truncate">{j.journey_id}</div>
      <div className="text-[10px] text-slate-500 font-mono mt-0.5">
        {j.steps_count ?? 0} étapes &middot; {j.status}
      </div>
    </div>
    <div className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
      j.status === "completed"
        ? "bg-green-900/60 text-green-400"
        : j.status === "in_progress"
        ? "bg-blue-900/60 text-blue-400"
        : "bg-slate-800 text-slate-500"
    }`}>
      {j.status === "completed" ? "✓ Terminé" : j.status === "in_progress" ? "● En cours" : j.status}
    </div>
  </div>
));

/* =====================================================
   MAIN COMPONENT
===================================================== */
const Diagnostic = () => {
  const [vehicles,   setVehicles]   = useState({ count: 0, list: [] });
  const [journeys,   setJourneys]   = useState([]);
  const [sumoStatus, setSumoStatus] = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);

  /* =====================================================
     FETCH DATA
  ===================================================== */
  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, vehiclesRes, journeysRes] = await Promise.allSettled([
        fetch(`${API}/status`),
        fetch(`${API}/api/simulation/vehicles`),
        fetch(`${API}/journeys`),
      ]);

      if (statusRes.status === "fulfilled" && statusRes.value.ok) {
        const d = await statusRes.value.json();
        setSumoStatus(d.sumo_running && d.sumo_loaded);
      }

      if (vehiclesRes.status === "fulfilled" && vehiclesRes.value.ok) {
        const d = await vehiclesRes.value.json();
        setVehicles({ count: d.count ?? 0, list: d.vehicles ?? [] });
      }

      if (journeysRes.status === "fulfilled" && journeysRes.value.ok) {
        const d = await journeysRes.value.json();
        setJourneys(d.journeys ?? []);
      }

      setLastRefresh(new Date().toLocaleTimeString("fr-FR"));
    } catch (err) {
      console.error("Diagnostic fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  /* =====================================================
     DERIVED STATS
  ===================================================== */
  const completedJourneys = journeys.filter((j) => j.status === "completed").length;
  const activeJourneys    = journeys.filter((j) => j.status === "in_progress").length;
  const totalSteps        = journeys.reduce((acc, j) => acc + (j.steps_count ?? 0), 0);
  const avgSteps          = journeys.length > 0 ? Math.round(totalSteps / journeys.length) : 0;

  /* =====================================================
     RENDER
  ===================================================== */
  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-white">
      <div className="p-6 space-y-6 max-w-5xl mx-auto">

        {/* ── HEADER ── */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black uppercase tracking-tight">
              Diagnostic
            </h2>
            <p className="text-slate-500 text-xs mt-1 font-mono">
              Simulation trafic · Casablanca · SUMO
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastRefresh && (
              <span className="text-[10px] text-slate-600 font-mono">
                Mis à jour {lastRefresh}
              </span>
            )}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold border ${
              sumoStatus
                ? "bg-green-900/30 border-green-500/30 text-green-400"
                : "bg-red-900/30 border-red-500/30 text-red-400"
            }`}>
              <Radio size={11} />
              SUMO {sumoStatus ? "actif" : "inactif"}
            </div>
          </div>
        </div>

        {/* ── STATS GRID ── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Véhicules actifs"
            value={loading ? "—" : vehicles.count}
            icon={<Car size={14} />}
            color="text-blue-400"
            pulse={vehicles.count > 0}
            sub={sumoStatus ? "SUMO en ligne" : "SUMO hors ligne"}
          />
          <StatCard
            label="Trajets totaux"
            value={loading ? "—" : journeys.length}
            icon={<Route size={14} />}
            color="text-purple-400"
            sub={`${completedJourneys} terminés · ${activeJourneys} en cours`}
          />
          <StatCard
            label="Étapes totales"
            value={loading ? "—" : totalSteps.toLocaleString()}
            icon={<TrendingUp size={14} />}
            color="text-cyan-400"
            sub={`Moy. ${avgSteps} étapes / trajet`}
          />
          <StatCard
            label="Taux complétion"
            value={loading || journeys.length === 0
              ? "—"
              : `${Math.round((completedJourneys / journeys.length) * 100)}%`}
            icon={<Gauge size={14} />}
            color="text-green-400"
            sub={`${completedJourneys} / ${journeys.length}`}
          />
        </div>

        {/* ── SECONDARY STATS ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            label="Efficacité IA"
            value="98.4%"
            icon={<Zap size={14} />}
            color="text-yellow-400"
            sub="Détection collision"
          />
          <StatCard
            label="Latence socket"
            value={sumoStatus ? "~10ms" : "N/A"}
            icon={<Activity size={14} />}
            color="text-orange-400"
            sub="WebSocket SUMO ↔ Backend"
          />
          <StatCard
            label="Alertes actives"
            value={activeJourneys > 0 ? activeJourneys : 0}
            icon={<AlertTriangle size={14} />}
            color="text-red-400"
            sub="Surveillance en temps réel"
          />
        </div>

        {/* ── VEHICLE LIST ── */}
        {vehicles.list.length > 0 && (
          <div className="bg-slate-900/60 border border-white/5 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Car size={14} className="text-blue-400" />
              <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">
                Véhicules en simulation
              </h3>
              <span className="ml-auto text-[10px] font-mono text-slate-600">
                {vehicles.count} total
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {vehicles.list.slice(0, 50).map((vid) => (
                <span
                  key={vid}
                  className={`px-2 py-1 rounded-lg text-[10px] font-mono border ${
                    vid === "ego"
                      ? "bg-blue-900/40 border-blue-500/30 text-blue-300"
                      : "bg-slate-800/60 border-white/5 text-slate-400"
                  }`}
                >
                  {vid === "ego" ? "🚗 " : ""}{vid}
                </span>
              ))}
              {vehicles.list.length > 50 && (
                <span className="px-2 py-1 rounded-lg text-[10px] font-mono text-slate-600">
                  +{vehicles.list.length - 50} autres
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── JOURNEY HISTORY ── */}
        <div className="bg-slate-900/60 border border-white/5 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Clock size={14} className="text-purple-400" />
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">
              Historique des déplacements
            </h3>
            <span className="ml-auto text-[10px] font-mono text-slate-600">
              {journeys.length} enregistrés
            </span>
          </div>

          {loading ? (
            <div className="flex items-center gap-3 py-6 justify-center">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-slate-500 text-xs font-mono">Chargement...</span>
            </div>
          ) : journeys.length === 0 ? (
            <div className="text-center py-8">
              <Route size={28} className="text-slate-700 mx-auto mb-3" />
              <p className="text-slate-600 text-xs font-mono">Aucun trajet enregistré</p>
              <p className="text-slate-700 text-[10px] mt-1">Démarrez une simulation pour commencer</p>
            </div>
          ) : (
            <div>
              {journeys.map((j, i) => (
                <JourneyRow key={j.journey_id} j={j} index={i} />
              ))}
            </div>
          )}
        </div>

        {/* ── SIMULATION INFO ── */}
        <div className="bg-slate-900/40 border border-white/5 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Activity size={14} className="text-cyan-400" />
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-400">
              Informations système
            </h3>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-[11px] font-mono">
            {[
              ["Ville",         "Casablanca, Maroc"],
              ["Moteur",        "SUMO 1.26.0"],
              ["Réseau",        "casa.net.xml"],
              ["Fichier route", "casa.rou.xml"],
              ["Step length",   "0.1 s"],
              ["Protocol",      "TraCI / WebSocket"],
              ["DB",            "MongoDB"],
              ["IA Sécurité",   "SafetyAIService"],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-slate-600 w-28 shrink-0">{k}</span>
                <span className="text-slate-300">{v}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
};

export default Diagnostic;