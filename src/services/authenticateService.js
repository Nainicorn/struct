// Authentication Service - Handle login and validation
import aws from './aws.js';
import cookieService from './cookieService.js';

const authenticateService = {
    // Login with credentials and set cookie
    async login(credentials) {
        try {
            const response = await aws.call('/login', {
                method: 'POST',
                body: JSON.stringify(credentials)
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
