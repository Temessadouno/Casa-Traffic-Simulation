from pydantic_settings import BaseSettings
from typing import Optional
import os

class Settings(BaseSettings):
    # --- CONFIGURATION API ---
    APP_NAME: str = "TMT-Simulation-Accidents-IA"
    DEBUG: bool = True
    PORT: int = 8000
    
    # --- CONFIGURATION MONGODB ---
    # Ces valeurs seront automatiquement remplacées par celles du fichier .env
    MONGO_URI: str
    DATABASE_NAME: str
    
    # --- CONFIGURATION SUMO ---
    SUMO_HOME: str
    SUMO_BINARY: str = "sumo"

    class Config:
        # Chemin vers le fichier .env par rapport à l'endroit où on lance l'app
        # Puisque tu as mis le .env à la racine du backend
        env_file = ".env"
        env_file_encoding = 'utf-8'

# Instance unique (Singleton) pour être importée partout dans le projet
settings = Settings()