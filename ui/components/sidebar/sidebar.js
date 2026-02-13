import template from './sidebar.hbs';
import './sidebar.css';
import controls from '../controls/controls';
import rendersService from '../../services/rendersService.js';

const sidebar = {
    element: null,

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
        await this.loadRenders();
    },

    // Bind listeners if needed
    _bindListeners() {
        // Listen for renders list updates
        document.addEventListener('rendersUpdated', () => {
            this.loadRenders();
        });

        // Delegate click events for render items
        const rendersContainer = this.element.querySelector('.__sidebar-renders');
        if (rendersContainer) {
            rendersContainer.addEventListener('click', (e) => {
                const renderItem = e.target.closest('.__render-item');
                if (renderItem) {
                    const renderId = renderItem.dataset.renderId;
                    this._handleRenderClick(renderId);
                }
            });
        }
    },

    /**
     * Load all renders for current user
     */
    async loadRenders() {
        try {
            const rendersContainer = this.element.querySelector('.__sidebar-renders');
            if (!rendersContainer) return;

            // Show loading state
            rendersContainer.innerHTML = '<div class="__renders-loading"><div class="__spinner"></div></div>';

            const data = await rendersService.getRenders();
            const renders = data.renders || [];

            if (renders.length === 0) {
                rendersContainer.innerHTML = '<div class="__renders-empty">No renders yet. Create one to get started!</div>';
                return;
            }

            // Render the list
            this._renderRendersList(renders);
        } catch (error) {
            console.error('Error loading renders:', error);
            const rendersContainer = this.element.querySelector('.__sidebar-renders');
            if (rendersContainer) {
                rendersContainer.innerHTML = '<div class="__renders-error">Failed to load renders</div>';
            }
        }
    },

    /**
     * Render list of renders as thumbnail grid
     */
    _renderRendersList(renders) {
        const rendersContainer = this.element.querySelector('.__sidebar-renders');
        if (!rendersContainer) return;

        // Sort renders by created_at (newest first)
        const sorted = renders.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        rendersContainer.innerHTML = sorted.map(render => {
            const title = render.ai_generated_title || render.title || 'Untitled Render';
            const status = render.status || 'unknown';
            const statusClass = `__render-status-${status}`;
            const thumbnailUrl = this._getThumbnailUrl(render);

            return `
                <div class="__render-item" data-render-id="${render.render_id}">
                    <div class="__render-item-thumbnail">
                        <div class="__render-item-image" style="background-image: url('${thumbnailUrl}')"></div>
                        <div class="__render-item-status ${statusClass}" title="${status}"></div>
                    </div>
                    <div class="__render-item-title">${title}</div>
                </div>
            `;
        }).join('');
    },

    /**
     * Get thumbnail URL for render (placeholder for now)
     */
    _getThumbnailUrl(render) {
        // Return a placeholder data URL based on status
        // The actual styling is done with CSS classes
        return 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"%3E%3Crect fill="%23333" width="200" height="200"/%3E%3C/svg%3E';
    },

    /**
     * Handle render item click
     */
    _handleRenderClick(renderId) {
        // Dispatch event for renderbox and details to handle
        const event = new CustomEvent('renderSelected', {
            detail: { id: renderId }
        });
        document.dispatchEvent(event);
    }
};

export default sidebar;
