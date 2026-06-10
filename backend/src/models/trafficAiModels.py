# src/models/trafficAiModels.py
from pydantic import BaseModel, Field, field_validator, ConfigDict
from typing import List, Optional, Dict, Any, Literal
from datetime import datetime, timezone
from enum import Enum
import numpy as np


# ============================================================
# ENUMS ET TYPES DE BASE
# ============================================================

class TrafficCondition(str, Enum):
    FLOWING = "flowing"
    MODERATE = "moderate"
    CONGESTED = "congested"
    GRIDLOCK = "gridlock"

class WeatherCondition(str, Enum):
    CLEAR = "clear"
    CLOUDY = "cloudy"
    RAIN = "rain"
    FOG = "fog"
    SNOW = "snow"

class IncidentType(str, Enum):
    ACCIDENT = "accident"
    ROAD_WORKS = "road_works"
    EVENT = "event"
    WEATHER = "weather"
    BREAKDOWN = "breakdown"

class PredictionHorizon(str, Enum):
    SHORT = "short"      # 5-15 minutes
    MEDIUM = "medium"    # 15-60 minutes
    LONG = "long"        # 1-24 hours


# ============================================================
# MODÈLES GÉOGRAPHIQUES ET TEMPORELS
# ============================================================

class GeoPoint(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    
    def to_tuple(self) -> tuple:
        return (self.lat, self.lng)
    
    @classmethod
    def from_tuple(cls, coords: tuple):
        return cls(lat=coords[0], lng=coords[1])


class TrajectoryPoint(BaseModel):
    """Point de trajectoire pour un véhicule"""
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    coords: GeoPoint
    speed: float = 0.0  # km/h
    heading: float = 0.0  # degrés
    
    @property
    def speed_ms(self) -> float:
        """Vitesse en m/s"""
        return self.speed / 3.6


class GeoBoundingBox(BaseModel):
    min_lat: float
    max_lat: float
    min_lng: float
    max_lng: float
    
    @property
    def center(self) -> GeoPoint:
        return GeoPoint(
            lat=(self.min_lat + self.max_lat) / 2,
            lng=(self.min_lng + self.max_lng) / 2
        )
    
    def contains(self, point: GeoPoint) -> bool:
        return (self.min_lat <= point.lat <= self.max_lat and
                self.min_lng <= point.lng <= self.max_lng)


class TimeWindow(BaseModel):
    start: datetime
    end: datetime
    
    @property
    def duration_seconds(self) -> float:
        return (self.end - self.start).total_seconds()
    
    @property
    def duration_minutes(self) -> float:
        return self.duration_seconds / 60
    
    def contains(self, dt: datetime) -> bool:
        return self.start <= dt <= self.end


# ============================================================
# MODÈLES DE TRAFIC ET DÉTECTION
# ============================================================

class TrafficMetrics(BaseModel):
    """Métriques de trafic pour un segment"""
    segment_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    
    vehicle_count: int = 0
    average_speed: float = 0.0  # km/h
    occupancy: float = 0.0  # % (0-100)
    density: float = 0.0  # vehicles/km
    
    speed_percentile_25: Optional[float] = None
    speed_percentile_75: Optional[float] = None
    speed_std_dev: Optional[float] = None
    headway_average: Optional[float] = None  # seconds
    headway_std_dev: Optional[float] = None
    
    level_of_service: Literal['A', 'B', 'C', 'D', 'E', 'F'] = 'C'
    traffic_condition: TrafficCondition = TrafficCondition.MODERATE
    
    def calculate_level_of_service(self):
        """Calcule le LOS basé sur la densité (manuel HCM)"""
        if self.density < 7:
            self.level_of_service = 'A'
        elif self.density < 11:
            self.level_of_service = 'B'
        elif self.density < 16:
            self.level_of_service = 'C'
        elif self.density < 22:
            self.level_of_service = 'D'
        elif self.density < 28:
            self.level_of_service = 'E'
        else:
            self.level_of_service = 'F'
        return self.level_of_service
    
    def calculate_traffic_condition(self):
        """Détermine la condition de trafic"""
        if self.average_speed > 40:
            self.traffic_condition = TrafficCondition.FLOWING
        elif self.average_speed > 20:
            self.traffic_condition = TrafficCondition.MODERATE
        elif self.average_speed > 10:
            self.traffic_condition = TrafficCondition.CONGESTED
        else:
            self.traffic_condition = TrafficCondition.GRIDLOCK
        return self.traffic_condition


class Incident(BaseModel):
    """Incident ou perturbation sur le réseau"""
    incident_id: str
    incident_type: IncidentType
    location: GeoPoint
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    description: Optional[str] = None
    severity: Literal[1, 2, 3, 4, 5] = 3
    estimated_duration: Optional[int] = None  # minutes
    lanes_affected: Optional[int] = None
    is_resolved: bool = False
    resolved_at: Optional[datetime] = None


# ============================================================
# MODÈLES DE PRÉDICTION
# ============================================================

class PredictionFeatures(BaseModel):
    """Features pour les modèles de prédiction"""
    hour_of_day: int
    day_of_week: int
    is_weekend: bool
    is_holiday: bool
    is_rush_hour: bool
    
    historical_mean_speed: float
    historical_std_speed: float
    historical_volume: float
    
    current_speed: float
    current_occupancy: float
    current_volume: int
    
    hour_sin: float
    hour_cos: float
    day_sin: float
    day_cos: float
    
    @classmethod
    def from_timestamp(cls, dt: datetime, current_metrics: TrafficMetrics, 
                       historical_data: Dict[str, float]):
        hour = dt.hour
        weekday = dt.weekday()
        
        hour_sin = np.sin(2 * np.pi * hour / 24)
        hour_cos = np.cos(2 * np.pi * hour / 24)
        day_sin = np.sin(2 * np.pi * weekday / 7)
        day_cos = np.cos(2 * np.pi * weekday / 7)
        
        return cls(
            hour_of_day=hour,
            day_of_week=weekday,
            is_weekend=weekday >= 5,
            is_holiday=False,
            is_rush_hour=(7 <= hour <= 9) or (17 <= hour <= 19),
            historical_mean_speed=historical_data.get('mean_speed', 30),
            historical_std_speed=historical_data.get('std_speed', 5),
            historical_volume=historical_data.get('mean_volume', 100),
            current_speed=current_metrics.average_speed,
            current_occupancy=current_metrics.occupancy,
            current_volume=current_metrics.vehicle_count,
            hour_sin=float(hour_sin),
            hour_cos=float(hour_cos),
            day_sin=float(day_sin),
            day_cos=float(day_cos)
        )


class TrafficPrediction(BaseModel):
    """Prédiction de trafic"""
    # Fix Pydantic v2 Protected Namespace para model_*
    model_config = ConfigDict(protected_namespaces=())

    prediction_id: str
    segment_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    prediction_horizon: PredictionHorizon
    
    predicted_speed: float
    predicted_travel_time: float
    predicted_volume: int
    confidence_lower: float
    confidence_upper: float
    prediction_interval: List[float] = Field(default_factory=list)
    
    model_name: str
    model_version: str
    features_used: List[str] = Field(default_factory=list)
    confidence_score: float = Field(0.0, ge=0, le=1)

    # Version Pydantic v2 du Validateur de bornes
    @field_validator('confidence_upper')
    @classmethod
    def check_bounds(cls, v: float, info) -> float:
        if 'confidence_lower' in info.data and v < info.data['confidence_lower']:
            raise ValueError('Upper bound must be >= lower bound')
        return v


class RoutePrediction(BaseModel):
    """Prédiction d'itinéraire optimal"""
    route_id: str
    origin: GeoPoint
    destination: GeoPoint
    departure_time: datetime
    
    primary_route: List[str]
    alternative_routes: List[List[str]] = Field(default_factory=list)
    
    primary_travel_time: float
    primary_distance: float
    alternative_travel_times: List[float] = Field(default_factory=list)
    
    route_probabilities: List[float] = Field(default_factory=list)
    expected_travel_time: float
    
    recommended_route: List[str]
    time_saved_vs_primary: float
    confidence: float = Field(0.0, ge=0, le=1)


# ============================================================
# MODÈLES D'ANOMALIE
# ============================================================

class AnomalyDetection(BaseModel):
    """Détection d'anomalies dans les données de trafic"""
    anomaly_id: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    segment_id: str
    
    metric_name: str
    expected_value: float
    actual_value: float
    deviation: float
    anomaly_score: float = Field(0.0, ge=0, le=1)
    
    anomaly_type: Literal['point', 'contextual', 'collective'] = 'point'
    severity: Literal['low', 'medium', 'high'] = 'medium'
    
    is_incident_related: bool = False
    incident_id: Optional[str] = None
    
    @property
    def is_significant(self) -> bool:
        return abs(self.deviation) > 2.0


class PatternDetected(BaseModel):
    """Pattern récurrent détecté dans les données"""
    pattern_id: str
    pattern_type: Literal['daily', 'weekly', 'seasonal', 'event_driven']
    segment_ids: List[str]
    
    period_hours: float
    start_time: datetime
    end_time: Optional[datetime] = None
    
    peak_hour: int
    peak_volume: float
    average_speed: float
    typical_duration: float
    
    strength: float = Field(0.0, ge=0, le=1)
    consistency: float = Field(0.0, ge=0, le=1)


# ============================================================
# MODÈLES D'ENTRAÎNEMENT ML
# ============================================================

class TrainingDataset(BaseModel):
    """Dataset pour l'entraînement de modèles ML"""
    dataset_id: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    
    start_date: datetime
    end_date: datetime
    
    features: List[str] = Field(default_factory=list)
    targets: List[str] = Field(default_factory=list)
    sample_count: int = 0
    
    train_ratio: float = 0.7
    val_ratio: float = 0.15
    test_ratio: float = 0.15
    
    segment_ids: List[str] = Field(default_factory=list)
    has_weather_data: bool = False
    has_incident_data: bool = False

    # Version Pydantic v2 du Validateur de Somme de Ratios
    @field_validator('test_ratio')
    @classmethod
    def ratios_sum_to_one(cls, v: float, info) -> float:
        train = info.data.get('train_ratio', 0.0)
        val = info.data.get('val_ratio', 0.0)
        total = train + val + v
        if not 0.99 <= total <= 1.01:
            raise ValueError(f'Les ratios (train, val, test) doivent sommer à 1.0, somme actuelle : {total}')
        return v


class ModelPerformance(BaseModel):
    """Performance d'un modèle ML"""
    model_config = ConfigDict(protected_namespaces=())

    model_name: str
    model_version: str
    evaluation_timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    
    mae: float
    mse: float
    rmse: float
    mape: float
    r2: float
    
    accuracy: Optional[float] = None
    precision: Optional[float] = None
    recall: Optional[float] = None
    f1_score: Optional[float] = None
    
    short_term_mae: Optional[float] = None
    medium_term_mae: Optional[float] = None
    long_term_mae: Optional[float] = None
    
    training_dataset_id: str
    inference_time_ms: float
    model_size_mb: float


# ============================================================
# MODÈLES DE REQUÊTE POUR API
# ============================================================

class PredictionRequest(BaseModel):
    """Requête de prédiction pour l'API"""
    segment_ids: List[str]
    prediction_horizon: PredictionHorizon = PredictionHorizon.SHORT
    include_confidence: bool = True
    include_alternatives: bool = False
    
    time_window: Optional[TimeWindow] = None
    prediction_time: Optional[datetime] = None


class RouteRequest(BaseModel):
    """Requête d'optimisation d'itinéraire"""
    origin: GeoPoint
    destination: GeoPoint
    departure_time: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    
    max_alternatives: int = 3
    avoid_tolls: bool = False
    avoid_highways: bool = False
    preference: Literal['fastest', 'shortest', 'eco'] = 'fastest'
    
    use_realtime_traffic: bool = True
    prediction_horizon: PredictionHorizon = PredictionHorizon.SHORT


# ============================================================
# CONFIGURATION POUR MODÈLES SPÉCIFIQUES
# ============================================================

class ModelConfig(BaseModel):
    """Configuration pour différents types de modèles"""
    model_config = ConfigDict(protected_namespaces=())

    model_type: Literal['lstm', 'xgboost', 'random_forest', 'transformer']
    input_features: List[str]
    output_features: List[str]
    
    learning_rate: float = 0.001
    batch_size: int = 32
    epochs: int = 100
    
    hidden_layers: List[int] = Field(default_factory=list)
    dropout_rate: float = 0.2
    
    sequence_length: int = 24
    num_heads: Optional[int] = None


    # ============================================================
# UTILITAIRES POUR LE PRÉTRAITEMENT (RÉINJECTÉ)
# ============================================================

class DataPreprocessor:
    """Prétraitement des données pour l'IA"""
    
    @staticmethod
    def normalize_speed(speed: float, max_speed: float = 13.89) -> float:
        """Normalise la vitesse entre 0 et 1 (13.89 m/s = 50 km/h)"""
        return min(1.0, max(0.0, speed / max_speed))
    
    @staticmethod
    def create_time_features(dt: datetime) -> Dict[str, float]:
        """Crée des features temporelles pour les modèles ML"""
        hour = dt.hour
        minute = dt.minute
        weekday = dt.weekday()
        
        return {
            'hour_sin': float(np.sin(2 * np.pi * hour / 24)),
            'hour_cos': float(np.cos(2 * np.pi * hour / 24)),
            'minute_sin': float(np.sin(2 * np.pi * minute / 60)),
            'minute_cos': float(np.cos(2 * np.pi * minute / 60)),
            'day_sin': float(np.sin(2 * np.pi * weekday / 7)),
            'day_cos': float(np.cos(2 * np.pi * weekday / 7)),
            'is_weekend': 1.0 if weekday >= 5 else 0.0,
            'is_rush_hour': 1.0 if (7 <= hour <= 9 or 17 <= hour <= 19) else 0.0
        }
    
    @staticmethod
    def sliding_window(data: List[float], window_size: int) -> List[List[float]]:
        """Crée des fenêtres glissantes pour les séries temporelles"""
        if len(data) < window_size:
            return []
        return [data[i:i+window_size] for i in range(len(data) - window_size + 1)]
    
    @staticmethod
    def calculate_moving_average(data: List[float], window: int) -> List[float]:
        """Calcule la moyenne mobile"""
        if len(data) < window:
            return data
        return [
            sum(data[max(0, i-window):i]) / min(window, i) 
            for i in range(1, len(data)+1)
        ]


# ============================================================
# SERVICE DE PRÉDICTION DE TRAFIC (MOCK)
# ============================================================

class TrafficPredictionService:
    """Service de prédiction de trafic"""
    
    def __init__(self, model, preprocessor: DataPreprocessor):
        self.model = model
        self.preprocessor = preprocessor
    
    async def predict_traffic(self, request: PredictionRequest) -> List[TrafficPrediction]:
        """Effectue des prédictions de trafic"""
        predictions = []
        
        for segment_id in request.segment_ids:
            features = await self._extract_features(segment_id, request)
            
            # Simulation d'une inférence (mock ou modèle si chargé)
            prediction = TrafficPrediction(
                prediction_id=f"pred_{segment_id}_{datetime.now(timezone.utc).timestamp()}",
                segment_id=segment_id,
                prediction_horizon=request.prediction_horizon,
                predicted_speed=32.5,
                predicted_travel_time=4.2,
                predicted_volume=120,
                confidence_lower=25.0,
                confidence_upper=40.0,
                model_name="LSTM_Casablanca_v2",
                model_version="1.0.0",
                confidence_score=0.88
            )
            predictions.append(prediction)
        
        return predictions
    
    async def _extract_features(self, segment_id: str, request: PredictionRequest) -> Dict:
        current_time = request.prediction_time or datetime.now(timezone.utc)
        return {
            'segment_id': segment_id,
            'time_features': self.preprocessor.create_time_features(current_time),
            'prediction_horizon': request.prediction_horizon.value,
            'historical_data': {'mean_speed': 35.0, 'std_speed': 8.0, 'mean_volume': 150}
        }