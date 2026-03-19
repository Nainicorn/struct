// Authentication Service - Handle login and validation
import aws from './aws.js';
import cookieService from './cookieService.js';
import { userStore } from './userStore.js';

const authenticateService = {
    // Login with credentials and set cookie
    async login(email, password) {
        try {
            const response = await aws.call('/api/auth', {
                method: 'POST',
                body: JSON.stringify({ action: 'login', email, password })
            });

            if (response && response.user && response.token) {
                cookieService.set('builting-user', response.token, 60 * 24); // 24 hours
                userStore.setUser(response.user);
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

            if (response && response.user && response.token) {
                cookieService.set('builting-user', response.token, 60 * 24); // 24 hours
                userStore.setUser(response.user);
                return response.user;
            } else {
                throw new Error('Invalid response from server');
            }
        } catch (error) {
            throw new Error(error.message || 'Signup failed');
        }
    },

    // Check if user is authenticated (token must exist and be non-empty)
    isAuthenticated() {
        const token = cookieService.get('builting-user');
        return token !== null && token !== '';
    },

    // Logout - clear cookie and redirect
    logout() {
        cookieService.delete('builting-user');
        userStore.clear();
        window.location.href = '/';
    }
};

export default authenticateService;
