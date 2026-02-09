import template from './renderbox.hbs';
import './renderbox.css';
import ifcViewer from '../ifc-viewer/ifc-viewer.js';
import rendersapi from '../../services/rendersapi.js';

const renderbox = {
    element: null,
    viewerCanvas: null,

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
     * Display render metadata (title, description)
     */
    _displayMetadata(render) {
        const titleEl = this.element.querySelector('.__renderbox-metadata-title');
        const descEl = this.element.querySelector('.__renderbox-metadata-description');

        if (titleEl) {
            titleEl.textContent = render.title || 'Untitled Render';
        }
        if (descEl) {
            descEl.textContent = render.description || 'No description provided';
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
     * Handle file upload
     */
    async _handleFileUpload(files) {
        if (files.length === 0) {
            return;
        }

        try {
            // Create render + get presigned URLs
            const fileNames = Array.from(files).map(f => f.name);
            console.log('Creating render with files:', fileNames);
            const { id: renderId, uploadUrls } = await rendersapi.createRender(fileNames);

            console.log('Render created:', renderId);

            // Upload files to S3
            for (const file of files) {
                console.log('Uploading file:', file.name);
                await rendersapi.uploadToS3(uploadUrls[file.name], file);
            }

            console.log('Files uploaded successfully');

            // Trigger pipeline
            await rendersapi.triggerProcessing(renderId);

            console.log('Pipeline triggered, starting to poll...');

            // Poll for completion
            rendersapi.poll((renders) => {
                const render = renders.find(r => r.id === renderId);
                if (render.status === 'completed') {
                    console.log('Render completed!');
                    this._handleRenderSelected(renderId);
                } else if (render.status === 'failed') {
                    console.error('Render failed:', render.error_message);
                    this._showError('Render failed: ' + render.error_message);
                } else {
                    console.log('Render status:', render.status);
                }
            });
        } catch (error) {
            console.error('Error handling file upload:', error);
            this._showError('Upload failed: ' + error.message);
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
        document.addEventListener('renderSelected', (e) => {
            this._handleRenderSelected(e.detail.id);
        });

        // File upload button (attach icon) click
        const attachBtn = this.element.querySelector('.__renderbox-attach');
        const fileInput = this.element.querySelector('#__renderbox-file-input');

        if (attachBtn && fileInput) {
            attachBtn.addEventListener('click', () => {
                fileInput.click();
            });

            fileInput.addEventListener('change', (e) => {
                this._handleFileUpload(e.target.files);
                // Reset input so same file can be uploaded again
                e.target.value = '';
            });
        }

        // Handle chat input
        const chatInput = this.element.querySelector('.__renderbox-chat-input');
        if (chatInput) {
            chatInput.addEventListener('click', (e) => {
                const sendBtn = e.target.closest('.__renderbox-send');
                if (sendBtn) {
                    this._handleSendMessage();
                }
            });

            chatInput.addEventListener('keydown', (e) => {
                const input = e.target.closest('input');
                if (input && e.key === 'Enter') {
                    this._handleSendMessage();
                }
            });
        }
    },

    /**
     * Handle chat message send
     */
    _handleSendMessage() {
        const input = this.element.querySelector('.__renderbox-chat-input input');
        if (input) {
            const message = input.value.trim();
            if (message) {
                console.log('Message sent:', message);
                input.value = '';
                // TODO: Implement chat functionality
            }
        }
    }
};

export default renderbox;
