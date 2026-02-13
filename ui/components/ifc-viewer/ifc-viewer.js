import { Viewer, WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk';
import * as WebIFC from 'web-ifc';

const ifcViewer = {
    viewer: null,
    ifcLoader: null,
    currentModel: null,
    ifcAPI: null,

    /**
     * Initialize the xeokit viewer
     * @param {HTMLCanvasElement} canvas - Canvas element to render into
     * @returns {Promise<void>}
     */
    async init(canvas) {
        try {
            // Create xeokit viewer
            this.viewer = new Viewer({
                canvasId: canvas.id,
                transparent: false,
                backgroundColor: [0.164, 0.164, 0.164] // Match #2a2a2a dark theme
            });

            // Initialize web-ifc API instance
            this.ifcAPI = new WebIFC.IfcAPI();
            this.ifcAPI.SetWasmPath('/');

            // Initialize WASM module (async)
            await this.ifcAPI.Init();

            // Initialize WebIFC loader plugin with both WebIFC module and IfcAPI instance
            this.ifcLoader = new WebIFCLoaderPlugin(this.viewer, {
                WebIFC: WebIFC,
                IfcAPI: this.ifcAPI
            });

            // Set up camera - will be overridden by flyTo when model loads
            this.viewer.camera.eye = [0, 0, 0];
            this.viewer.camera.look = [0, 0, -1];
            this.viewer.camera.up = [0, 1, 0];

            console.log('xeokit Viewer initialized successfully');
        } catch (error) {
            console.error('Failed to initialize xeokit Viewer:', error);
            throw error;
        }
    },

    /**
     * Load an IFC file into the viewer
     * @param {string} src - URL or path to IFC file
     * @returns {Promise<void>}
     */
    async loadIFC(src) {
        try {
            if (!this.viewer) {
                throw new Error('Viewer not initialized. Call init() first.');
            }

            // Clear existing model
            if (this.currentModel) {
                this.currentModel.destroy();
                this.currentModel = null;
            }

            console.log('Loading IFC file:', src);

            // Load new model
            this.currentModel = await this.ifcLoader.load({
                src: src,
                edges: true
            });

            console.log('IFC file loaded successfully');

            // Fit model to view with camera animation
            // Use a longer duration and add padding so model is well-framed
            this.viewer.cameraFlight.flyTo(this.currentModel, {
                duration: 1.0,
                fitFOV: 45,
                padding: 0.5
            });

        } catch (error) {
            console.error('Failed to load IFC file:', error);
            throw error;
        }
    },

    /**
     * Clear the current model from the viewer
     */
    clear() {
        if (this.currentModel) {
            this.currentModel.destroy();
            this.currentModel = null;
            console.log('Model cleared');
        }
    },

    /**
     * Destroy the viewer and clean up WebGL resources
     */
    destroy() {
        try {
            if (this.currentModel) {
                this.currentModel.destroy();
                this.currentModel = null;
            }
            if (this.viewer) {
                this.viewer.destroy();
                this.viewer = null;
            }
            this.ifcLoader = null;
            console.log('xeokit Viewer destroyed');
        } catch (error) {
            console.error('Error destroying viewer:', error);
        }
    }
};

export default ifcViewer;
