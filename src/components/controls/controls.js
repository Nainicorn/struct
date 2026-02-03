import template from './controls.hbs';
import './controls.css';

const controls = {
    element: null,

    init() {
        this.element = document.querySelector('.__sidebar-controls');
        this.element.innerHTML = template();

        this._bindEvents();
    },

    _bindEvents() {
        this.element.addEventListener('click', (e) => {
            const btn = e.target.closest('.__controls-new');
            if (btn) {
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
