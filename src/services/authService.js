// Authentication Service - Handle login and validation
import aws from './aws.js';
import cookieService from './cookieService.js';

const authenticateService = {
    // Login with credentials and set cookie
    async login(email, password) {
        try {
            const response = await aws.call('/api/auth', {
                method: 'POST',
                body: JSON.stringify({ action: 'login', email, password })
            });

            if (response && response.user) {
                // Set "builting-user" cookie with user data or token
                cookieService.set('builting-user', JSON.stringify(response.user), 60 * 24); // 24 hours
                return response.user;
            } else {
                throw new Error('Invalid response from server');
            }
        } catch (error) {
            throw new Error(error.message || 'Login failed');
        }
    },

    async signup(email, password, name) {
        try {
            const response = await aws.call('/api/auth', {
                method: 'POST',
                body: JSON.stringify({ action: 'signup', email, password, name })
            });

            if (response && response.user) {
                // Set "builting-user" cookie with user data or token
                cookieService.set('builting-user', JSON.stringify(response.user), 60 * 24); // 24 hours
                return response.user;
            } else {
                throw new Error('Invalid response from server');
            }
        } catch (error) {
            throw new Error(error.message || 'Signup failed');
        }
    },

    // Check if user is authenticated
    isAuthenticated() {
        return cookieService.get('builting-user') !== null;
    },

    // Logout - clear cookie and redirect
    logout() {
        cookieService.delete('builting-user');
        window.location.href = '/';
    }
};

export default authenticateService;
