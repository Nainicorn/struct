// Users Service - Fetch user data
import aws from './aws.js';
import cookieService from './cookieService.js';

const usersService = {
    // Get current user from cookie and fetch full user data
    async getCurrentUser() {
        const userCookie = cookieService.get('builting-user');
        if (!userCookie) {
            throw new Error('No user logged in');
        }

        try {
            const user = JSON.parse(userCookie);
            // Optionally fetch full user data from backend using stored identifier
            const userData = await aws.call(`/api/users/${user.id || user.email}`, {
                method: 'GET'
            });
            return userData;
        } catch (error) {
            // If detailed fetch fails, return what we have from cookie
            try {
                return JSON.parse(userCookie);
            } catch {
                throw new Error('Failed to parse user data');
            }
        }
    },

    // Get all users (for admin/sidebar purposes)
    async getAll() {
        try {
            const response = await aws.call('/api/users', {
                method: 'GET'
            });
            return response.users || [];
        } catch (error) {
            throw new Error(error.message || 'Failed to fetch users');
        }
    },

    // Get specific user by ID
    async getById(userId) {
        try {
            const response = await aws.call(`/api/users/${userId}`, {
                method: 'GET'
            });
            return response;
        } catch (error) {
            throw new Error(error.message || 'Failed to fetch user');
        }
    }
};

export default usersService;
