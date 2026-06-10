// frontend/src/services/socket.js
import io from 'socket.io-client';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:8000';

class SocketService {
  constructor() {
    this.socket = null;
    this.listeners = new Map();
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  connect() {
    if (this.socket?.connected) {
      console.log('[Socket] Already connected');
      return;
    }

    console.log('[Socket] Connecting to', SOCKET_URL);
    this.socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: this.maxReconnectAttempts,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this._setupEventHandlers();
  }

  _setupEventHandlers() {
    // ── Connexion ──────────────────────────────────────────────────
    this.socket.on('connect', () => {
      console.log('[Socket] Connected ✅', this.socket.id);
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this._emit('connect', {});
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('[Socket] Disconnected:', reason);
      this.isConnected = false;
      this._emit('disconnect', { reason });
    });

    this.socket.on('connect_error', (error) => {
      console.error('[Socket] Connection error:', error);
      this.reconnectAttempts++;
      this._emit('connect_error', { error: error.message, attempts: this.reconnectAttempts });
    });

    // ── Véhicules ──────────────────────────────────────────────────
    this.socket.on('vehicle_state',       (d) => this._emit('vehicle_state', d));
    this.socket.on('all_vehicles_state',  (d) => this._emit('all_vehicles_state', d));
    this.socket.on('nearby_vehicles',     (d) => this._emit('nearby_vehicles', d));

    // ── Simulation ─────────────────────────────────────────────────
    this.socket.on('simulation_status',   (d) => this._emit('simulation_status', d));
    this.socket.on('journey_started',     (d) => this._emit('journey_started', d));
    this.socket.on('journey_end',         (d) => this._emit('journey_end', d));
    this.socket.on('system_error',        (d) => this._emit('system_error', d));

    // ── Trafic & IA ────────────────────────────────────────────────
    this.socket.on('traffic_anomaly',     (d) => this._emit('traffic_anomaly', d));
    this.socket.on('traffic_prediction',  (d) => this._emit('traffic_prediction', d));
    this.socket.on('traffic_summary',     (d) => this._emit('traffic_summary', d));
    this.socket.on('traffic_statistics',  (d) => this._emit('traffic_statistics', d));
    this.socket.on('prediction_response', (d) => this._emit('prediction_response', d));
    this.socket.on('optimal_route_info',  (d) => this._emit('optimal_route_info', d));

    // ── Alertes sécurité (tous les types) ─────────────────────────
    // Le backend émet principalement "emergency_alert".
    // Les handlers road_alert / accident_alert / collision_risk_alert
    // sont des alias gérés côté frontend pour séparer les affichages.
    this.socket.on('emergency_alert',       (d) => {
      // Routage intelligent selon le contenu
      const payload = { ...d, _socketEvent: 'emergency_alert' };

      if (d.event === 'ROAD_BLOCKED' || d.segment_id) {
        this._emit('road_alert', payload);
      } else if (d.event === 'ACCIDENT' || d.incident_type === 'accident') {
        this._emit('accident_alert', payload);
      } else {
        // Collision / sécurité proximité
        this._emit('emergency_alert', payload);
        this._emit('collision_risk_alert', payload);
      }
    });

    // Événements spécifiques si le backend les émet un jour directement
    this.socket.on('road_alert',           (d) => this._emit('road_alert', d));
    this.socket.on('accident_alert',       (d) => this._emit('accident_alert', d));
    this.socket.on('collision_risk_alert', (d) => this._emit('collision_risk_alert', d));
  }

  // ── Abonnements ────────────────────────────────────────────────────
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  _emit(event, data) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    handlers.forEach((cb) => {
      try { cb(data); }
      catch (err) { console.error(`[Socket] Handler error (${event}):`, err); }
    });
  }

  // ── Émissions vers le serveur ──────────────────────────────────────
  emit(event, data) {
    if (this.socket?.connected) {
      this.socket.emit(event, data);
    } else {
      console.warn(`[Socket] Cannot emit "${event}" — not connected`);
    }
  }

  startJourney(origin, destination, options = {}) {
    this.emit('start_journey', {
      origin,
      destination,
      preference:          options.preference       || 'fastest',
      use_ai_predictions:  options.useAIPredictions !== false,
    });
  }

  requestPrediction(segmentId, horizon = 'short') {
    this.emit('get_traffic_prediction', { segment_id: segmentId, horizon });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket       = null;
      this.isConnected  = false;
      this.listeners.clear();
      console.log('[Socket] Disconnected');
    }
  }
}

export default new SocketService();