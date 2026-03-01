import template from './renderbox.hbs';
import './renderbox.css';
import ifcViewer from '../ifc-viewer/ifc-viewer.js';
import uploadService from '../../services/uploadService.js';
import usersService from '../../services/usersService.js';
import rendersService from '../../services/rendersService.js';
import modalService from '../../services/modalService.js';

const renderbox = {
    element: null,
    viewerCanvas: null,
    stagedFiles: [], // Files waiting to be uploaded
    MAX_FILES: 15, // Maximum number of files allowed
    pollingInterval: null,
    currentRenderId: null,
    pollingStartTime: null,
    currentBlobUrl: null, // Track blob URL to prevent premature garbage collection
    isRendering: false, // Flag to track if render is currently in progress

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
        this._preventPageZoom();
    },

    /**
     * Prevent page zoom when scrolling over the IFC viewer
     */
    _preventPageZoom() {
        const viewer = this.element.querySelector('.__renderbox-viewer');
        if (viewer) {
            viewer.addEventListener('wheel', (e) => {
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                }
            }, { passive: false });
        }
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
     * Update the input placeholder text
     */
    _updateInputPlaceholder(text) {
        const inputEl = this.element.querySelector('.__renderbox-description');
        if (inputEl) {
            inputEl.setAttribute('placeholder', text);
        }
    },

    /**
     * Display render metadata (title, description, source files)
     */
    _displayMetadata() {
        // Title and description are now displayed in the details card
        // No longer needed in renderbox
    },

    /**
     * Show error message to user
     */
    _showError(message) {
        console.error('UI Error:', message);
        modalService.alert('Error', message);
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
     * Load IFC file from base64 data (called when user selects a completed render)
     * @param {string} base64Data - Base64 encoded IFC file data
     */
    async loadIFCFromBase64(base64Data) {
        try {
            const loadingIndicator = this.element.querySelector('.__renderbox-loading');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'flex';
            }

            console.log('Loading IFC from base64 data...');

            // Convert base64 to ArrayBuffer (binary data)
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const arrayBuffer = bytes.buffer;

            console.log('Converted base64 to ArrayBuffer:', arrayBuffer.byteLength, 'bytes');

            // Load via ArrayBuffer (xeokit will handle it directly without HTTP fetch)
            await ifcViewer.loadIFC(arrayBuffer);

            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }

            console.log('IFC file loaded successfully');
        } catch (error) {
            console.error('Failed to load IFC file:', error);

            const loadingIndicator = this.element.querySelector('.__renderbox-loading');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }

            // Re-throw error to let caller handle it
            throw error;
        }
    },

    /**
     * Load sample IFC file for testing
     */
    async _loadSampleIFC() {
        try {
            console.log('Loading tunnel IFC for testing...');
            await ifcViewer.loadIFC('/tunnel.ifc');
            console.log('Tunnel IFC loaded successfully');
        } catch (error) {
            console.warn('Failed to load sample IFC:', error);
            console.log('Initial state: waiting for render selection');
        }
    },

    /**
     * Handle "New Render" button click
     */
    _handleNewRender() {
        console.log('New render requested');
        this._stopPolling();
        this._hideLoadingState();
        this.element.dataset.state = 'new-render';
        delete this.element.dataset.renderId;
        this._updateMessage('What do you want to render today?');
        this._updateInputPlaceholder('What do you want to render today?');
        // Clear input content so placeholder reappears
        const descriptionInput = this.element.querySelector('.__renderbox-description');
        if (descriptionInput) {
            descriptionInput.textContent = '';
            descriptionInput.classList.add('is-empty');
        }
        // Show welcome message again
        const messageEl = this.element.querySelector('.__renderbox-message');
        if (messageEl) {
            messageEl.style.display = 'block';
        }
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
                // Refresh sidebar to remove stale entry
                document.dispatchEvent(new CustomEvent('rendersUpdated'));
                return;
            }

            if (render.status === 'completed') {
                // Load IFC from backend
                const { fileData } = await rendersService.getDownloadUrl(renderId);
                await this.loadIFCFromBase64(fileData);

                this.element.dataset.state = 'viewing-render';
                this.element.dataset.renderId = renderId;
                this._updateMessage('Edit render?');
                this._updateInputPlaceholder('What edits would you like to make?');
                // Clear input content so placeholder reappears
                const descriptionInput = this.element.querySelector('.__renderbox-description');
                if (descriptionInput) {
                    descriptionInput.textContent = '';
                    descriptionInput.classList.add('is-empty');
                }
                this._displayMetadata(render);

                // Notify details sidebar with full render object
                document.dispatchEvent(new CustomEvent('renderSelected', {
                    detail: { render }
                }));
            } else if (render.status === 'processing' || render.status === 'pending') {
                this._showError(`Render is still ${render.status}. Please try again later.`);
            } else if (render.status === 'failed') {
                this._showError(`Render failed: ${render.error_message || 'Unknown error'}`);
            }
        } catch (error) {
            console.error('Error loading render:', error);
            const errorMsg = error.message || 'Unknown error';

            // Check if this is a parsing/corruption error from web-ifc
            if (errorMsg.includes('unexpected token') || errorMsg.includes('GetSetArgument') || errorMsg.includes('Invalid IFC')) {
                console.warn('Corrupted IFC detected. Attempting to delete...');
                const shouldDelete = await modalService.confirm(
                    'Corrupted Render',
                    'This render file is corrupted and cannot be loaded.\n\nWould you like to delete it?',
                    'Delete',
                    'Cancel'
                );

                if (shouldDelete) {
                    try {
                        await rendersService.deleteRender(renderId);
                        console.log('Corrupted render deleted');
                        // Refresh sidebar to remove deleted entry
                        document.dispatchEvent(new CustomEvent('rendersUpdated'));
                        // Reset to welcome screen
                        document.dispatchEvent(new CustomEvent('newRenderRequested'));
                        await modalService.alert('Success', 'Corrupted render has been deleted.');
                    } catch (deleteError) {
                        console.error('Failed to delete corrupted render:', deleteError);
                        this._showError('Failed to delete render: ' + deleteError.message);
                    }
                }
            } else {
                this._showError('Failed to load render: ' + errorMsg);
            }
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

            // Hide welcome message and file staging before showing loading
            const messageEl = this.element.querySelector('.__renderbox-message');
            if (messageEl) {
                messageEl.style.display = 'none';
            }
            const stagingSection = this.element.querySelector('.__renderbox-file-staging');
            if (stagingSection) {
                stagingSection.style.display = 'none';
            }

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
            if (descriptionInput) {
                descriptionInput.textContent = '';
                descriptionInput.classList.add('is-empty');
            }

            // Start polling for render status
            this._startPolling(renderId);

        } catch (error) {
            console.error('Upload failed:', error);
            this._hideLoadingState();
            // Show message again on error
            const messageEl = this.element.querySelector('.__renderbox-message');
            if (messageEl) {
                messageEl.style.display = 'block';
            }
            // Show file staging again on error
            const stagingSection = this.element.querySelector('.__renderbox-file-staging');
            if (stagingSection && this.stagedFiles.length > 0) {
                stagingSection.style.display = 'block';
            }
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

        // Listen for render selection from sidebar (only process if id is provided)
        document.addEventListener('renderSelected', async (e) => {
            // Guard against renderbox's own renderSelected dispatch
            if (e.detail.id) {
                await this._handleRenderSelected(e.detail.id);
            }
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

            // Monitor input content to show/hide placeholder
            const updateEmptyState = () => {
                const isEmpty = descriptionInput.textContent.trim() === '';
                if (isEmpty) {
                    descriptionInput.classList.add('is-empty');
                } else {
                    descriptionInput.classList.remove('is-empty');
                }
            };

            descriptionInput.addEventListener('input', updateEmptyState);
            descriptionInput.addEventListener('blur', updateEmptyState);
            descriptionInput.addEventListener('focus', updateEmptyState);

            // Set initial state
            updateEmptyState();
        }

        // Download button inside viewer
        const downloadBtn = this.element.querySelector('.__renderbox-viewer-download');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', async () => {
                await this._handleDownload();
            });
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
            if (textEl) {
                // Show elapsed time if available
                if (message.includes('(')) {
                    const timeMatch = message.match(/\(([^)]+)\)/);
                    if (timeMatch) {
                        textEl.textContent = `Processing • ${timeMatch[1]}`;
                    }
                } else {
                    textEl.textContent = 'Processing';
                }
            }
        }
    },

    /**
     * Start polling for render status
     */
    _startPolling(renderId) {
        this.currentRenderId = renderId;
        this.pollingStartTime = Date.now();
        this.isRendering = true; // Set flag to indicate rendering in progress
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

                // Show error immediately and prominently
                const errorMsg = render.error_message || 'Unknown error occurred during rendering';
                console.error('Render failed with status:', errorMsg);

                // Use alert for immediate visibility, then show in modal
                await modalService.alert(
                    'Render Failed',
                    `Your render failed to process.\n\nError: ${errorMsg}\n\nYou can try again with different files or settings.`
                );

                // Also refresh sidebar to show the failed status
                document.dispatchEvent(new CustomEvent('rendersUpdated'));
                return;
            }

            // Update loading message with elapsed time
            this._updateLoadingMessage(`Processing your render... (${minutes}m elapsed)`);

            // Exponential backoff polling: 2s → 5s → 10s → 15s
            let delay;
            if (elapsed < 30000) {
                delay = 2000;  // 2s for first 30s
            } else if (elapsed < 120000) {
                delay = 5000;  // 5s for next 2 minutes
            } else if (elapsed < 600000) {
                delay = 10000; // 10s for up to 10 minutes
            } else if (elapsed < 1800000) {
                delay = 15000; // 15s for up to 30 minutes
            } else {
                // Timeout after 30 minutes
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
        this.isRendering = false; // Clear rendering flag
    },

    /**
     * Handle download IFC file
     */
    async _handleDownload() {
        if (!this.element.dataset.renderId) return;

        try {
            const renderId = this.element.dataset.renderId;
            const { fileData } = await rendersService.getDownloadUrl(renderId);

            // Convert base64 to blob
            const binaryString = atob(fileData);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'application/octet-stream' });

            // Create blob URL and trigger download
            const blobUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = `render-${renderId}.ifc`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // Clean up blob URL
            URL.revokeObjectURL(blobUrl);

            console.log('Download started');
        } catch (error) {
            console.error('Error downloading render:', error);
            this._showError('Failed to download render: ' + error.message);
        }
    },

    /**
     * Handle render completion
     */
    async _handleRenderCompleted(render) {
        this._stopPolling();
        this._hideLoadingState();

        try {
            // Update UI state FIRST so viewer is visible
            this.element.dataset.state = 'viewing-render';
            this.element.dataset.renderId = render.render_id;
            this._updateInputPlaceholder('What edits would you like to make?');
            this._displayMetadata(render);

            // Notify details sidebar with full render object
            document.dispatchEvent(new CustomEvent('renderSelected', {
                detail: { render }
            }));

            // Notify sidebar to refresh renders list
            document.dispatchEvent(new CustomEvent('rendersUpdated'));

            // Get IFC file data from backend
            const { fileData } = await rendersService.getDownloadUrl(render.render_id);

            // Load IFC in viewer (async, but UI is already showing)
            try {
                await this.loadIFCFromBase64(fileData);
                console.log('Render completed and IFC loaded:', render.render_id);
            } catch (ifcError) {
                console.error('IFC loading error:', ifcError);
                this._showError('Failed to load 3D model: ' + ifcError.message);
            }
        } catch (error) {
            console.error('Error completing render:', error);
            this._showError('Failed to complete render: ' + error.message);
        }
    }
};

export default renderbox;
