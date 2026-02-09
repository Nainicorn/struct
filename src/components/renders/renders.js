import template from './renders.hbs';
import './renders.css';

const renders = {
    element: null,
    data: [],

    // Initialize the renders component
    async init() {
        this.element = document.querySelector('.__sidebar-renders');
        await this._loadData();
        this._render();
        this._bindListeners();
    },

    // Load data from API
    async _loadData() {
        // TODO: Implement renders API endpoint
        this.data = [];
    },

    // Render HTML using Handlebars template
    _render() {
        let html = template({
            main: true,
            renders: this.data,
            hasRenders: this.data.length > 0
        });
        this.element.innerHTML = html;
    },

    // Bind event listeners
    _bindListeners() {
        // Handle render item clicks
        this.element.addEventListener('click', (e) => {
            const $item = e.target.closest('.__renders-item');
            if ($item) {
                const renderId = $item.dataset.id;
                this._handleRenderSelected(renderId);
            }
        });
    },

    /**
     * Handle render selection
     */
    _handleRenderSelected(renderId) {
        // Dispatch event for renderbox to handle
        const event = new CustomEvent('renderSelected', {
            detail: { id: renderId }
        });
        document.dispatchEvent(event);
    }
};

export default renders;
