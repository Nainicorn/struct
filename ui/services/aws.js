// AWS Service - Route to correct API endpoint
import cookieService from './cookieService.js';

const API_BASE_URL = "https://0mc6awox4i.execute-api.us-east-1.amazonaws.com/dev";

const aws = {
  getBaseUrl() {
    return API_BASE_URL;
  },

  // Make authenticated API calls
  async call(endpoint, options = {}) {
    const url = `${this.getBaseUrl()}${endpoint}`;
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };

    // Send auth token via Authorization header (cross-origin cookies won't work)
    const token = cookieService.get('builting-user');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      headers,
      ...options,
    });

    // Session expired or token invalid — clear cookie and redirect to login
    if (response.status === 401) {
      cookieService.delete('builting-user');
      window.location.href = '/';
      throw new Error('Session expired. Please log in again.');
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `API error: ${response.status}`);
    }

    return response.json();
  },
};

export default aws;
