import template from './details.hbs';
import './details.css';
import rendersService from '../../services/rendersService.js';

const details = {
    element: null,
    currentRender: null,

    // Initialize the details component
    async init() {
        this._render();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__details');
        let html = template({ main: true });
        this.element.innerHTML = html;
    },

    // Bind event listeners
    _bindListeners() {
        // Listen for render selection from sidebar
        document.addEventListener('renderSelected', async (e) => {
            await this.show(e.detail.render);
        });

        // Listen for new render request
        document.addEventListener('newRenderRequested', () => {
            this.hide();
        });

        // Delete button
        const deleteBtn = this.element.querySelector('.__details-delete');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                await this._handleDelete();
            });
        }
    },

    /**
     * Show render details
     */
    async show(render) {
        if (!render) return;

        this.currentRender = render;

        // Display title
        this._displayTitle(render);

        // Display description
        this._displayDescription(render);

        // Display files
        if (render.source_files && Array.isArray(render.source_files)) {
            this._displayFiles(render.source_files);
        }

        // Show the details panel
        this.element.classList.add('__details-visible');
    },

    /**
     * Hide render details
     */
    hide() {
        this.element.classList.remove('__details-visible');
        this.currentRender = null;
    },

    /**
     * Display render title
     */
    _displayTitle(render) {
        const titleEl = this.element.querySelector('.__details-title');
        if (titleEl) {
            titleEl.textContent = render.ai_generated_title || render.title || 'Untitled Render';
        }
    },

    /**
     * Display render description
     */
    _displayDescription(render) {
        const descEl = this.element.querySelector('.__details-description');
        if (descEl) {
            descEl.textContent = render.ai_generated_description || render.description || 'No description available';
        }
    },

    /**
     * Display source files as boxes
     */
    _displayFiles(fileNames) {
        const filesContainer = this.element.querySelector('.__details-files');
        if (!filesContainer) return;

        filesContainer.innerHTML = fileNames.map((fileName) => {
            const fileExt = this._getFileExtension(fileName);
            return `
                <div class="__details-file-item-box" title="${fileName}">
                    <span class="__details-file-item-box-name">${fileName}</span>
                    <span class="__details-file-item-box-badge">${fileExt}</span>
                </div>
            `;
        }).join('');
    },

    /**
     * Get file extension from filename
     */
    _getFileExtension(filename) {
        const ext = filename.split('.').pop().toUpperCase();
        return ext.length > 5 ? ext.substring(0, 5) : ext;
    },

    /**
     * Handle delete render
     */
    async _handleDelete() {
        if (!this.currentRender) return;

        const confirmed = confirm('Are you sure you want to delete this render? This cannot be undone.');
        if (!confirmed) return;

        try {
            const renderId = this.currentRender.render_id;
            console.log('Deleting render:', renderId);

            await rendersService.deleteRender(renderId);

            // Redirect to welcome screen (same as new render)
            document.dispatchEvent(new CustomEvent('newRenderRequested'));

            // Refresh renders list in sidebar
            document.dispatchEvent(new CustomEvent('rendersUpdated'));

            console.log('Render deleted successfully');
        } catch (error) {
            console.error('Error deleting render:', error);
            alert(`Failed to delete render: ${error.message}`);
        }
    }
};

export default details;
