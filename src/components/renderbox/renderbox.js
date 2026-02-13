import template from './renderbox.hbs';
import './renderbox.css';
import ifcViewer from '../ifc-viewer/ifc-viewer.js';
import uploadService from '../../services/uploadService.js';
import usersService from '../../services/usersService.js';
import rendersService from '../../services/rendersService.js';

const renderbox = {
    element: null,
    viewerCanvas: null,
    stagedFiles: [], // Files waiting to be uploaded
    MAX_FILES: 10, // Maximum number of files allowed
    pollingInterval: null,
    currentRenderId: null,
    pollingStartTime: null,

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
        try {
            this.user = await usersService.getCurrentUser();
            this._updateUserDisplay();
        } catch (error) {
            console.error('Failed to load user:', error);
        }
        await this._initViewer();
    },

    // Update user display in renderbox
    _updateUserDisplay() {
        if (this.user) {
            const $userName = this.element.querySelector('.__renderbox-user-name');
            if ($userName) {
                $userName.textContent = this.user.name || 'User';
            }
        }
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
        this._stopPolling();
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
            const render = await rendersService.getRender(renderId);

            if (!render) {
                this._showError('Render not found');
                return;
            }

            if (render.status === 'completed') {
                // Load IFC from S3
                const { downloadUrl } = await rendersService.getDownloadUrl(renderId);
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

        const newFiles = Array.from(files);
        const availableSlots = this.MAX_FILES - this.stagedFiles.length;

        if (newFiles.length > availableSlots) {
            if (availableSlots === 0) {
                this._showError(`Maximum ${this.MAX_FILES} files allowed. Remove some files first.`);
                return;
            }
            this._showError(`Only ${availableSlots} file(s) can be added. Maximum is ${this.MAX_FILES} files.`);
            // Add only as many as we can fit
            this.stagedFiles.push(...newFiles.slice(0, availableSlots));
        } else {
            // Add new files to staged files
            this.stagedFiles.push(...newFiles);
        }

        console.log('Files staged:', this.stagedFiles.map(f => f.name));

        // Show file preview
        this._updateFilePreview();
    },

    /**
     * Get file extension from filename
     */
    _getFileExtension(filename) {
        const ext = filename.split('.').pop().toUpperCase();
        return ext.length > 5 ? ext.substring(0, 5) : ext;
    },

    /**
     * Update the file preview display
     */
    _updateFilePreview() {
        const stagingSection = this.element.querySelector('.__renderbox-file-staging');
        const fileGrid = this.element.querySelector('.__renderbox-file-grid');
        const attachBtn = this.element.querySelector('.__renderbox-attach');

        if (this.stagedFiles.length === 0) {
            stagingSection.style.display = 'none';
            if (attachBtn) {
                attachBtn.disabled = false;
                attachBtn.style.opacity = '1';
            }
            return;
        }

        stagingSection.style.display = 'block';

        // Build file grid with box style
        fileGrid.innerHTML = this.stagedFiles.map((file, index) => {
            const fileExt = this._getFileExtension(file.name);
            return `
                <div class="__renderbox-file-item-box" title="${file.name}">
                    <span class="__renderbox-file-item-box-name">${file.name}</span>
                    <span class="__renderbox-file-item-box-badge">${fileExt}</span>
                    <button class="__renderbox-file-item-remove" data-index="${index}" title="Remove file">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width: 14px; height: 14px;">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');

        // Disable attach button if max files reached
        if (attachBtn) {
            if (this.stagedFiles.length >= this.MAX_FILES) {
                attachBtn.disabled = true;
                attachBtn.style.opacity = '0.5';
                attachBtn.title = `Maximum ${this.MAX_FILES} files reached`;
            } else {
                attachBtn.disabled = false;
                attachBtn.style.opacity = '1';
                attachBtn.title = 'Attach files';
            }
        }

        // Bind remove buttons
        fileGrid.querySelectorAll('.__renderbox-file-item-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(e.currentTarget.dataset.index);
                this.stagedFiles.splice(index, 1);
                this._updateFilePreview();
            });
        });
    },

    /**
     * Handle "Start Render" button click - upload files to S3
     */
    async _handleStartRender() {
        if (!this.stagedFiles || this.stagedFiles.length === 0) {
            this._showError('Please attach at least one file');
            return;
        }

        try {
            // Capture description from input
            const descriptionInput = this.element.querySelector('.__renderbox-description');
            const description = descriptionInput?.textContent.trim() || '';

            // Show loading state
            this._showLoadingState('Uploading files...');

            // Get presigned URLs (now includes description parameter)
            const fileNames = this.stagedFiles.map(f => f.name);
            const { uploadUrls, renderId, descriptionUrl } =
                await uploadService.getPresignedUrls(fileNames, description);

            // Upload files
            for (const file of this.stagedFiles) {
                await uploadService.uploadToS3(uploadUrls[file.name], file);
            }

            // Upload description.txt if provided
            if (description && descriptionUrl) {
                await uploadService.uploadDescription(descriptionUrl, description);
            }

            // Clear UI
            this.stagedFiles = [];
            this._updateFilePreview();
            if (descriptionInput) {
                descriptionInput.textContent = '';
            }

            // Start polling for render status
            this._startPolling(renderId);

        } catch (error) {
            console.error('Upload failed:', error);
            this._hideLoadingState();
            this._showError(`Failed to upload: ${error.message}`);
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
            await rendersService.deleteRender(renderId);

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
            const { downloadUrl } = await rendersService.getDownloadUrl(renderId);

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
    },

    /**
     * Show loading state with spinner (for uploads and polling)
     */
    _showLoadingState(message) {
        const uploadLoadingEl = this.element.querySelector('.__renderbox-upload-loading');
        if (uploadLoadingEl) {
            uploadLoadingEl.style.display = 'flex';
            const textEl = uploadLoadingEl.querySelector('.__renderbox-loading-text');
            if (textEl) textEl.textContent = message;
        }
        // Disable buttons during upload
        const startBtn = this.element.querySelector('.__renderbox-start');
        const attachBtn = this.element.querySelector('.__renderbox-attach');
        if (startBtn) startBtn.disabled = true;
        if (attachBtn) attachBtn.disabled = true;
    },

    /**
     * Hide loading state
     */
    _hideLoadingState() {
        const uploadLoadingEl = this.element.querySelector('.__renderbox-upload-loading');
        if (uploadLoadingEl) uploadLoadingEl.style.display = 'none';
        // Re-enable buttons
        const startBtn = this.element.querySelector('.__renderbox-start');
        const attachBtn = this.element.querySelector('.__renderbox-attach');
        if (startBtn) startBtn.disabled = false;
        if (attachBtn) attachBtn.disabled = false;
    },

    /**
     * Update loading message
     */
    _updateLoadingMessage(message) {
        const uploadLoadingEl = this.element.querySelector('.__renderbox-upload-loading');
        if (uploadLoadingEl) {
            const textEl = uploadLoadingEl.querySelector('.__renderbox-loading-text');
            if (textEl) textEl.textContent = message;
        }
    },

    /**
     * Start polling for render status
     */
    _startPolling(renderId) {
        this.currentRenderId = renderId;
        this.pollingStartTime = Date.now();
        this._updateLoadingMessage('Processing your render...');
        this._pollRenderStatus();
    },

    /**
     * Poll render status with exponential backoff
     */
    async _pollRenderStatus() {
        if (!this.currentRenderId) return;

        try {
            const render = await rendersService.getRender(this.currentRenderId);
            const elapsed = Date.now() - this.pollingStartTime;
            const minutes = Math.floor(elapsed / 60000);

            if (render.status === 'completed') {
                this._handleRenderCompleted(render);
                return;
            } else if (render.status === 'failed') {
                this._stopPolling();
                this._hideLoadingState();
                this._showError(`Render failed: ${render.error_message || 'Unknown error'}`);
                return;
            }

            // Update loading message with elapsed time
            this._updateLoadingMessage(`Processing your render... (${minutes}m elapsed)`);

            // Exponential backoff polling: 2s → 5s → 10s
            let delay;
            if (elapsed < 30000) {
                delay = 2000;  // 2s for first 30s
            } else if (elapsed < 120000) {
                delay = 5000;  // 5s for next 2 minutes
            } else if (elapsed < 600000) {
                delay = 10000; // 10s for up to 10 minutes
            } else {
                // Timeout after 10 minutes
                this._stopPolling();
                this._hideLoadingState();
                this._showError('Render is taking longer than expected. Check the sidebar for updates.');
                return;
            }

            this.pollingInterval = setTimeout(() => this._pollRenderStatus(), delay);
        } catch (error) {
            console.error('Polling error:', error);
            this._stopPolling();
            this._hideLoadingState();
            this._showError(`Error checking render status: ${error.message}`);
        }
    },

    /**
     * Stop polling
     */
    _stopPolling() {
        if (this.pollingInterval) {
            clearTimeout(this.pollingInterval);
            this.pollingInterval = null;
        }
        this.currentRenderId = null;
        this.pollingStartTime = null;
    },

    /**
     * Handle render completion
     */
    async _handleRenderCompleted(render) {
        this._stopPolling();
        this._hideLoadingState();

        try {
            // Get download URL for IFC file
            const { downloadUrl } = await rendersService.getDownloadUrl(render.renderId);

            // Load IFC in viewer
            await this.loadIFCFromS3(downloadUrl);

            // Update UI state to viewing-render
            this.element.dataset.state = 'viewing-render';
            this.element.dataset.renderId = render.renderId;
            this._displayMetadata(render);

            // Notify sidebar to refresh renders list
            document.dispatchEvent(new CustomEvent('rendersUpdated'));

            console.log('Render completed:', render.renderId);
        } catch (error) {
            console.error('Error loading completed render:', error);
            this._showError('Failed to load rendered IFC: ' + error.message);
        }
    }
};

export default renderbox;
