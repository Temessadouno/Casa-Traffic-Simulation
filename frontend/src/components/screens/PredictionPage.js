import React, { useState, useEffect, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Legend,
} from "recharts";
import socketService from "../../services/socket";

const API = "http://localhost:8000";

const CONGESTION = {
  fluide:   { label: "Fluide",   color: "#22c55e", bg: "#f0fdf4", border: "#86efac", text: "#15803d" },
  modere:   { label: "Modéré",   color: "#f59e0b", bg: "#fffbeb", border: "#fcd34d", text: "#92400e" },
  critique: { label: "Critique", color: "#ef4444", bg: "#fef2f2", border: "#fca5a5", text: "#991b1b" },
};

// ── Composants utilitaires ───────────────────────────────────────────────────

const Badge = ({ level }) => {
  const c = CONGESTION[level] || CONGESTION.fluide;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      background: c.bg, border: `1px solid ${c.border}`,
      color: c.text, borderRadius: 99, padding: "2px 10px",
      fontSize: 11, fontWeight: 700,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.color }} />
      {c.label}
    </span>
  );
};

const SpeedBar = ({ value, max = 90 }) => {
  const pct   = Math.min(100, (value / max) * 100);
  const color = value >= 50 ? "#22c55e" : value >= 20 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, background: "#f1f5f9", borderRadius: 99, height: 6, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 99, transition: "width 0.6s" }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 700, color, minWidth: 52, textAlign: "right" }}>
        {value} km/h
      </span>
    </div>
  );
};

const HorizonCard = ({ label, speed, level }) => {
  const c = CONGESTION[level] || CONGESTION.fluide;
  return (
    <div style={{
      flex: 1, background: "#fff", border: "1px solid #e2e8f0",
      borderTop: `3px solid ${c.color}`, borderRadius: 8,
      padding: "10px 14px", textAlign: "center", minWidth: 80,
    }}>
      <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color: c.color, lineHeight: 1 }}>{speed}</div>
      <div style={{ fontSize: 9, color: "#94a3b8", marginTop: 2 }}>km/h</div>
      <div style={{ marginTop: 6 }}><Badge level={level} /></div>
    </div>
  );
};

const SegmentRow = ({ pred, selected, onClick }) => (
  <div
    onClick={onClick}
    style={{
      padding: "10px 14px", cursor: "pointer",
      background: selected ? "#f8faff" : "#fff",
      borderLeft: selected ? "3px solid #3b82f6" : "3px solid transparent",
      borderBottom: "1px solid #f1f5f9",
      transition: "background 0.15s",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
      <span style={{ fontSize: 11, fontFamily: "monospace", color: "#334155", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {pred.segment_id}
      </span>
      <Badge level={pred.current_level} />
    </div>
    <SpeedBar value={pred.current_speed} />
  </div>
);

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)", fontSize: 12 }}>
      <div style={{ color: "#94a3b8", marginBottom: 4, fontSize: 10 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontWeight: 700 }}>{p.name} : {p.value} km/h</div>
      ))}
    </div>
  );
};

// Panneau d'entraînement LSTM
const TrainPanel = ({ onClose }) => {
  const [trainStatus, setTrainStatus] = useState(null); // null | "started" | "done" | "error"
  const [trainProgress, setTrainProgress] = useState(0);
  const [trainMessage, setTrainMessage]   = useState("");
  const [trainMeta, setTrainMeta]         = useState(null);

  useEffect(() => {
    const onStatus = (data) => {
      setTrainStatus(data.status);
      setTrainProgress(data.progress ?? 0);
      setTrainMessage(data.message ?? "");
      if (data.status === "done") {
        setTrainMeta({ val_mae: data.val_mae, n_samples: data.n_samples });
      }
    };
    socketService.on("lstm_train_status", onStatus);
    return () => socketService.off("lstm_train_status", onStatus);
  }, []);

  const startTraining = async () => {
    setTrainStatus("started");
    setTrainProgress(0);
    setTrainMessage("Lancement…");
    setTrainMeta(null);
    try {
      await fetch(`${API}/lstm/train`, { method: "POST" });
    } catch (e) {
      setTrainStatus("error");
      setTrainMessage("Impossible de contacter le backend.");
    }
  };

  const isRunning = trainStatus && trainStatus !== "done" && trainStatus !== "error";
  const barColor  = trainStatus === "error" ? "#ef4444" : trainStatus === "done" ? "#22c55e" : "#3b82f6";

  return (
    <div style={{
      position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(15,23,42,0.45)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div style={{
        background: "#fff", borderRadius: 14, padding: "28px 32px",
        width: 420, boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>Entraînement LSTM</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>Modèle de prédiction de congestion</div>
          </div>
          {!isRunning && (
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: "#94a3b8", padding: 4 }}>✕</button>
          )}
        </div>

        {/* Infos modèle */}
        <div style={{ background: "#f8fafc", borderRadius: 8, padding: "12px 14px", marginBottom: 20, fontSize: 12, color: "#475569", lineHeight: 1.8 }}>
          <div><strong>Architecture :</strong> LSTM 64 → LSTM 32 → Dense 16 → Dense 1</div>
          <div><strong>Features :</strong> vitesse, nb véhicules, densité, occupation</div>
          <div><strong>Séquence :</strong> 30 steps en entrée → prédiction à +6 steps</div>
          <div><strong>Source :</strong> collection <code>traffic_metrics</code> (MongoDB)</div>
        </div>

        {/* Barre de progression */}
        {trainStatus && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "#475569" }}>{trainMessage}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: barColor }}>{trainProgress}%</span>
            </div>
            <div style={{ background: "#f1f5f9", borderRadius: 99, height: 8, overflow: "hidden" }}>
              <div style={{
                width: `${trainProgress}%`, height: "100%",
                background: barColor, borderRadius: 99,
                transition: "width 0.4s ease",
              }} />
            </div>
          </div>
        )}

        {/* Résultat */}
        {trainStatus === "done" && trainMeta && (
          <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12 }}>
            <div style={{ color: "#15803d", fontWeight: 700, marginBottom: 4 }}>✅ Modèle prêt</div>
            <div style={{ color: "#166534" }}>MAE validation : <strong>{trainMeta.val_mae?.toFixed(2)} km/h</strong></div>
            <div style={{ color: "#166534" }}>Séquences d'entraînement : <strong>{trainMeta.n_samples?.toLocaleString()}</strong></div>
          </div>
        )}

        {trainStatus === "error" && (
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "#991b1b" }}>
            ❌ {trainMessage}
          </div>
        )}

        {/* Boutons */}
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={startTraining}
            disabled={isRunning}
            style={{
              flex: 1, padding: "10px 0", borderRadius: 8, border: "none",
              background: isRunning ? "#e2e8f0" : "#3b82f6",
              color: isRunning ? "#94a3b8" : "#fff",
              fontWeight: 700, fontSize: 13, cursor: isRunning ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {isRunning ? "Entraînement en cours…" : trainStatus === "done" ? "Ré-entraîner" : "Lancer l'entraînement"}
          </button>
          {!isRunning && (
            <button
              onClick={onClose}
              style={{
                padding: "10px 18px", borderRadius: 8,
                border: "1px solid #e2e8f0", background: "#fff",
                color: "#475569", fontWeight: 600, fontSize: 13, cursor: "pointer",
              }}
            >
              Fermer
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const EmptyState = ({ modelReady, onTrain }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: "#94a3b8" }}>
    <div style={{ fontSize: 36 }}>📡</div>
    <div style={{ fontSize: 14, fontWeight: 600, color: "#475569" }}>
      {modelReady ? "En attente de données…" : "Modèle LSTM non disponible"}
    </div>
    <div style={{ fontSize: 12, textAlign: "center", maxWidth: 260, lineHeight: 1.6 }}>
      {modelReady
        ? "Lancez une simulation pour activer les prédictions en temps réel."
        : "Entraînez le modèle pour démarrer les prédictions."}
    </div>
    {!modelReady && (
      <button
        onClick={onTrain}
        style={{
          marginTop: 8, padding: "8px 20px", borderRadius: 8,
          background: "#3b82f6", color: "#fff", border: "none",
          fontWeight: 700, fontSize: 12, cursor: "pointer",
        }}
      >
        Entraîner le modèle
      </button>
    )}
  </div>
);

// ── Page principale ──────────────────────────────────────────────────────────

export default function PredictionPage() {
  const [predictions, setPredictions] = useState([]);
  const [selected, setSelected]       = useState(null);
  const [modelReady, setModelReady]   = useState(false);
  const [socketOk, setSocketOk]       = useState(false);
  const [lastUpdate, setLastUpdate]   = useState(null);
  const [history, setHistory]         = useState([]);
  const [showTrain, setShowTrain]     = useState(false);
  const tickRef = useRef(0);

  useEffect(() => {
    // ── FIX : vérifier l'état actuel du socket immédiatement ──
    // socketService expose isConnected et socket directement (pas de getSocket)
    if (socketService.isConnected) setSocketOk(true);

    socketService.connect();

    // Re-vérifier après un court délai (socket déjà connecté = pas d'event "connect")
    const checkTimer = setTimeout(() => {
      if (socketService.isConnected || socketService.socket?.connected) setSocketOk(true);
    }, 300);

    const onConnect    = () => setSocketOk(true);
    const onDisconnect = () => setSocketOk(false);

    const onLstmPredictions = (data) => {
      if (!Array.isArray(data?.predictions)) return;
      setPredictions(data.predictions);
      setModelReady(true);
      setLastUpdate(new Date());

      tickRef.current += 1;
      const tick = tickRef.current;

      setHistory(h => {
        const point = { tick };
        data.predictions.slice(0, 5).forEach(p => {
          const key = p.segment_id.slice(-8);
          point[key] = p.current_speed;
        });
        return [...h, point].slice(-60);
      });

      if (!selected && data.predictions.length > 0) {
        setSelected(data.predictions[0].segment_id);
      }
    };

    const onSimStatus = (d) => {
      if (d.status === "stopped") {
        setPredictions([]);
        setHistory([]);
        tickRef.current = 0;
      }
    };

    const onTrainDone = (d) => {
      if (d.status === "done") setModelReady(true);
    };

    socketService.on("connect",           onConnect);
    socketService.on("disconnect",        onDisconnect);
    socketService.on("lstm_predictions",  onLstmPredictions);
    socketService.on("simulation_status", onSimStatus);
    socketService.on("lstm_train_status", onTrainDone);

    return () => {
      clearTimeout(checkTimer);
      ["connect", "disconnect", "lstm_predictions", "simulation_status", "lstm_train_status"]
        .forEach(ev => socketService.off(ev));
    };
  }, []);

  const selectedPred = predictions.find(p => p.segment_id === selected);
  const critCount = predictions.filter(p => p.current_level === "critique").length;
  const modCount  = predictions.filter(p => p.current_level === "modere").length;
  const avgSpeed  = predictions.length > 0
    ? Math.round(predictions.reduce((s, p) => s + p.current_speed, 0) / predictions.length)
    : 0;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#f8fafc", fontFamily: "system-ui, sans-serif", position: "relative" }}>

      {/* ── MODAL ENTRAÎNEMENT ── */}
      {showTrain && <TrainPanel onClose={() => setShowTrain(false)} />}

      {/* ── HEADER ── */}
      <div style={{
        background: "#fff", borderBottom: "1px solid #e2e8f0",
        padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0f172a" }}>Prédictions LSTM</h1>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            Prévision de congestion par segment routier — Casa Traffic Control
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {lastUpdate && (
            <span style={{ fontSize: 10, color: "#94a3b8" }}>
              Mis à jour {lastUpdate.toLocaleTimeString("fr-FR")}
            </span>
          )}
          {/* Bouton entraîner */}
          <button
            onClick={() => setShowTrain(true)}
            style={{
              padding: "6px 14px", borderRadius: 8,
              background: "#f1f5f9", border: "1px solid #e2e8f0",
              color: "#475569", fontWeight: 600, fontSize: 11, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            🧠 Entraîner le modèle
          </button>
          {/* Badge socket */}
          <div style={{
            display: "flex", alignItems: "center", gap: 5,
            background: socketOk ? "#f0fdf4" : "#fef2f2",
            border: `1px solid ${socketOk ? "#86efac" : "#fca5a5"}`,
            borderRadius: 99, padding: "3px 10px",
          }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: socketOk ? "#22c55e" : "#ef4444" }} />
            <span style={{ fontSize: 10, fontWeight: 600, color: socketOk ? "#15803d" : "#991b1b" }}>
              {socketOk ? "Connecté" : "Déconnecté"}
            </span>
          </div>
        </div>
      </div>

      {/* ── KPIs ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, padding: "16px 24px 0", flexShrink: 0 }}>
        {[
          { label: "Segments actifs", value: predictions.length,  color: "#3b82f6" },
          { label: "Vitesse moyenne",  value: `${avgSpeed} km/h`, color: avgSpeed >= 50 ? "#22c55e" : avgSpeed >= 20 ? "#f59e0b" : "#ef4444" },
          { label: "Zones critiques",  value: critCount,          color: critCount > 0 ? "#ef4444" : "#94a3b8" },
          { label: "Zones modérées",   value: modCount,           color: modCount  > 0 ? "#f59e0b" : "#94a3b8" },
        ].map((k, i) => (
          <div key={i} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 16px" }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: k.color }}>{k.value}</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* ── BODY ── */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "260px 1fr", gap: 12, padding: "12px 24px 20px", minHeight: 0 }}>

        {/* ── LISTE SEGMENTS ── */}
        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "10px 14px 8px", borderBottom: "1px solid #f1f5f9", flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Segments ({predictions.length})
            </span>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {predictions.length === 0
              ? <EmptyState modelReady={modelReady} onTrain={() => setShowTrain(true)} />
              : predictions.map(p => (
                  <SegmentRow
                    key={p.segment_id}
                    pred={p}
                    selected={selected === p.segment_id}
                    onClick={() => setSelected(p.segment_id)}
                  />
                ))
            }
          </div>
        </div>

        {/* ── DÉTAIL SEGMENT ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
          {selectedPred ? (
            <>
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "16px 20px", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>Segment sélectionné</div>
                    <div style={{ fontSize: 11, fontFamily: "monospace", color: "#475569", marginTop: 2 }}>{selectedPred.segment_id}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Badge level={selectedPred.current_level} />
                    <span style={{ fontSize: 18, fontWeight: 800, color: CONGESTION[selectedPred.current_level]?.color }}>
                      {selectedPred.current_speed} km/h
                    </span>
                  </div>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
                    Prévisions
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    {Object.entries(selectedPred.predictions || {}).map(([key, h]) => (
                      <HorizonCard key={key} label={h.label} speed={h.speed_kmh} level={h.congestion} />
                    ))}
                  </div>
                </div>
                {selectedPred.model_mae != null && (
                  <div style={{ fontSize: 10, color: "#94a3b8" }}>
                    Précision du modèle (MAE) : <strong>{selectedPred.model_mae.toFixed(2)} km/h</strong>
                    &nbsp;·&nbsp; Historique : {selectedPred.history_len} steps
                  </div>
                )}
              </div>

              {/* Graphique */}
              <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "16px 20px", flex: 1, minHeight: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Évolution en temps réel — top 5 segments
                </div>
                {history.length < 2 ? (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "80%", color: "#94a3b8", fontSize: 12 }}>
                    En attente de données…
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="85%">
                    <LineChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                      <XAxis dataKey="tick" tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                      <YAxis domain={[0, 90]} tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                      <Tooltip content={<CustomTooltip />} />
                      <ReferenceLine y={50} stroke="#22c55e" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <ReferenceLine y={20} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.4} />
                      <Legend wrapperStyle={{ fontSize: 10, paddingTop: 6 }} />
                      {Object.keys(history[0] || {}).filter(k => k !== "tick").map((key, i) => {
                        const colors = ["#3b82f6", "#f59e0b", "#ef4444", "#22c55e", "#8b5cf6"];
                        return (
                          <Line key={key} type="monotone" dataKey={key}
                            stroke={colors[i % colors.length]} strokeWidth={1.5}
                            dot={false} isAnimationActive={false} name={key}
                          />
                        );
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <EmptyState modelReady={modelReady} onTrain={() => setShowTrain(true)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}