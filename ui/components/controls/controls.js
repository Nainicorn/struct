import template from './controls.hbs';
import './controls.css';

const controls = {
    // Initialize the controls component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__sidebar-controls');
        let html = template({ main: true });
        this.element.innerHTML = html;
    },

    // Load data if needed
    async _loadData() {
        // No data loading needed for controls
    },

    // Bind event listeners
    _bindListeners() {
        this.element.addEventListener('click', (e) => {
            const $btn = e.target.closest('.__controls-new');
            if ($btn) {
                this._handleNewRender();
            }
        });
    },

    _handleNewRender() {
        // Dispatch event for renderbox to handle
        const event = new CustomEvent('newRenderRequested', {
            detail: { timestamp: Date.now() }
        });
        document.dispatchEvent(event);
    }
};

export default controls;
