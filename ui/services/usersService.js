// Users Service - Fetch user data
import aws from './aws.js';
import { userStore } from './userStore.js';

const usersService = {
    // Get current user — check userStore/localStorage first, then validate via backend
    async getCurrentUser() {
        // Try in-memory or localStorage first
        const cached = userStore.getUser();
        if (cached?.id) return cached;

        // No cached user — validate session via backend cookie
        try {
            const user = await aws.call('/api/auth', { method: 'GET' });
            if (user?.id) {
                userStore.setUser(user);
                return user;
            }
            throw new Error('Not authenticated');
        } catch (error) {
            throw new Error('Not authenticated');
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
