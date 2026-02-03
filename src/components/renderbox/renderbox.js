import template from './renderbox.hbs';
import './renderbox.css';
import ifcViewer from './ifc-viewer.js';

const renderbox = {
    element: null,
    viewerCanvas: null,

    init() {
        this.element = document.querySelector('.__renderbox');
        this.element.innerHTML = template();

        this._bindEvents();
        this._initViewer();
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
     * Load the sample IFC file
     */
    async _loadSampleIFC() {
        try {
            const loadingIndicator = this.element.querySelector('.__renderbox-loading');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'flex';
            }

            console.log('Loading sample IFC file...');
            await ifcViewer.loadIFC('/Tunnel_StructureOnly_Example01_Revit.ifc');

            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }

            console.log('Sample IFC file loaded successfully');
        } catch (error) {
            console.error('Failed to load sample IFC file:', error);
            this._showError('Failed to load IFC file: ' + error.message);

            const loadingIndicator = this.element.querySelector('.__renderbox-loading');
            if (loadingIndicator) {
                loadingIndicator.style.display = 'none';
            }
        }
    },

    /**
     * Display error message to user
     */
    _showError(message) {
        console.error('UI Error:', message);
        // Could extend this to show error UI
    },

    _bindEvents() {
        // Listen for new render requests
        document.addEventListener('newRenderRequested', () => {
            this._handleNewRender();
        });

        // Listen for render selection
        document.addEventListener('renderSelected', (e) => {
            this._handleRenderSelected(e.detail.id);
        });

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

    _handleNewRender() {
        console.log('New render requested');
        // Clear chat, reset viewer, etc.
        // For now, just log
    },

    _handleRenderSelected(renderId) {
        console.log('Render selected:', renderId);
        // Load render data, update viewer, etc.
        // For now, just log
    },

    _handleSendMessage() {
        const input = this.element.querySelector('.__renderbox-chat-input input');
        if (input) {
            const message = input.value.trim();
            if (message) {
                console.log('Message sent:', message);
                input.value = '';
            }
        }
    }
};

export default renderbox;
