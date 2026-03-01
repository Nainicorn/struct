import template from './sidebar.hbs';
import './sidebar.css';
import controls from '../controls/controls';
import rendersService from '../../services/rendersService.js';
import modalService from '../../services/modalService.js';
import renderbox from '../renderbox/renderbox.js';

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
                // Handle delete button click
                if (e.target.closest('.__render-delete-btn')) {
                    e.stopPropagation();
                    const renderItem = e.target.closest('.__render-item');
                    const renderId = renderItem.dataset.renderId;
                    this._handleDeleteRender(renderId);
                    return;
                }

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

        // Filter out failed renders - only show successful ones
        const successfulRenders = renders.filter(r => r.status !== 'failed');

        // Sort renders by created_at (newest first)
        const sorted = successfulRenders.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        rendersContainer.innerHTML = sorted.map(render => {
            const fullTitle = render.ai_generated_title || render.title || 'Untitled Render';
            const truncatedTitle = this._truncateToTwoWords(fullTitle);
            const status = render.status || 'unknown';
            const statusClass = `__render-status-${status}`;
            const thumbnailUrl = this._getThumbnailUrl(render);

            return `
                <div class="__render-item" data-render-id="${render.render_id}">
                    <div class="__render-item-thumbnail">
                        <div class="__render-item-image" style="background-image: url('${thumbnailUrl}')"></div>
                        <div class="__render-item-status ${statusClass}" title="${status}"></div>
                    </div>
                    <div class="__render-item-title">
                        <span title="${fullTitle}">${truncatedTitle}</span>
                        <button class="__render-delete-btn" title="Delete render">
                            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                            </svg>
                        </button>
                    </div>
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
     * Truncate title to maximum 2 words
     */
    _truncateToTwoWords(title) {
        const words = title.trim().split(/\s+/);
        return words.slice(0, 2).join(' ');
    },

    /**
     * Handle render item click
     */
    async _handleRenderClick(renderId) {
        // Check if a render is currently being generated
        if (renderbox.isRendering) {
            await modalService.alert(
                'Render In Progress',
                'A new render is currently being generated. Please wait for it to complete before viewing other renders.'
            );
            return;
        }

        // Dispatch event for renderbox and details to handle
        const event = new CustomEvent('renderSelected', {
            detail: { id: renderId }
        });
        document.dispatchEvent(event);
    },

    /**
     * Handle delete render
     */
    async _handleDeleteRender(renderId) {
        const confirmed = await modalService.confirm(
            'Delete Render',
            'Are you sure you want to delete this render? This cannot be undone.',
            'Delete',
            'Cancel'
        );

        if (!confirmed) {
            return;
        }

        try {
            await rendersService.deleteRender(renderId);

            // Hide details panel and go back to welcome screen
            document.dispatchEvent(new CustomEvent('newRenderRequested'));

            // Trigger refresh of renders list
            const event = new CustomEvent('rendersUpdated');
            document.dispatchEvent(event);
        } catch (error) {
            console.error('Error deleting render:', error);
            await modalService.alert('Error', 'Failed to delete render. Please try again.');
        }
    }
};

export default sidebar;
