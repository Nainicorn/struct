// AWS Service - Route to correct API endpoint
const aws = {
    // Return the base API URL depending on environment
    getBaseUrl() {
        if (window.location.hostname === 'localhost') {
            // Development: use API Gateway
            return 'https://0mc6awox4i.execute-api.us-east-1.amazonaws.com/dev';
        } else {
            // Production: use custom domain API Gateway URL
            // TODO: Replace with your actual AWS API Gateway custom domain
            return `https://api.${window.location.hostname}`;
        }
    },

    // Make authenticated API calls
    async call(endpoint, options = {}) {
        const url = `${this.getBaseUrl()}${endpoint}`;
        const response = await fetch(url, {
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.message || `API error: ${response.status}`);
        }

        return response.json();
    }
};

export default aws;
