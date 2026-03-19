import aws from './aws.js';

const sensorService = {
    _pollingInterval: null,
    _currentRenderId: null,
    _paused: false,
    _callback: null,

    async getSensors(renderId) {
        return await aws.call(`/api/renders/${renderId}/sensors`, { method: 'GET' });
    },

    async refreshSensors(renderId) {
        return await aws.call(`/api/renders/${renderId}/sensors/refresh`, { method: 'POST' });
    },

    startPolling(renderId, callback) {
        this.stopPolling();
        this._currentRenderId = renderId;
        this._callback = callback;
        this._paused = false;

        // Visibility-aware polling — pause when tab is hidden
        this._onVisibilityChange = () => {
            if (document.hidden) {
                this._paused = true;
            } else if (this._currentRenderId) {
                this._paused = false;
                this._poll(); // Immediate refresh on tab focus
            }
        };
        document.addEventListener('visibilitychange', this._onVisibilityChange);

        // Initial fetch (no refresh on first load — use seeded data)
        this._fetchAndNotify();

        // Poll every 30 seconds
        this._pollingInterval = setInterval(() => {
            if (!this._paused) this._poll();
        }, 30000);
    },

    stopPolling() {
        if (this._pollingInterval) {
            clearInterval(this._pollingInterval);
            this._pollingInterval = null;
        }
        if (this._onVisibilityChange) {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
            this._onVisibilityChange = null;
        }
        this._currentRenderId = null;
        this._callback = null;
        this._paused = false;
    },

    async _poll() {
        if (!this._currentRenderId) return;
        try {
            await this.refreshSensors(this._currentRenderId);
            await this._fetchAndNotify();
        } catch (e) {
            console.warn('Sensor poll failed:', e);
        }
    },

    async _fetchAndNotify() {
        if (!this._currentRenderId || !this._callback) return;
        try {
            const data = await this.getSensors(this._currentRenderId);
            this._callback(data.sensors || []);
        } catch (e) {
            console.warn('Sensor fetch failed:', e);
        }
    }
};

export default sensorService;
