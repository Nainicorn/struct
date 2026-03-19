// Simple message bus for inter-component communication
const messages = {
    channel: null,
    listeners: [],

    init() {
        // Initialize BroadcastChannel if available
        try {
            this.channel = new BroadcastChannel('app-messages');
            this.channel.onmessage = (event) => {
                this.listeners.forEach(listener => {
                    listener(event.data);
                });
            };
        } catch (error) {
            // BroadcastChannel not available — local listeners still work
        }
    },

    publish(message) {
        if (this.channel) {
            this.channel.postMessage(message);
        }
        // Also call local listeners
        this.listeners.forEach(listener => {
            listener(message);
        });
    },

    subscribe(listener) {
        this.listeners.push(listener);
        // Return unsubscribe function
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }
};

// Initialize on import
messages.init();

export default messages;
