"""
LSTMTrainService.py
===================
Service d'entraînement LSTM appelable depuis main.py via un endpoint FastAPI.
Lit les données depuis MongoDB, entraîne le modèle Keras et émet la progression
via Socket.IO en temps réel.

Intégration dans main.py :
    from src.services.LSTMTrainService import LSTMTrainService
    lstm_train_service = LSTMTrainService(sio=sio, db=db)
    ...
    await lstm_train_service.run()
"""

import os
import json
import pickle
import logging
import asyncio
from datetime import datetime
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

MODEL_DIR   = os.getenv("LSTM_MODEL_DIR", "/app/src/models")
MODEL_PATH  = os.path.join(MODEL_DIR, "lstm_traffic_model.h5")
SCALER_PATH = os.path.join(MODEL_DIR, "lstm_scaler.pkl")
META_PATH   = os.path.join(MODEL_DIR, "lstm_meta.json")

SEQ_LEN    = 30
HORIZON    = 6
FEATURES   = ["average_speed", "vehicle_count", "density", "occupancy"]
TARGET     = "average_speed"
EPOCHS     = 50
BATCH_SIZE = 32
MIN_DOCS   = 200


class LSTMTrainService:
    """
    Entraîne le modèle LSTM sur les données traffic_metrics de MongoDB.
    Émet la progression via Socket.IO à chaque étape.
    """

    def __init__(self, sio: Any, db: Any):
        """
        sio : instance AsyncServer (socket.io)
        db  : instance AsyncIOMotorDatabase (MongoDB)
        """
        self._sio = sio
        self._db  = db

    # ── Émission statut ─────────────────────────────────────────
    async def _emit(self, status: str, progress: int, message: str, extra: dict = None):
        payload = {"status": status, "progress": progress, "message": message}
        if extra:
            payload.update(extra)
        await self._sio.emit("lstm_train_status", payload)
        logger.info(f"[LSTM Train] {progress}% — {message}")

    # ── Point d'entrée principal ─────────────────────────────────
    async def run(self):
        os.makedirs(MODEL_DIR, exist_ok=True)

        # ── 1. Chargement données ────────────────────────────────
        await self._emit("loading", 5, "Chargement des données depuis MongoDB…")
        docs = await self._load_data()

        await self._emit("loading", 15, f"{len(docs)} enregistrements chargés")
        await asyncio.sleep(0.1)

        # ── 2. Préparation features ──────────────────────────────
        await self._emit("preprocessing", 20, "Préparation des séquences…")
        X_seq, y_seq, scaler_X, scaler_y = await asyncio.get_event_loop().run_in_executor(
            None, self._build_sequences, docs
        )
        await self._emit("preprocessing", 35, f"{len(X_seq)} séquences construites (seq_len={SEQ_LEN})")

        # ── 3. Construction modèle ────────────────────────────────
        await self._emit("building", 40, "Construction du modèle LSTM…")
        model = await asyncio.get_event_loop().run_in_executor(None, self._build_model)

        # ── 4. Entraînement ──────────────────────────────────────
        await self._emit("training", 45, "Entraînement en cours…")
        split   = int(len(X_seq) * 0.8)
        X_train = X_seq[:split];  y_train = y_seq[:split]
        X_val   = X_seq[split:];  y_val   = y_seq[split:]

        history, val_mae = await asyncio.get_event_loop().run_in_executor(
            None, self._train_model, model, X_train, y_train, X_val, y_val
        )
        await self._emit("training", 80, f"Entraînement terminé — MAE val : {val_mae:.2f} km/h")

        # ── 5. Sauvegarde ────────────────────────────────────────
        await self._emit("saving", 85, "Sauvegarde du modèle…")
        await asyncio.get_event_loop().run_in_executor(
            None, self._save, model, scaler_X, scaler_y, val_mae, len(X_seq)
        )
        await self._emit("saving", 95, "Modèle sauvegardé")

        # ── 6. Terminé ───────────────────────────────────────────
        await self._emit("done", 100, "Modèle LSTM prêt ✅", {
            "val_mae":   round(float(val_mae), 3),
            "n_samples": len(X_seq),
            "model_path": MODEL_PATH,
        })

    # ── Chargement MongoDB ───────────────────────────────────────
    async def _load_data(self):
        query  = {f: {"$exists": True, "$gt": 0} for f in FEATURES}
        cursor = self._db["traffic_metrics"].find(
            query,
            {"segment_id": 1, "timestamp": 1, **{f: 1 for f in FEATURES}, "_id": 0}
        ).sort("timestamp", 1).limit(50_000)

        docs = await cursor.to_list(length=50_000)

        if len(docs) < MIN_DOCS:
            logger.warning(f"Données insuffisantes ({len(docs)}), génération mock…")
            await self._emit("loading", 12, f"Données insuffisantes ({len(docs)}), génération de données mock…")
            docs = self._generate_mock(n=3000)

        return docs

    # ── Données mock ─────────────────────────────────────────────
    @staticmethod
    def _generate_mock(n: int = 3000):
        rng = np.random.default_rng(42)
        t   = np.linspace(0, 6 * np.pi, n)
        return [
            {
                "average_speed": float(np.clip(35 + 22 * np.sin(t[i]) + rng.normal(0, 4), 0, 120)),
                "vehicle_count": int(np.clip(6  + 4  * np.cos(t[i]) + rng.normal(0, 1), 0, 50)),
                "density":       float(np.clip(6  + 4  * np.cos(t[i]) + rng.normal(0, 0.5), 0, 50)),
                "occupancy":     float(np.clip(0.1 + 0.06 * np.sin(t[i]) + rng.normal(0, 0.01), 0, 1)),
            }
            for i in range(n)
        ]

    # ── Construction séquences ───────────────────────────────────
    @staticmethod
    def _build_sequences(docs):
        from sklearn.preprocessing import MinMaxScaler

        X_raw = np.array([[float(d.get(f) or 0) for f in FEATURES] for d in docs], dtype=np.float32)
        y_raw = np.array([float(d.get(TARGET) or 0) for d in docs], dtype=np.float32)

        scaler_X = MinMaxScaler()
        scaler_y = MinMaxScaler()
        X_sc = scaler_X.fit_transform(X_raw)
        y_sc = scaler_y.fit_transform(y_raw.reshape(-1, 1)).flatten()

        X_seq, y_seq = [], []
        for i in range(SEQ_LEN, len(X_sc) - HORIZON):
            X_seq.append(X_sc[i - SEQ_LEN:i])
            y_seq.append(y_sc[i + HORIZON])

        return np.array(X_seq), np.array(y_seq), scaler_X, scaler_y

    # ── Modèle LSTM ──────────────────────────────────────────────
    @staticmethod
    def _build_model():
        import tensorflow as tf
        from tensorflow.keras.models import Sequential
        from tensorflow.keras.layers import LSTM, Dense, Dropout

        model = Sequential([
            LSTM(64, input_shape=(SEQ_LEN, len(FEATURES)), return_sequences=True),
            Dropout(0.2),
            LSTM(32, return_sequences=False),
            Dropout(0.2),
            Dense(16, activation="relu"),
            Dense(1),
        ])
        model.compile(optimizer="adam", loss="mse", metrics=["mae"])
        return model

    # ── Entraînement ─────────────────────────────────────────────
    @staticmethod
    def _train_model(model, X_train, y_train, X_val, y_val):
        from tensorflow.keras.callbacks import EarlyStopping, ReduceLROnPlateau

        callbacks = [
            EarlyStopping(patience=8, restore_best_weights=True, verbose=0),
            ReduceLROnPlateau(patience=4, factor=0.5, verbose=0),
        ]
        model.fit(
            X_train, y_train,
            validation_data=(X_val, y_val),
            epochs=EPOCHS,
            batch_size=BATCH_SIZE,
            callbacks=callbacks,
            verbose=0,
        )
        _, val_mae = model.evaluate(X_val, y_val, verbose=0)
        return model.history.history, val_mae

    # ── Sauvegarde ───────────────────────────────────────────────
    @staticmethod
    def _save(model, scaler_X, scaler_y, val_mae, n_samples):
        model.save(MODEL_PATH)

        with open(SCALER_PATH, "wb") as f:
            pickle.dump({"X": scaler_X, "y": scaler_y}, f)

        meta = {
            "seq_len":    SEQ_LEN,
            "horizon":    HORIZON,
            "features":   FEATURES,
            "target":     TARGET,
            "trained_at": datetime.now().isoformat(),
            "val_mae":    float(val_mae),
            "n_samples":  n_samples,
        }
        with open(META_PATH, "w") as f:
            json.dump(meta, f, indent=2)