import traci
import os
import random
import matplotlib.pyplot as plt
import contextily as ctx
from pyproj import Transformer
from sumolib import net
from src.config.config import settings
from motor.motor_asyncio import AsyncIOMotorClient 


class SimulationService:
    def __init__(self):
        self.sumo_binary = settings.SUMO_BINARY
        # Chemin vers le fichier de config principal
        self.config_path = os.path.normpath(os.path.abspath(os.path.join("data", "test_sim.sumocfg")))
        # Chemin du fichier réseau
        self.network_path = os.path.normpath(os.path.abspath(os.path.join("data", "test.net.xml")))
        
        self.client = AsyncIOMotorClient(settings.MONGO_URI)
        self.db = self.client[settings.DATABASE_NAME]

    async def run_simulation_and_store(self, steps=100):
        # Vérification des fichiers indispensables
        if not os.path.exists(self.config_path):
            return {"status": "error", "message": f"Fichier config introuvable: {self.config_path}"}
        
        if not os.path.exists(self.network_path):
            return {"status": "error", "message": f"Fichier réseau introuvable: {self.network_path}"}

        # Chargement du réseau
        try:
            road_network = net.readNet(self.network_path)
        except Exception as e:
            return {"status": "error", "message": f"Erreur de lecture sumolib: {str(e)}"}

        sumo_cmd = [
            self.sumo_binary, 
            "-c", self.config_path,
            "--no-step-log", "true",
            "--quit-on-end", "true"
        ]
        
        try:
            traci.start(sumo_cmd)

            # --- CORRECTION : Définition des types de véhicules ---
            # Type passager
            traci.vehicletype.copy("DEFAULT_VEHTYPE", "passenger")
            traci.vehicletype.setVehicleClass("passenger", "passenger")
            
            # Type livraison (remplace 'ship' qui est invalide sur route)
            traci.vehicletype.copy("DEFAULT_VEHTYPE", "delivery")
            traci.vehicletype.setVehicleClass("delivery", "delivery")
            # -------------------------------------------------------

            valid_edges = [e for e in traci.edge.getIDList() if not e.startswith(":")]

            current_step = 0
            recorded_count = 0

            while current_step < steps:
                traci.simulationStep()

                # 1. Injection dynamique
                if len(traci.vehicle.getIDList()) < 10:
                    v_id = f"veh_{current_step}_{random.randint(0, 100)}"
                    try:
                        # On choisit deux arêtes et on tente de créer une route
                        route_edges = random.sample(valid_edges, 2)
                        traci.route.add(f"route_{v_id}", route_edges)
                        
                        # Choix du type (delivery remplace ship)
                        v_type = "delivery" if random.random() > 0.8 else "passenger"
                        traci.vehicle.add(v_id, f"route_{v_id}", typeID=v_type)
                    except traci.TraCIException:
                        # Si les arêtes ne sont pas connectées, on ignore ce véhicule
                        pass

                # 2. Capture visuelle
                if current_step % 20 == 0:
                    self._generate_live_map(road_network, current_step)

                # 3. Stockage MongoDB
                vehicles = traci.vehicle.getIDList()
                for v_id in vehicles:
                    try:
                        data = {
                            "step": current_step,
                            "vehicle_id": v_id,
                            "speed": round(traci.vehicle.getSpeed(v_id), 2),
                            "position": traci.vehicle.getPosition(v_id),
                            "lane": traci.vehicle.getLaneID(v_id),
                            "v_class": traci.vehicle.getVehicleClass(v_id),
                            "type": "multimodal_test"
                        }
                        await self.db.traffic_logs.insert_one(data)
                        recorded_count += 1
                    except Exception:
                        continue 
                
                current_step += 1

            traci.close()
            return {"status": "success", "steps": current_step, "records_saved": recorded_count}
            
        except Exception as e:
            if traci.isLoaded():
                traci.close()
            raise e
    def _generate_live_map(self, network, step):
        if not network: return
        
        fig, ax = plt.subplots(figsize=(12, 12))
        
        # 1. Configuration de la conversion SUMO (mètres) -> Web Mercator (Carte)
        # SUMO utilise souvent des coordonnées locales. Pour que contextily fonctionne,
        # il faut projeter ces points. EPSG:3857 est le standard des cartes web.
        transformer = Transformer.from_crs("epsg:4326", "epsg:3857", always_xy=True)
        
        # 2. Dessiner les véhicules avec des styles différents
        vehicles = traci.vehicle.getIDList()
        for v_id in vehicles:
            x, y = traci.vehicle.getPosition(v_id)
            v_class = traci.vehicle.getVehicleClass(v_id)
            
            # Style selon le type pour simuler des "vraies voitures"
            if v_class == "delivery":
                ax.scatter(x, y, color='blue', marker='s', s=100, label='Livraison', edgecolors='black', zorder=5)
            else:
                # On utilise un marker de type 'car' simplifié
                ax.scatter(x, y, color='red', marker='o', s=80, label='Voiture', edgecolors='white', zorder=5)

        # 3. Ajouter la carte réelle en arrière-plan
        try:
            # On force les limites du graphique sur le réseau SUMO
            boundary = network.getBoundary() # [xmin, ymin, xmax, ymax]
            ax.set_xlim(boundary[0], boundary[2])
            ax.set_ylim(boundary[1], boundary[3])
            
            # Ajout du fond de carte OpenStreetMap
            ctx.add_basemap(ax, source=ctx.providers.OpenStreetMap.Mapnik, crs='EPSG:3857')
        except Exception as e:
            print(f"Erreur carte : {e}")

        ax.set_axis_off()
        plt.title(f"Visualisation Trafic Réel - Étape {step}", fontsize=15)
        
        # Sauvegarde de l'image de trafic "vrai"
        plt.savefig(f"data/live_traffic_map_{step}.png", bbox_inches='tight', dpi=150)
        plt.close()