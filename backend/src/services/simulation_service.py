import traci
import os
import random
from src.config.config import settings
from motor.motor_asyncio import AsyncIOMotorClient

class SimulationService:
    def __init__(self):
        self.sumo_binary = settings.SUMO_BINARY
        # Utiliser le chemin absolu pour éviter les erreurs de dossier de travail
        self.config_path = os.path.abspath(os.path.join("data", "test_sim.sumocfg"))
        self.client = AsyncIOMotorClient(settings.MONGO_URI)
        self.db = self.client[settings.DATABASE_NAME]

    async def run_simulation_and_store(self, steps=100):
        # 1. Vérification du fichier config
        if not os.path.exists(self.config_path):
            return {"status": "error", "message": f"Fichier config introuvable: {self.config_path}"}

        # 2. Commande de lancement avec port explicite
        sumo_cmd = [
            self.sumo_binary, 
            "-c", self.config_path,
            "--no-step-log", "true",
            "--waiting-time-memory", "1000",
            "--quit-on-end", "true"
        ]
        
        try:
            traci.start(sumo_cmd)
            
            # 3. Récupérer les vraies arêtes (edges) du réseau généré
            all_edges = traci.edge.getIDList()
            # Filtrer les arêtes internes (commençant par :)
            valid_edges = [e for e in all_edges if not e.startswith(":")]

            current_step = 0
            recorded_count = 0

            while current_step < steps:
                traci.simulationStep()

                # Injection dynamique de véhicules si le réseau est vide
                if len(traci.vehicle.getIDList()) < 5:
                    v_id = f"veh_{current_step}_{random.randint(0, 100)}"
                    # On choisit deux arêtes au hasard parmi les vraies arêtes du réseau
                    route_edges = random.sample(valid_edges, 2)
                    traci.route.add(f"route_{v_id}", route_edges)
                    traci.vehicle.add(v_id, f"route_{v_id}")

                vehicles = traci.vehicle.getIDList()
                for v_id in vehicles:
                    try:
                        data = {
                            "step": current_step,
                            "vehicle_id": v_id,
                            "speed": round(traci.vehicle.getSpeed(v_id), 2),
                            "position": traci.vehicle.getPosition(v_id),
                            "lane": traci.vehicle.getLaneID(v_id),
                            "type": "simulation_test"
                        }
                        await self.db.traffic_logs.insert_one(data)
                        recorded_count += 1
                    except Exception:
                        continue # Évite de stopper si un véhicule disparaît pile à ce step
                
                current_step += 1

            traci.close()
            return {"status": "success", "steps": current_step, "records_saved": recorded_count}
            
        except Exception as e:
            if traci.isLoaded():
                traci.close()
            raise e