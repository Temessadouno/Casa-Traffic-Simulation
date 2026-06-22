// frontend/src/services/simulationStore.js
// Store partagé pour l'état de la simulation entre toutes les pages
// Pattern simple sans Redux — événements natifs du navigateur

const STORE_KEY = "tmt_sim_running";

class SimulationStore {
  constructor() {
    this._running = false;
    this._paused  = false;
    this._listeners = new Set();
    // Lire l'état persisté (survit aux navigations entre pages)
    try {
      const saved = sessionStorage.getItem(STORE_KEY);
      if (saved) {
        const s = JSON.parse(saved);
        this._running = !!s.running;
        this._paused  = !!s.paused;
      }
    } catch {}
  }

  get running() { return this._running; }
  get paused()  { return this._paused;  }

  setRunning(v) {
    this._running = v;
    if (!v) this._paused = false;
    this._persist();
    this._notify();
  }

  setPaused(v) {
    this._paused = v;
    this._persist();
    this._notify();
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    this._listeners.forEach(fn => fn({ running: this._running, paused: this._paused }));
  }

  _persist() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        running: this._running,
        paused:  this._paused,
      }));
    } catch {}
  }
}

export default new SimulationStore();