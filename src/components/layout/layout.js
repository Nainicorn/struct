import template from './layout.hbs';
import './layout.css';
import header from '../header/header';
import sidebar from '../sidebar/sidebar';
import renderbox from '../renderbox/renderbox';

const layout = {
    // Initialize the layout component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        const $body = document.body;
        let html = template({ main: true });
        $body.innerHTML = html;
    },

    // Load data and initialize child components
    async _loadData() {
        // Initialize all child components
        await header.init();
        await sidebar.init();
        await renderbox.init();
    },

    // Bind listeners if needed
    _bindListeners() {
        // Any global layout listeners would go here
    }
};

export default layout;
