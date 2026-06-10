import axios from 'axios';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:8000';

class ApiService {
  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Intercepteur pour logging de débuggage
    this.client.interceptors.request.use(
      (config) => {
        console.debug(`[API] ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => Promise.reject(error)
    );

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error(`[API Error] ${error.response?.status}: ${error.message}`);
        return Promise.reject(error);
      }
    );
  }

  // ============================================
  // SIMULATION ENDPOINTS
  // ============================================
  
  async getStatus() {
    const response = await this.client.get('/status');
    return response.data;
  }

  async startSimulation() {
    const response = await this.client.post('/simulation/start');
    return response.data;
  }

  async stopSimulation() {
    const response = await this.client.post('/simulation/stop');
    return response.data;
  }

  async getVehicles() {
    // Utilise la route exposée par FastAPI
    const response = await this.client.get('/api/simulation/vehicles');
    return response.data;
  }

  // ============================================
  // JOURNEY ENDPOINTS
  // ============================================
  
  async startJourney(origin = null, destination = null) {
    const defaultOrigin = { lat: 33.596877, lng: -7.609460 };
    const defaultDestination = { lat: 33.589000, lng: -7.620000 };
    
    const payload = {
      origin: origin || defaultOrigin,
      destination: destination || defaultDestination
    };
    
    const response = await this.client.post('/journey/start', payload);
    return response.data;
  }

  async getJourneys(limit = 20) {
    const response = await this.client.get('/journeys');
    return response.data.journeys?.slice(0, limit) || [];
  }

  async getJourneyById(journeyId) {
    const response = await this.client.get(`/journeys/${journeyId}`);
    return response.data;
  }

  // ============================================
  // TRAFFIC ANALYTICS & METRICS
  // ============================================
  
  async getTrafficStatistics() {
    const response = await this.client.get('/traffic/statistics');
    return response.data;
  }

  async getAnomalies(limit = 100) {
    const response = await this.client.get(`/traffic/anomalies?limit=${limit}`);
    return response.data;
  }

  async getAlerts(limit = 100) {
    const response = await this.client.get(`/traffic/alerts?limit=${limit}`);
    return response.data;
  }

  async getPatterns() {
    const response = await this.client.get('/traffic/patterns');
    return response.data;
  }

  // ============================================
  // AI ENDPOINTS
  // ============================================
  
  async getAIInfo() {
    // Route unique et nettoyée alignée sur le @fastapi_app.get("/ai/info")
    const response = await this.client.get('/ai/info');
    return response.data;
  }

  // ============================================
  // COMPOSITE UTILITY
  // ============================================
  
  async fetchAllData() {
    const [status, vehicles, journeys, trafficStats, anomalies, aiInfo] = await Promise.allSettled([
      this.getStatus(),
      this.getVehicles(),
      this.getJourneys(),
      this.getTrafficStatistics(),
      this.getAnomalies(20),
      this.getAIInfo(),
    ]);

    return {
      status: status.status === 'fulfilled' ? status.value : null,
      vehicles: vehicles.status === 'fulfilled' ? vehicles.value : null,
      journeys: journeys.status === 'fulfilled' ? journeys.value : [],
      trafficStats: trafficStats.status === 'fulfilled' ? trafficStats.value : null,
      anomalies: anomalies.status === 'fulfilled' ? anomalies.value.anomalies || [] : [],
      aiInfo: aiInfo.status === 'fulfilled' ? aiInfo.value : null,
    };
  }
}

export default new ApiService();