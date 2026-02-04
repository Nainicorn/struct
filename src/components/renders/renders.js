import template from './renders.hbs';
import './renders.css';

const renders = {
    // Initialize the renders component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__sidebar-renders');
        let html = template({ main: true, renders: this.data || [] });
        this.element.innerHTML = html;
    },

    // Load data from service/API
    async _loadData() {
        // TODO: Replace with actual API call to fetch renders
        // const renders = await rendersService.getAll();
        // this.data = renders;

        // Placeholder data for now
        this.data = [
            { id: 1, name: 'Modern Office', emoji: '🏢' },
            { id: 2, name: 'Villa Design', emoji: '🏠' },
            { id: 3, name: 'Glass Atrium', emoji: '🏛️' },
            { id: 4, name: 'Minimalist', emoji: '📐' }
        ];
    },

    // Bind event listeners
    _bindListeners() {
        this.element.addEventListener('click', (e) => {
            const $item = e.target.closest('.__renders-item');
            if ($item) {
                const renderId = $item.dataset.id;
                this._handleRenderSelected(renderId);
            }
        });
    },

    _handleRenderSelected(renderId) {
        // Dispatch event for renderbox to handle
        const event = new CustomEvent('renderSelected', {
            detail: { id: renderId }
        });
        document.dispatchEvent(event);
    }
};

export default renders;
