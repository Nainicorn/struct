// AWS Service - Route to correct API endpoint
const aws = {
  // Return the base API URL depending on environment
  getBaseUrl() {
    // Always use API Gateway until custom domain is set up
    return "https://0mc6awox4i.execute-api.us-east-1.amazonaws.com/dev";
  },

  // Make authenticated API calls
  async call(endpoint, options = {}) {
    const url = `${this.getBaseUrl()}${endpoint}`;
    const response = await fetch(url, {
      credentials: 'include', // Send cookies with cross-origin requests
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || `API error: ${response.status}`);
    }

    return response.json();
  },
};

export default aws;
