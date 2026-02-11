import template from './renderbox.hbs';
import './renderbox.css';
import ifcViewer from '../ifc-viewer/ifc-viewer.js';

const renderbox = {
    element: null,
    viewerCanvas: null,
    stagedFiles: [], // Files waiting to be uploaded

    // Initialize the renderbox component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__renderbox');
        let html = template({ main: true });
        this.element.innerHTML = html;
        // Set initial state
        this.element.dataset.state = 'new-render';
    },

    // Load data and initialize viewer
    async _loadData() {
        await this._initViewer();
    },

    // Bind event listeners
    _bindListeners() {
        this._bindEvents();
    },

    /**
     * Update the message text in the renderbox
     */
    _updateMessage(text) {
        const messageEl = this.element.querySelector('.__renderbox-message-text');
        if (messageEl) {
            messageEl.textContent = text;
        }
    },

    /**
     * Display render metadata (title, description, source files)
     */
    _displayMetadata(render) {
        const titleEl = this.element.querySelector('.__renderbox-metadata-title');
        const descEl = this.element.querySelector('.__renderbox-metadata-description');
        const fileListEl = this.element.querySelector('.__renderbox-metadata-file-list');

        if (titleEl) {
            titleEl.textContent = render.ai_generated_title || render.title || 'Untitled Render';
        }
        if (descEl) {
            descEl.textContent = render.ai_generated_description || render.description || 'No description provided';
        }
        if (fileListEl && render.source_files && Array.isArray(render.source_files)) {
            fileListEl.innerHTML = render.source_files.map(fileName =>
                `<div class="__renderbox-metadata-file-item">${fileName}</div>`
            ).join('');
        }
    },

    /**
     * Show error message to user
     */
    _showError(message) {
        console.error('UI Error:', message);
        alert(`Error: ${message}`);
    },

    /**
     * Initialize the IFC viewer canvas and xeokit instance
     */
    async _initViewer() {
        try {
            const viewerContainer = this.element.querySelector('.__renderbox-viewer');

            // Create canvas element
            this.viewerCanvas = document.createElement('canvas');
            this.viewerCanvas.id = 'ifc-viewer-canvas';
            this.viewerCanvas.style.width = '100%';
            this.viewerCanvas.style.height = '100%';
            this.viewerCanvas.style.display = 'block';
            viewerContainer.appendChild(this.viewerCanvas);

            // Initialize xeokit viewer (async - waits for WASM to load)
            await ifcViewer.init(this.viewerCanvas);

            console.log('Viewer initialized in renderbox');

            // Load sample IFC after viewer is ready
            this._loadSampleIFC();
        } catch (error) {
            console.error('Failed to initialize viewer:', error);
            this._showError('Failed to initialize viewer');
        }
    },

    /**
     * Load IFC file from S3 (called when user selects a completed render)
     * @param {string} s3Url - Pre-signed S3 URL to IFC file
     */
    async loadIFCFromS3(s3Url) {
        try {
            const loadingIndicator = this.element.querySelector('.__renderbox-loading');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'flex';
            }

            console.log('Loading IFC from S3:', s3Url);
            await ifcViewer.loadIFC(s3Url);

            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }

            console.log('IFC file loaded successfully');
        } catch (error) {
            console.error('Failed to load IFC file:', error);
            this._showError('Failed to load IFC file: ' + error.message);

            const loadingIndicator = this.element.querySelector('.__renderbox-loading');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
        }
    },

    /**
     * Load sample IFC file (removed - no more default hardcoded IFC)
     */
    async _loadSampleIFC() {
        // Default IFC loading removed. IFC files are now loaded from S3 on user request.
        console.log('Initial state: waiting for render selection');
    },

    /**
     * Handle "New Render" button click
     */
    _handleNewRender() {
        console.log('New render requested');
        this.element.dataset.state = 'new-render';
        delete this.element.dataset.renderId;
        this._updateMessage('What do you want to render today?');
        ifcViewer.clear();
    },

    /**
     * Handle render selection from sidebar
     */
    async _handleRenderSelected(renderId) {
        console.log('Render selected:', renderId);

        try {
            const renders = await rendersapi.getRenders();
            const render = renders.find(r => r.id === renderId);

            if (!render) {
                this._showError('Render not found');
                return;
            }

            if (render.status === 'completed') {
                // Load IFC from S3
                const { downloadUrl } = await rendersapi.getDownloadUrl(renderId);
                await this.loadIFCFromS3(downloadUrl);

                this.element.dataset.state = 'viewing-render';
                this.element.dataset.renderId = renderId;
                this._updateMessage('Edit render?');
                this._displayMetadata(render);
            } else if (render.status === 'processing' || render.status === 'pending') {
                this._showError(`Render is still ${render.status}. Please try again later.`);
            } else if (render.status === 'failed') {
                this._showError(`Render failed: ${render.error_message || 'Unknown error'}`);
            }
        } catch (error) {
            console.error('Error loading render:', error);
            this._showError('Failed to load render: ' + error.message);
        }
    },

    /**
     * Handle file selection - stage files for upload (don't upload yet)
     */
    _handleFileSelected(files) {
        if (files.length === 0) {
            return;
        }

        // Add new files to staged files
        this.stagedFiles = Array.from(files);
        console.log('Files staged:', this.stagedFiles.map(f => f.name));

        // Show file preview
        this._updateFilePreview();
    },

    /**
     * Update the file preview display
     */
    _updateFilePreview() {
        const previewSection = this.element.querySelector('.__renderbox-file-preview');
        const fileList = this.element.querySelector('.__renderbox-file-list');

        if (this.stagedFiles.length === 0) {
            previewSection.style.display = 'none';
            return;
        }

        previewSection.style.display = 'block';

        // Build file list with remove buttons
        fileList.innerHTML = this.stagedFiles.map((file, index) => {
            const sizeKB = (file.size / 1024).toFixed(1);
            return `
                <div class="__renderbox-file-item">
                    <span class="__renderbox-file-name">${file.name}</span>
                    <span class="__renderbox-file-size">${sizeKB} KB</span>
                    <button class="__renderbox-file-remove" data-index="${index}" title="Remove file">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width: 16px; height: 16px;">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');

        // Bind remove buttons
        fileList.querySelectorAll('.__renderbox-file-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.dataset.index);
                this.stagedFiles.splice(index, 1);
                this._updateFilePreview();
            });
        });
    },

    /**
     * Handle "Start Render" button click - upload files and trigger pipeline
     */
    async _handleStartRender() {
        if (this.stagedFiles.length === 0) {
            this._showError('Please attach at least one file');
            return;
        }

        const descriptionInput = this.element.querySelector('.__renderbox-description');
        const description = descriptionInput.value.trim();

        try {
            // Create render + get presigned URLs
            const fileNames = this.stagedFiles.map(f => f.name);
            console.log('Creating render with files:', fileNames, 'description:', description);
            const { id: renderId, uploadUrls } = await rendersapi.createRender(fileNames, description);

            console.log('Render created:', renderId);

            // Upload files to S3
            for (const file of this.stagedFiles) {
                console.log('Uploading file:', file.name);
                await rendersapi.uploadToS3(uploadUrls[file.name], file);
            }

            console.log('Files uploaded successfully');

            // Clear staged files and preview
            this.stagedFiles = [];
            this._updateFilePreview();
            descriptionInput.value = '';

            // Trigger pipeline
            await rendersapi.triggerProcessing(renderId);

            console.log('Pipeline triggered, starting to poll...');

            // Show processing message
            this._updateMessage('Render processing...');

            // Poll for completion
            rendersapi.poll((renders) => {
                const render = renders.find(r => r.id === renderId);
                if (render && render.status === 'completed') {
                    console.log('Render completed!');
                    this._handleRenderSelected(renderId);
                } else if (render && render.status === 'failed') {
                    console.error('Render failed:', render.error_message);
                    this._showError('Render failed: ' + render.error_message);
                } else if (render) {
                    console.log('Render status:', render.status);
                }
            });
        } catch (error) {
            console.error('Error starting render:', error);
            this._showError('Failed to start render: ' + error.message);
        }
    },

    /**
     * Bind all event listeners
     */
    _bindEvents() {
        // Listen for new render requests from sidebar
        document.addEventListener('newRenderRequested', () => {
            this._handleNewRender();
        });

        // Listen for render selection from sidebar
        document.addEventListener('renderSelected', async (e) => {
            await this._handleRenderSelected(e.detail.id);
        });

        // File upload button (attach icon) click
        const attachBtn = this.element.querySelector('.__renderbox-attach');
        const fileInput = this.element.querySelector('#__renderbox-file-input');

        if (attachBtn && fileInput) {
            attachBtn.addEventListener('click', () => {
                fileInput.click();
            });

            fileInput.addEventListener('change', (e) => {
                this._handleFileSelected(e.target.files);
                // Reset input so same file can be selected again
                e.target.value = '';
            });
        }

        // Handle "Start Render" button click
        const startBtn = this.element.querySelector('.__renderbox-start');
        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                await this._handleStartRender();
            });
        }

        // Handle description input - allow submitting with Ctrl+Enter
        const descriptionInput = this.element.querySelector('.__renderbox-description');
        if (descriptionInput) {
            descriptionInput.addEventListener('keydown', async (e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                    await this._handleStartRender();
                }
            });
        }

        // Handle delete button in metadata
        const deleteBtn = this.element.querySelector('.__renderbox-metadata-delete');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                await this._handleDeleteRender();
            });
        }

        // Handle download button in metadata
        const downloadBtn = this.element.querySelector('.__renderbox-metadata-download');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', async () => {
                await this._handleDownloadRender();
            });
        }
    },

    /**
     * Handle delete render from metadata panel
     */
    async _handleDeleteRender() {
        if (!this.element.dataset.renderId) return;

        if (!confirm('Are you sure you want to delete this render? This cannot be undone.')) {
            return;
        }

        try {
            const renderId = this.element.dataset.renderId;
            console.log('Deleting render:', renderId);
            await rendersapi.deleteRender(renderId);

            // Clear the view and go back to new render
            this._handleNewRender();

            // Refresh renders list in sidebar
            document.dispatchEvent(new CustomEvent('rendersUpdated'));

            console.log('Render deleted successfully');
        } catch (error) {
            console.error('Error deleting render:', error);
            this._showError('Failed to delete render: ' + error.message);
        }
    },

    /**
     * Handle download IFC file
     */
    async _handleDownloadRender() {
        if (!this.element.dataset.renderId) return;

        try {
            const renderId = this.element.dataset.renderId;
            const { downloadUrl } = await rendersapi.getDownloadUrl(renderId);

            // Create temporary link and trigger download
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.download = `render-${renderId}.ifc`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            console.log('Download started');
        } catch (error) {
            console.error('Error downloading render:', error);
            this._showError('Failed to download render: ' + error.message);
        }
    }
};

export default renderbox;
