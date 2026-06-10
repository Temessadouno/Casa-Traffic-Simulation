# backend/scripts/analyze_traffic_data.py
"""
Script d'analyse des données de trafic avec IA
À exécuter périodiquement ou via l'API
"""

import asyncio
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import UpdateOne
import numpy as np
from datetime import datetime, timedelta, timezone
import pandas as pd
import logging
import os
import sys

# Ajouter le chemin parent pour les imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class TrafficAnalyzer:
    def __init__(self, mongodb_uri=None):
        # Alignement dynamique sur les variables d'environnement du conteneur Docker
        self.mongo_uri = mongodb_uri or os.getenv("MONGO_URI", "mongodb://mongodb:27017")
        self.db_name = os.getenv("DATABASE_NAME", "simulation_db") # Correction: s'aligne sur simulation_db
        
        self.client = AsyncIOMotorClient(self.mongo_uri)
        self.db = self.client[self.db_name]
        logger.info(f"📊 Connecté à MongoDB ({self.mongo_uri}) - Base cible : {self.db_name}")

    async def get_training_data(self, days=30):
        """Récupère les données pour l'entraînement IA"""
        start_date = datetime.now(timezone.utc) - timedelta(days=days)
        
        # Récupérer les métriques de trafic
        metrics = await self.db.traffic_metrics.find({
            "timestamp": {"$gte": start_date}
        }).to_list(length=None)
        
        # Récupérer les anomalies
        anomalies = await self.db.anomalies.find({
            "timestamp": {"$gte": start_date}
        }).to_list(length=None)
        
        # Récupérer les alertes
        alerts = await self.db.alerts.find({
            "timestamp": {"$gte": start_date}
        }).to_list(length=None)
        
        logger.info(f"Données récupérées: {len(metrics)} métriques, {len(anomalies)} anomalies, {len(alerts)} alertes")
        
        return {
            "metrics": pd.DataFrame(metrics) if metrics else pd.DataFrame(),
            "anomalies": pd.DataFrame(anomalies) if anomalies else pd.DataFrame(),
            "alerts": pd.DataFrame(alerts) if alerts else pd.DataFrame()
        }

    async def detect_traffic_patterns(self):
        """Détecte les patterns de trafic récurrents en utilisant des écritures groupées (Bulk)."""
        pipeline = [
            {"$group": {
                "_id": {"hour": {"$hour": "$timestamp"}, "segment_id": "$segment_id"},
                "avg_speed": {"$avg": "$average_speed"},
                "avg_volume": {"$avg": "$vehicle_count"},
                "avg_occupancy": {"$avg": "$occupancy"},
                "sample_count": {"$sum": 1}
            }},
            {"$match": {"sample_count": {"$gt": 10}}},
            {"$sort": {"_id.hour": 1}}
        ]
        
        patterns = await self.db.traffic_metrics.aggregate(pipeline).to_list(length=None)
        
        if not patterns:
            logger.info("ℹ️ Pas assez d'échantillons de trafic (sample_count > 10) pour modéliser des patterns.")
            return []

        # Optimisation Bulk Write : Prépare toutes les opérations d'un coup
        bulk_operations = []
        now = datetime.now(timezone.utc)
        
        for pattern in patterns:
            segment_id = pattern["_id"]["segment_id"]
            hour = pattern["_id"]["hour"]
            
            bulk_operations.append(
                UpdateOne(
                    {"segment_id": segment_id, "hour": hour},
                    {"$set": {
                        "expected_speed": float(pattern["avg_speed"]),
                        "expected_volume": float(pattern["avg_volume"]),
                        "expected_occupancy": float(pattern["avg_occupancy"]),
                        "sample_count": int(pattern["sample_count"]),
                        "last_updated": now
                    }},
                    upsert=True
                )
            )
        
        # Exécution de la requête de masse en une seule passe réseau
        if bulk_operations:
            result = await self.db.traffic_patterns.bulk_write(bulk_operations, ordered=False)
            logger.info(f"✅ Patterns mis à jour : {result.modified_count}, créés (upserted) : {result.upserted_count}")
        
        return patterns

    async def predict_anomalies(self):
        """Prédit les anomalies en comparant les données temps réel aux patterns historiques calculés."""
        patterns = await self.db.traffic_patterns.find().to_list(length=None)
        
        if not patterns:
            logger.warning("⚠️ Aucun pattern de référence trouvé en base de données.")
            return []
        
        # Fenêtre d'observation : 30 dernières minutes
        start_observation = datetime.now(timezone.utc) - timedelta(minutes=30)
        current_data = await self.db.traffic_metrics.find({
            "timestamp": {"$gte": start_observation}
        }).to_list(length=None)
        
        anomalies = []
        for metric in current_data:
            # Recherche du pattern attendu correspondant au segment et à l'heure courante
            expected = next((p for p in patterns 
                             if p["segment_id"] == metric["segment_id"] 
                             and p["hour"] == metric["timestamp"].hour), None)
            
            if expected and expected["expected_speed"] > 0:
                speed_diff = abs(metric["average_speed"] - expected["expected_speed"])
                deviation_ratio = speed_diff / expected["expected_speed"]
                
                if deviation_ratio > 0.5:  # Écart supérieur à 50% par rapport à la normale
                    severity = "critical" if deviation_ratio > 0.75 else "warning"
                    anomalies.append({
                        "segment_id": metric["segment_id"],
                        "timestamp": metric["timestamp"],
                        "expected_speed": expected["expected_speed"],
                        "actual_speed": metric["average_speed"],
                        "deviation": float(deviation_ratio),
                        "severity": severity,
                        "type": "speed_anomaly"
                    })
        
        if anomalies:
            logger.warning(f"🚨 {len(anomalies)} anomalies de flux de trafic détectées à Casablanca !")
        
        return anomalies

    async def generate_training_dataset(self):
        """Génère un dataset historique optimisé pour les modèles d'apprentissage machine."""
        patterns = await self.db.traffic_patterns.find().to_list(length=None)
        metrics = await self.db.traffic_metrics.find().limit(50000).to_list(length=None) # Limite de sécurité
        
        training_data = []
        for metric in metrics:
            expected = next((p for p in patterns 
                             if p["segment_id"] == metric["segment_id"] 
                             and p["hour"] == metric["timestamp"].hour), None)
            
            if expected:
                speed_base = expected["expected_speed"]
                deviation = abs(metric["average_speed"] - speed_base) / speed_base if speed_base > 0 else 0.0
                
                training_data.append({
                    "segment_id": metric["segment_id"],
                    "timestamp": metric["timestamp"],
                    "hour": int(metric["timestamp"].hour),
                    "day_of_week": int(metric["timestamp"].weekday()),
                    "actual_speed": float(metric["average_speed"]),
                    "expected_speed": float(speed_base),
                    "actual_volume": int(metric["vehicle_count"]),
                    "expected_volume": int(expected["expected_volume"]),
                    "occupancy": float(metric["occupancy"]),
                    "deviation": float(deviation)
                })
        
        if training_data:
            dataset = {
                "created_at": datetime.now(timezone.utc),
                "samples": len(training_data),
                "features": list(training_data[0].keys()),
                "data": training_data
            }
            # Insertion directe
            await self.db.training_datasets.insert_one(dataset)
            logger.info(f"✅ Dataset d'entraînement IA généré : {len(training_data)} lignes.")
        
        return training_data

    async def run_full_analysis(self):
        """Exécute la chaîne complète de traitement analytique."""
        logger.info("🚀 Lancement du pipeline analytique global (TMT Traffic Control)...")
        try:
            # 1. Calcul et mise à jour des patterns cycliques
            patterns = await self.detect_traffic_patterns()
            
            # 2. Analyse des anomalies courantes
            anomalies = await self.predict_anomalies()
            
            # 3. Consolidation du dataset ML
            training_data = await self.generate_training_dataset()
            
            # 4. Enregistrement des statistiques d'exécution
            stats = {
                "patterns_detected": len(patterns),
                "anomalies_predicted": len(anomalies),
                "training_samples": len(training_data),
                "timestamp": datetime.now(timezone.utc)
            }
            
            await self.db.analysis_stats.insert_one(stats)
            logger.info(f"✅ Pipeline analytique achevé avec succès : {stats}")
            return stats
            
        except Exception as e:
            logger.error(f"❌ Erreur critique lors de l'exécution du pipeline analytique: {e}")
            return {}


async def run_periodic_analysis(interval_minutes=60):
    """Exécute l'analyse périodiquement de manière infinie."""
    analyzer = TrafficAnalyzer()
    while True:
        try:
            await analyzer.run_full_analysis()
        except Exception as e:
            logger.error(f"Erreur d'exécution de la boucle batch: {e}")
        
        logger.info(f"⏳ Prochaine analyse batch dans {interval_minutes} minutes...")
        await asyncio.sleep(interval_minutes * 60)


async def run_once():
    analyzer = TrafficAnalyzer()
    await analyzer.run_full_analysis()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--periodic":
        interval = int(sys.argv[2]) if len(sys.argv) > 2 else 60
        asyncio.run(run_periodic_analysis(interval))
    else:
        asyncio.run(run_once())