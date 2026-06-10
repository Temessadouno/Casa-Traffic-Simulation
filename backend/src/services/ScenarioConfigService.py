# src/services/ScenarioConfigService.py
"""
Service de configuration du scénario actif.

Responsabilités :
  - Maintenir quel scénario/dossier est utilisé pour la simulation
  - Résoudre les chemins absolus des fichiers SUMO (net, rou, cfg)
  - Valider que les fichiers requis existent avant le démarrage
  - Persister le choix dans un fichier active_scenario.json
  - Fournir le fallback vers les fichiers racine de maps/ si aucun
    scénario n'est sélectionné

Structure du dossier maps/ :
  maps/
  ├── casa.net.xml          ← fichiers actifs (fallback par défaut)
  ├── casa.rou.xml
  ├── casa.sumocfg
  ├── active_scenario.json  ← persistance du choix actif
  ├── MonScenario/
  │   ├── casa.net.xml
  │   ├── casa.rou.xml
  │   ├── casa.sumocfg
  │   └── metadata.json
  └── scenario_20260609_120000/
      ├── ...
      └── metadata.json
"""

import os
import json
import shutil
import logging
from typing import Optional, Dict, List

logger = logging.getLogger(__name__)

# Fichiers SUMO requis pour une simulation valide
REQUIRED_FILES = ["casa.net.xml", "casa.rou.xml", "casa.sumocfg"]
ACTIVE_STATE_FILE = "active_scenario.json"


class ScenarioConfigService:
    """
    Gère la sélection et la validation du scénario actif.
    """

    def __init__(self, sumo_data_dir: str):
        self.sumo_data_dir = sumo_data_dir
        self._active_scenario_id: Optional[str] = None  # None = fichiers racine
        os.makedirs(sumo_data_dir, exist_ok=True)
        self._load_active_state()

    # ── Persistance de l'état actif ───────────────────────────────────────────

    def _state_path(self) -> str:
        return os.path.join(self.sumo_data_dir, ACTIVE_STATE_FILE)

    def _load_active_state(self):
        """Charge le scénario actif depuis le fichier de persistance."""
        try:
            path = self._state_path()
            if os.path.exists(path):
                with open(path) as f:
                    data = json.load(f)
                sc_id = data.get("active_scenario_id")
                # Vérifier que le dossier existe encore
                if sc_id:
                    sc_dir = os.path.join(self.sumo_data_dir, sc_id)
                    if os.path.isdir(sc_dir):
                        self._active_scenario_id = sc_id
                        logger.info(f"✅ Scénario actif chargé : {sc_id}")
                        return
                    else:
                        logger.warning(f"⚠️ Scénario {sc_id} introuvable, retour au fallback")
        except Exception as e:
            logger.warning(f"Impossible de charger l'état actif : {e}")
        self._active_scenario_id = None

    def _save_active_state(self):
        """Persiste le scénario actif."""
        try:
            with open(self._state_path(), "w") as f:
                json.dump({
                    "active_scenario_id": self._active_scenario_id,
                    "updated_at": __import__("datetime").datetime.utcnow().isoformat(),
                }, f, indent=2)
        except Exception as e:
            logger.warning(f"Impossible de sauvegarder l'état actif : {e}")

    # ── Résolution des chemins ─────────────────────────────────────────────────

    def get_active_dir(self) -> str:
        """
        Retourne le dossier contenant les fichiers SUMO actifs.
        - Si un scénario est sélectionné → maps/<scenario_id>/
        - Sinon → maps/ (fichiers racine)
        """
        if self._active_scenario_id:
            sc_dir = os.path.join(self.sumo_data_dir, self._active_scenario_id)
            if os.path.isdir(sc_dir):
                return sc_dir
            else:
                logger.warning(f"Dossier scénario disparu : {sc_dir}, retour au fallback")
                self._active_scenario_id = None
                self._save_active_state()
        return self.sumo_data_dir

    def get_config_path(self) -> str:
        """Chemin absolu du .sumocfg actif."""
        return os.path.join(self.get_active_dir(), "casa.sumocfg")

    def get_active_scenario_id(self) -> Optional[str]:
        """ID du scénario actif, ou None si fichiers racine."""
        return self._active_scenario_id

    def get_active_scenario_info(self) -> Dict:
        """
        Retourne les infos du scénario actif (métadonnées si dispo).
        """
        if self._active_scenario_id:
            meta_path = os.path.join(
                self.sumo_data_dir, self._active_scenario_id, "metadata.json"
            )
            if os.path.exists(meta_path):
                try:
                    with open(meta_path) as f:
                        meta = json.load(f)
                    return {
                        "source":      "scenario",
                        "scenario_id": self._active_scenario_id,
                        "dir":         self.get_active_dir(),
                        **meta,
                    }
                except Exception:
                    pass
            return {
                "source":      "scenario",
                "scenario_id": self._active_scenario_id,
                "dir":         self.get_active_dir(),
            }
        # Fallback : fichiers racine
        return {
            "source":      "default",
            "scenario_id": None,
            "dir":         self.sumo_data_dir,
            "note":        "Fichiers de simulation par défaut dans maps/",
        }

    # ── Patch .sumocfg ────────────────────────────────────────────────────────

    def patch_sumocfg(self, cfg_path: str) -> bool:
        """
        Patche UNIQUEMENT les scénarios générés (pas les fichiers par défaut).
        Pour les fichiers par défaut, le .sumocfg est utilisé tel quel.
        """
        # Ne jamais modifier le sumocfg des fichiers par défaut
        if not self._active_scenario_id:
            logger.info(f"Mode défaut — .sumocfg utilisé sans modification")
            return True
        try:
            import xml.etree.ElementTree as ET
            tree = ET.parse(cfg_path)
            root = tree.getroot()

            # ── Section <processing> ──
            processing = root.find("processing")
            if processing is None:
                processing = ET.SubElement(root, "processing")

            # ignore-route-errors — nécessaire pour les scénarios générés
            el = processing.find("ignore-route-errors")
            if el is None:
                el = ET.SubElement(processing, "ignore-route-errors")
            el.set("value", "true")

            # time-to-teleport — laisser -1 si déjà défini, sinon 120
            ttp = processing.find("time-to-teleport")
            if ttp is None:
                ttp = ET.SubElement(processing, "time-to-teleport")
                ttp.set("value", "120")
            # Ne PAS écraser une valeur existante (respecter le choix de l'utilisateur)

            tree.write(cfg_path, encoding="unicode", xml_declaration=True)
            logger.info(f"✅ .sumocfg patché : {cfg_path}")
            return True
        except Exception as e:
            logger.warning(f"patch_sumocfg failed : {e}")
            return False

    def patch_active_sumocfg(self) -> bool:
        """Patche le .sumocfg du scénario actif."""
        return self.patch_sumocfg(self.get_config_path())

    # ── Validation ─────────────────────────────────────────────────────────────

    def _read_sumocfg_files(self, cfg_path: str) -> Dict[str, str]:
        """
        Lit le .sumocfg et retourne les noms de fichiers référencés
        (net-file, route-files, additional-files).
        """
        refs = {}
        try:
            import xml.etree.ElementTree as ET
            tree = ET.parse(cfg_path)
            root = tree.getroot()
            for tag, key in [
                ("net-file",        "net"),
                ("route-files",     "rou"),
                ("additional-files","add"),
            ]:
                el = root.find(f".//{tag}")
                if el is not None:
                    refs[key] = el.get("value", "")
        except Exception:
            pass
        return refs

    def get_net_path(self) -> str:
        """Chemin absolu du .net.xml actif (lu depuis le sumocfg si possible)."""
        cfg = self.get_config_path()
        refs = self._read_sumocfg_files(cfg)
        net_name = refs.get("net", "casa.net.xml")
        return os.path.join(self.get_active_dir(), net_name)

    def get_rou_path(self) -> str:
        """Chemin absolu du .rou.xml actif (lu depuis le sumocfg si possible)."""
        cfg = self.get_config_path()
        refs = self._read_sumocfg_files(cfg)
        # route-files peut être une liste séparée par des virgules
        rou_names = refs.get("rou", "casa.rou.xml")
        # Prendre le premier fichier non-piéton
        for name in rou_names.split(","):
            name = name.strip()
            if name:
                return os.path.join(self.get_active_dir(), name)
        return os.path.join(self.get_active_dir(), "casa.rou.xml")

    def validate(self) -> Dict:
        """
        Vérifie que les fichiers référencés dans le .sumocfg existent.
        Lit les vrais noms de fichiers depuis le .sumocfg.
        """
        active_dir  = self.get_active_dir()
        cfg_path    = os.path.join(active_dir, "casa.sumocfg")
        files_info  = {}
        missing     = []

        # Vérifier le sumocfg lui-même
        if not os.path.exists(cfg_path):
            return {
                "valid":       False,
                "missing":     ["casa.sumocfg"],
                "dir":         active_dir,
                "scenario_id": self._active_scenario_id,
                "files":       {"casa.sumocfg": {"path": cfg_path, "exists": False}},
            }

        files_info["casa.sumocfg"] = {
            "path": cfg_path, "size": os.path.getsize(cfg_path), "exists": True
        }

        # Lire les fichiers référencés dans le sumocfg
        refs     = self._read_sumocfg_files(cfg_path)
        net_name = refs.get("net", "casa.net.xml")
        rou_raw  = refs.get("rou", "casa.rou.xml")
        rou_names = [n.strip() for n in rou_raw.split(",") if n.strip()]
        if not rou_names:
            rou_names = ["casa.rou.xml"]

        for fname in [net_name] + rou_names:
            fpath = os.path.join(active_dir, fname)
            if os.path.exists(fpath):
                files_info[fname] = {
                    "path":  fpath,
                    "size":  os.path.getsize(fpath),
                    "exists": True,
                }
            else:
                missing.append(fname)
                files_info[fname] = {"path": fpath, "exists": False}

        return {
            "valid":       len(missing) == 0,
            "missing":     missing,
            "dir":         active_dir,
            "scenario_id": self._active_scenario_id,
            "files":       files_info,
        }

    # ── Sélection / déploiement ────────────────────────────────────────────────

    def select_scenario(self, scenario_id: str) -> Dict:
        """
        Sélectionne un scénario comme actif SANS copier les fichiers.
        La simulation pointera directement vers maps/<scenario_id>/.

        Returns dict avec success, message, validation.
        """
        sc_dir = os.path.join(self.sumo_data_dir, scenario_id)

        if not os.path.isdir(sc_dir):
            return {
                "success": False,
                "message": f"Dossier introuvable : {scenario_id}",
            }

        # Vérifier que les fichiers requis sont présents
        missing = [
            f for f in REQUIRED_FILES
            if not os.path.exists(os.path.join(sc_dir, f))
        ]
        if missing:
            return {
                "success": False,
                "message": f"Fichiers manquants dans {scenario_id} : {missing}",
                "missing": missing,
            }

        self._active_scenario_id = scenario_id
        self._save_active_state()

        logger.info(f"✅ Scénario sélectionné : {scenario_id} → {sc_dir}")
        return {
            "success":     True,
            "scenario_id": scenario_id,
            "dir":         sc_dir,
            "message":     f"Scénario '{scenario_id}' sélectionné — prêt à démarrer",
        }

    def select_default(self) -> Dict:
        """
        Revient aux fichiers racine de maps/ (pas de scénario sélectionné).
        """
        self._active_scenario_id = None
        self._save_active_state()
        logger.info("✅ Retour aux fichiers de simulation par défaut (maps/)")

        validation = self.validate()
        return {
            "success":     True,
            "scenario_id": None,
            "dir":         self.sumo_data_dir,
            "message":     "Fichiers par défaut sélectionnés",
            "valid":       validation["valid"],
            "missing":     validation["missing"],
        }

    def deploy_and_select(self, scenario_id: str) -> Dict:
        """
        Copie les fichiers du scénario vers maps/ ET le sélectionne.
        Utile pour maintenir la compatibilité avec l'ancien comportement.
        """
        sc_dir = os.path.join(self.sumo_data_dir, scenario_id)
        if not os.path.isdir(sc_dir):
            return {"success": False, "message": f"Scénario introuvable : {scenario_id}"}

        copied = []
        for fname in REQUIRED_FILES + ["casa.ped.xml"]:
            src = os.path.join(sc_dir, fname)
            if os.path.exists(src):
                dst = os.path.join(self.sumo_data_dir, fname)
                shutil.copy2(src, dst)
                copied.append(fname)

        self._active_scenario_id = scenario_id
        self._save_active_state()

        logger.info(f"✅ Déployé et sélectionné : {scenario_id} ({copied})")
        return {
            "success":        True,
            "scenario_id":    scenario_id,
            "copied_files":   copied,
            "message":        f"'{scenario_id}' déployé et activé",
        }

    # ── Liste des scénarios disponibles ───────────────────────────────────────

    def list_scenarios(self) -> List[Dict]:
        """
        Liste tous les scénarios dans sumo_data_dir (dossiers avec metadata.json).
        Marque le scénario actif.
        """
        scenarios = []
        try:
            for name in sorted(os.listdir(self.sumo_data_dir), reverse=True):
                path = os.path.join(self.sumo_data_dir, name)
                if not os.path.isdir(path):
                    continue
                # Accepter tous les dossiers qui ont au moins le net.xml
                net = os.path.join(path, "casa.net.xml")
                if not os.path.exists(net):
                    continue

                meta = {"scenario_id": name}
                meta_path = os.path.join(path, "metadata.json")
                if os.path.exists(meta_path):
                    try:
                        with open(meta_path) as f:
                            meta = json.load(f)
                    except Exception:
                        pass

                meta["is_active"] = (name == self._active_scenario_id)
                meta["files_valid"] = all(
                    os.path.exists(os.path.join(path, f)) for f in REQUIRED_FILES
                )
                scenarios.append(meta)
        except Exception as e:
            logger.warning(f"list_scenarios error : {e}")
        return scenarios