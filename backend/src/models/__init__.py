"""Models for traffic simulation."""
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

class GeoPoint(BaseModel):
    """A point in geographic coordinates."""
    lat: float
    lng: float

class TrajectoryPoint(BaseModel):
    """A single point in a vehicle's trajectory."""
    timestamp: datetime
    coords: GeoPoint
    speed: float  # km/h
    heading: float  # degrees

class Journey(BaseModel):
    """A complete journey record."""
    journey_id: str
    user_id: str
    status: str = "active"
    origin: GeoPoint
    destination: GeoPoint
    real_time_trajectory: List[TrajectoryPoint] = []
    start_time: datetime = None
    end_time: Optional[datetime] = None
    
    def __init__(self, **data):
        if 'start_time' not in data:
            data['start_time'] = datetime.now()
        super().__init__(**data)

class SimulationStatus(BaseModel):
    """Status of the simulation."""
    status: str
    sumo_running: bool
    sumo_loaded: bool

class EmergencyAlert(BaseModel):
    """Emergency alert event."""
    event: str
    distance: str
    details: dict
    recommendation: str
