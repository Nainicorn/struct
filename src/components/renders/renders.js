import template from './renders.hbs';
import './renders.css';

const renders = {
    element: null,
    renders: [
        { id: 1, name: 'Modern Office', emoji: '🏢' },
        { id: 2, name: 'Villa Design', emoji: '🏠' },
        { id: 3, name: 'Glass Atrium', emoji: '🏛️' },
        { id: 4, name: 'Minimalist', emoji: '📐' }
    ],

    init() {
        this.element = document.querySelector('.__sidebar-renders');
        this._render();
        this._bindEvents();
    },

    _render() {
        this.element.innerHTML = template({ renders: this.renders });
    },

    _bindEvents() {
        this.element.addEventListener('click', (e) => {
            const item = e.target.closest('.__renders-item');
            if (item) {
                const renderId = item.dataset.id;
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
