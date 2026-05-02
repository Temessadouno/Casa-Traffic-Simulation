from fastapi import FastAPI, HTTPException
from motor.motor_asyncio import AsyncIOMotorClient
from src.config.config import settings  # Importation de config
from src.services.simulation_service import SimulationService  # Importation du service de simulation
import os

app = FastAPI(title=settings.APP_NAME)
simulation_service = SimulationService()

# Ce print s'affichera dans ton terminal Docker au lancement
print(f"--- Chargement de l'application : {settings.APP_NAME} ---")
print(f"--- Connexion MongoDB : {settings.MONGO_URI} ---")
# Utilisation des paramètres centralisés
client = AsyncIOMotorClient(settings.MONGO_URI)
db = client[settings.DATABASE_NAME]

@app.get("/")
async def root():
    return {
        "project": settings.APP_NAME,
        "city": "Casablanca",
        "status": "Running",
        "debug_mode": settings.DEBUG
    }

@app.get("/health/database")
async def health_db():
    try:
        await client.admin.command('ping')
        return {"status": "connected", "database": settings.DATABASE_NAME}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur MongoDB: {str(e)}")

@app.get("/health/sumo")
async def health_sumo():
    # settings.SUMO_HOME vient directement de ton .env via pydantic
    if settings.SUMO_HOME:
        return {
            "status": "installed",
            "sumo_home": settings.SUMO_HOME,
            "binary": settings.SUMO_BINARY
        }
    return {"status": "error", "message": "SUMO_HOME non configuré"}

@app.post("/simulation/start")
async def start_simulation():
    # Le moteur récupérera bientôt settings.SUMO_BINARY pour se lancer
    try:
        result = await simulation_service.run_simulation_and_store(steps=50)  # Par exemple, on peut définir le nombre de steps à 100
        # On peut lancer une boucle de simulation ici ou via un autre endpoint
        return {
                "message": "Simulation terminée avec succès",
                "details": result
            }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur SUMO : {str(e)}")
    