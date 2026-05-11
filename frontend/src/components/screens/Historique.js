import React, { useState, useEffect, useCallback, memo } from "react";
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import {
  Clock,
  MapPin,
  Gauge,
  Route,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Navigation,
} from "lucide-react";
import "leaflet/dist/leaflet.css";

const API = "http://localhost:8000";

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
   MAP FIT BOUNDS
===================================================== */
const FitBounds = ({ positions }) => {
  const map = useMap();
  useEffect(() => {
    if (positions.length > 1) {
      try { map.fitBounds(positions, { padding: [30, 30] }); } catch {}
    }
  }, [positions, map]);
  return null;
};

/* =====================================================
   POINT ICON
===================================================== */
const dotIcon = (color = "#3b82f6") =>
  L.divIcon({
    className: "",
    html: `<div style="width:8px;height:8px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4)"></div>`,
    iconSize: [8, 8],
    iconAnchor: [4, 4],
  });

/* =====================================================
   FORMAT HELPERS
===================================================== */
const formatDate = (iso) => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
};

const formatDuration = (start, end) => {
  if (!start || !end) return "—";
  const s = Math.round((new Date(end) - new Date(start)) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}min ${s % 60}s`;
};

/* =====================================================
   JOURNEY CARD
===================================================== */
const JourneyCard = memo(({ journey, isSelected, onSelect }) => {
  const statusColor =
    journey.status === "completed"  ? "text-green-400 border-green-500/30 bg-green-900/20"
    : journey.status === "in_progress" ? "text-blue-400 border-blue-500/30 bg-blue-900/20"
    : "text-slate-500 border-slate-700 bg-slate-900/20";

  return (
    <button
      onClick={() => onSelect(journey.journey_id)}
      className={`w-full text-left p-4 rounded-2xl border transition-all ${
        isSelected
          ? "bg-blue-950/60 border-blue-500/40"
          : "bg-slate-900/40 border-white/5 hover:border-white/10"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-white truncate font-mono">
            {journey.journey_id}
          </div>
          <div className="text-[10px] text-slate-500 mt-1">
            {formatDate(journey.start_time)}
          </div>
        </div>
        <div className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${statusColor}`}>
          {journey.status === "completed" ? "✓ Terminé" : "● En cours"}
        </div>
      </div>

      <div className="flex gap-4 mt-3 text-[10px] font-mono text-slate-400">
        <span>
          <Route size={9} className="inline mr-1" />
          {journey.steps_count ?? 0} étapes
        </span>
        <span>
          <Clock size={9} className="inline mr-1" />
          {formatDuration(journey.start_time, journey.end_time)}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2 text-[9px] font-mono text-slate-600">
        {isSelected ? (
          <ChevronUp size={10} className="text-blue-400" />
        ) : (
          <ChevronDown size={10} />
        )}
        {isSelected ? "Masquer la carte" : "Voir la trajectoire"}
      </div>
    </button>
  );
});

/* =====================================================
   TRAJECTORY MAP
===================================================== */
const TrajectoryMap = ({ journey }) => {
  const steps = journey?.steps ?? [];
  const positions = steps
    .filter((s) => s.coords?.lat && s.coords?.lng)
    .map((s) => [s.coords.lat, s.coords.lng]);

  const first = positions[0];
  const last  = positions[positions.length - 1];

  if (positions.length < 2) {
    return (
      <div className="flex items-center justify-center h-48 bg-slate-900/40 rounded-2xl border border-white/5">
        <p className="text-slate-600 text-xs font-mono">Pas assez de données GPS</p>
      </div>
    );
  }

  const speeds  = steps.map((s) => s.speed || 0).filter(Boolean);
  const avgSpeed = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : 0;
  const maxSpeed = speeds.length ? Math.round(Math.max(...speeds)) : 0;

  return (
    <div className="space-y-3">
      {/* Speed stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          ["Étapes",       positions.length, Route],
          ["Vit. moy.",   `${avgSpeed} km/h`, Gauge],
          ["Vit. max.",   `${maxSpeed} km/h`, Navigation],
        ].map(([label, value, Icon]) => (
          <div key={label} className="bg-slate-900/60 border border-white/5 rounded-xl p-3 text-center">
            <Icon size={12} className="text-blue-400 mx-auto mb-1" />
            <div className="text-sm font-black text-white tabular-nums">{value}</div>
            <div className="text-[9px] text-slate-600 uppercase tracking-widest">{label}</div>
          </div>
        ))}
      </div>

      {/* Map */}
      <div className="rounded-2xl overflow-hidden border border-white/5" style={{ height: 280 }}>
        <MapContainer
          center={first}
          zoom={14}
          className="h-full w-full"
          zoomControl={false}
        >
          <TileLayer
            attribution="&copy; OpenStreetMap"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitBounds positions={positions} />

          <Polyline positions={positions} color="#3b82f6" weight={4} opacity={0.9} />

          {/* Start */}
          <Marker position={first} icon={dotIcon("#22c55e")}>
            <Popup><span className="text-xs font-bold text-green-600">Départ</span></Popup>
          </Marker>

          {/* End */}
          <Marker position={last} icon={dotIcon("#ef4444")}>
            <Popup><span className="text-xs font-bold text-red-600">Arrivée</span></Popup>
          </Marker>
        </MapContainer>
      </div>

      {/* Steps sample */}
      <div className="bg-slate-900/40 border border-white/5 rounded-xl p-3 max-h-32 overflow-y-auto">
        <div className="text-[9px] font-mono text-slate-600 uppercase tracking-widest mb-2">
          Échantillon de positions
        </div>
        {steps.slice(0, 8).map((s, i) => (
          <div key={i} className="flex gap-3 text-[10px] font-mono py-1 border-b border-white/5 last:border-0">
            <span className="text-slate-600 w-5">{i + 1}</span>
            <span className="text-slate-400">
              {s.coords?.lat?.toFixed(5)}, {s.coords?.lng?.toFixed(5)}
            </span>
            <span className="text-blue-400 ml-auto">{Math.round(s.speed || 0)} km/h</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* =====================================================
   MAIN COMPONENT
===================================================== */
const Historique = () => {
  const [journeys,      setJourneys]      = useState([]);
  const [selectedId,    setSelectedId]    = useState(null);
  const [selectedData,  setSelectedData]  = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  /* =====================================================
     FETCH JOURNEYS LIST
  ===================================================== */
  const fetchJourneys = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API}/journeys`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setJourneys(data.journeys ?? []);
    } catch {
      console.error("Failed to fetch journeys");
    } finally {
      setLoading(false);
    }
  }, []);

  /* =====================================================
     FETCH JOURNEY DETAIL
  ===================================================== */
  const fetchJourneyDetail = useCallback(async (id) => {
    try {
      setDetailLoading(true);
      const res = await fetch(`${API}/journeys/${id}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setSelectedData(data);
    } catch {
      console.error("Failed to fetch journey detail");
      setSelectedData(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJourneys();
  }, [fetchJourneys]);

  const handleSelect = useCallback((id) => {
    if (selectedId === id) {
      setSelectedId(null);
      setSelectedData(null);
    } else {
      setSelectedId(id);
      fetchJourneyDetail(id);
    }
  }, [selectedId, fetchJourneyDetail]);

  /* =====================================================
     RENDER
  ===================================================== */
  return (
    <div className="h-full overflow-y-auto bg-slate-950 text-white">
      <div className="p-6 space-y-4 max-w-2xl mx-auto">

        {/* ── HEADER ── */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black uppercase tracking-tight">
              Historique
            </h2>
            <p className="text-slate-500 text-xs mt-1 font-mono">
              Trajets du véhicule suivi (ego)
            </p>
          </div>
          <button
            onClick={fetchJourneys}
            className="p-2 rounded-xl bg-slate-900 border border-white/10 hover:border-white/20 transition-all"
          >
            <RefreshCw size={14} className={`text-slate-400 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* ── SUMMARY ── */}
        <div className="grid grid-cols-3 gap-3">
          {[
            ["Total",     journeys.length,                                             "text-white"],
            ["Terminés",  journeys.filter((j) => j.status === "completed").length,     "text-green-400"],
            ["En cours",  journeys.filter((j) => j.status === "in_progress").length,   "text-blue-400"],
          ].map(([label, val, color]) => (
            <div key={label} className="bg-slate-900/60 border border-white/5 rounded-xl p-3 text-center">
              <div className={`text-2xl font-black tabular-nums ${color}`}>{val}</div>
              <div className="text-[9px] text-slate-600 uppercase tracking-widest mt-1">{label}</div>
            </div>
          ))}
        </div>

        {/* ── LIST ── */}
        {loading ? (
          <div className="flex items-center justify-center py-16 gap-3">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-slate-500 text-xs font-mono">Chargement...</span>
          </div>
        ) : journeys.length === 0 ? (
          <div className="text-center py-16">
            <MapPin size={32} className="text-slate-700 mx-auto mb-3" />
            <p className="text-slate-600 text-xs font-mono">Aucun trajet enregistré</p>
            <p className="text-slate-700 text-[10px] mt-1">
              Lancez une simulation pour générer des données
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {journeys.map((j) => (
              <div key={j.journey_id}>
                <JourneyCard
                  journey={j}
                  isSelected={selectedId === j.journey_id}
                  onSelect={handleSelect}
                />

                {/* Expanded detail */}
                {selectedId === j.journey_id && (
                  <div className="mt-2 px-1">
                    {detailLoading ? (
                      <div className="flex items-center gap-2 py-6 justify-center">
                        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-slate-500 text-xs font-mono">Chargement trajectoire...</span>
                      </div>
                    ) : selectedData ? (
                      <TrajectoryMap journey={selectedData} />
                    ) : (
                      <p className="text-slate-600 text-xs font-mono text-center py-4">
                        Données non disponibles
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Historique;