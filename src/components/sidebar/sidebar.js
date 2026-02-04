import template from './sidebar.hbs';
import './sidebar.css';
import controls from '../controls/controls';
import renders from '../renders/renders';

const sidebar = {
    // Initialize the sidebar component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__sidebar');
        let html = template({ main: true });
        this.element.innerHTML = html;
    },

    // Load data and initialize child components
    async _loadData() {
        await controls.init();
        await renders.init();
    },

    // Bind listeners if needed
    _bindListeners() {
        // Any sidebar listeners would go here
    }
};

export default sidebar;
