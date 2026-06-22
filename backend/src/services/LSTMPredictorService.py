"""
LSTMPredictorService.py
=======================
Service de prédiction temps réel basé sur le modèle LSTM Keras entraîné.
S'intègre dans la boucle broadcast de main.py.

Utilisation dans main.py :
    from src.services.LSTMPredictorService import LSTMPredictorService
    lstm_predictor = LSTMPredictorService()
    ...
    preds = await lstm_predictor.predict(segment_id, recent_metrics)
    await sio.emit("lstm_prediction", preds)
"""

import os
import json
import pickle
import logging
import asyncio
from collections import deque
from datetime import datetime
from typing import Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)

MODEL_PATH  = os.getenv("LSTM_MODEL_PATH",  "/app/src/models/lstm_traffic_model.h5")
SCALER_PATH = os.getenv("LSTM_SCALER_PATH", "/app/src/models/lstm_scaler.pkl")
META_PATH   = os.getenv("LSTM_META_PATH",   "/app/src/models/lstm_meta.json")

# Horizons de prédiction (en minutes simulées)
PREDICTION_HORIZONS = {
    "5min":  {"steps": 10, "label": "5 min"},
    "15min": {"steps": 30, "label": "15 min"},
    "30min": {"steps": 60, "label": "30 min"},
}

CONGESTION_THRESHOLDS = {
    "fluide":   (50, 120),   # > 50 km/h
    "modere":   (20, 50),    # 20–50 km/h
    "critique": (0,  20),    # < 20 km/h
}


def _congestion_level(speed_kmh: float) -> str:
    if speed_kmh >= 50:
        return "fluide"
    elif speed_kmh >= 20:
        return "modere"
    return "critique"


class LSTMPredictorService:
    """
    Charge le modèle LSTM Keras et prédit la vitesse future
    pour chaque segment routier actif.
    """

    def __init__(self):
        self._model        = None
        self._scaler_X     = None
        self._scaler_y     = None
        self._meta         = {}
        self._ready        = False
        self._seq_len      = 30
        self._features     = ["average_speed", "vehicle_count", "density", "occupancy"]
        # Historique glissant par segment : deque de vecteurs features
        self._history: Dict[str, deque] = {}
        self._load()

    # ── Chargement ──────────────────────────────────────────────
    def _load(self):
        if not os.path.exists(MODEL_PATH):
            logger.warning(f"LSTMPredictorService : modèle non trouvé → {MODEL_PATH}")
            logger.warning("Lancez train_lstm.py pour entraîner le modèle.")
            return

        try:
            import tensorflow as tf
            self._model = tf.keras.models.load_model(MODEL_PATH)
            logger.info(f"✅ Modèle LSTM chargé : {MODEL_PATH}")
        except Exception as e:
            logger.error(f"Erreur chargement modèle LSTM : {e}")
            return

        try:
            with open(SCALER_PATH, "rb") as f:
                scalers = pickle.load(f)
            self._scaler_X = scalers["X"]
            self._scaler_y = scalers["y"]
            logger.info("✅ Scalers LSTM chargés")
        except Exception as e:
            logger.error(f"Erreur chargement scalers : {e}")
            return

        if os.path.exists(META_PATH):
            with open(META_PATH) as f:
                self._meta = json.load(f)
            self._seq_len  = self._meta.get("seq_len", 30)
            self._features = self._meta.get("features", self._features)

        self._ready = True
        logger.info(f"✅ LSTMPredictorService prêt (seq_len={self._seq_len}, features={self._features})")

    # ── Mise à jour historique ───────────────────────────────────
    def push_metrics(self, segment_id: str, metrics: dict):
        """
        Appelé à chaque step pour chaque segment actif.
        Alimente l'historique glissant du segment.
        """
        if segment_id not in self._history:
            self._history[segment_id] = deque(maxlen=self._seq_len)

        vec = [float(metrics.get(f, 0) or 0) for f in self._features]
        self._history[segment_id].append(vec)

    # ── Prédiction ───────────────────────────────────────────────
    async def predict_segment(self, segment_id: str) -> Optional[dict]:
        """
        Retourne les prédictions pour un segment si l'historique est suffisant.
        """
        if not self._ready:
            return None

        hist = self._history.get(segment_id)
        if hist is None or len(hist) < self._seq_len:
            return None

        try:
            seq = np.array(list(hist), dtype=np.float32)           # (seq_len, n_features)
            seq_scaled = self._scaler_X.transform(seq)              # normalisation
            X = seq_scaled[np.newaxis, :, :]                        # (1, seq_len, n_features)

            # Prédiction pour chaque horizon
            horizons_result = {}
            for key, h in PREDICTION_HORIZONS.items():
                pred_scaled = float(self._model.predict(X, verbose=0)[0][0])
                pred_speed  = float(self._scaler_y.inverse_transform([[pred_scaled]])[0][0])
                pred_speed  = max(0.0, round(pred_speed, 1))
                horizons_result[key] = {
                    "label":      h["label"],
                    "speed_kmh":  pred_speed,
                    "congestion": _congestion_level(pred_speed),
                }

            current_speed = float(list(hist)[-1][0])   # dernière vitesse connue
            current_speed = float(self._scaler_X.inverse_transform(
                [list(hist)[-1]]
            )[0][0]) if self._scaler_X else current_speed

            return {
                "segment_id":     segment_id,
                "timestamp":      datetime.utcnow().isoformat(),
                "current_speed":  round(current_speed, 1),
                "current_level":  _congestion_level(current_speed),
                "predictions":    horizons_result,
                "history_len":    len(hist),
                "model_mae":      self._meta.get("val_mae", None),
            }

        except Exception as e:
            logger.debug(f"Erreur prédiction LSTM {segment_id}: {e}")
            return None

    async def predict_all(self, top_n: int = 10) -> List[dict]:
        """
        Prédit pour tous les segments avec historique complet.
        Retourne les top_n segments triés par congestion.
        """
        results = []
        for seg_id in list(self._history.keys()):
            pred = await self.predict_segment(seg_id)
            if pred:
                results.append(pred)

        # Trier par congestion (critique en premier)
        order = {"critique": 0, "modere": 1, "fluide": 2}
        results.sort(key=lambda r: order.get(r["current_level"], 3))
        return results[:top_n]

    @property
    def is_ready(self) -> bool:
        return self._ready

    @property
    def segments_tracked(self) -> int:
        return sum(1 for h in self._history.values() if len(h) >= self._seq_len)