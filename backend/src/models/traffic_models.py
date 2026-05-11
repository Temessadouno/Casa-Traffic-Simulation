from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime, timezone


class GeoPoint(BaseModel):
    lat: float
    lng: float


class TrajectoryPoint(BaseModel):
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    coords: GeoPoint
    speed: float = 0.0
    heading: float = 0.0


class Journey(BaseModel):
    journey_id: str
    user_id: Optional[str] = None
    status: str = "active"

    origin: GeoPoint
    destination: GeoPoint

    real_time_trajectory: List[TrajectoryPoint] = Field(default_factory=list)

    start_time: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    end_time: Optional[datetime] = None