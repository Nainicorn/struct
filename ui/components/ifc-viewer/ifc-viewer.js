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
                backgroundColor: [0.164, 0.164, 0.164], // Match #2a2a2a dark theme
                preserveDrawingBuffer: true // Required for canvas snapshot capture
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
     * @param {string|ArrayBuffer} srcOrArrayBuffer - URL/path to IFC file OR binary ArrayBuffer data
     * @returns {Promise<void>}
     */
    async loadIFC(srcOrArrayBuffer) {
        try {
            if (!this.viewer) {
                throw new Error('Viewer not initialized. Call init() first.');
            }

            // Clear existing model
            if (this.currentModel) {
                this.currentModel.destroy();
                this.currentModel = null;
            }

            console.log('Loading IFC file:', typeof srcOrArrayBuffer === 'string' ? srcOrArrayBuffer : `ArrayBuffer (${srcOrArrayBuffer.byteLength} bytes)`);

            // Prepare loader config based on input type
            const loaderConfig = { edges: true };
            if (typeof srcOrArrayBuffer === 'string') {
                // URL/path - use src parameter
                loaderConfig.src = srcOrArrayBuffer;
            } else if (srcOrArrayBuffer instanceof ArrayBuffer) {
                // Binary data - use ifc parameter (xeokit expects lowercase ifc for binary data)
                loaderConfig.ifc = srcOrArrayBuffer;
            } else {
                throw new Error('Invalid input: must be URL string or ArrayBuffer');
            }

            // Load new model
            this.currentModel = await this.ifcLoader.load(loaderConfig);

            console.log('IFC file loaded successfully');

            // Fit model to view
            try {
                // Use jumpTo to avoid camera flight animation issues
                this.viewer.cameraFlight.jumpTo(this.currentModel);
                console.log('Camera positioned to fit model');
            } catch (cameraError) {
                console.warn('Camera positioning error (non-fatal):', cameraError);
                // Silently continue - viewer will still work, just needs manual camera adjustment
            }

        } catch (error) {
            console.error('Failed to load IFC file:', error);
            throw error;
        }
    },

    /**
     * Force the viewer canvas to recalculate its size.
     * Must be called after any layout change that affects the canvas container
     * (e.g. loading overlay appearing/disappearing, panel resizes).
     */
    resize() {
        if (this.viewer) {
            try {
                this.viewer.scene.canvas.resizeCanvas();
            } catch (e) {
                // non-fatal — viewer will still work, just might need a scroll/move
            }
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
     * Capture a square thumbnail snapshot of the current viewer canvas.
     * Returns a base64 JPEG data URL or null if capture fails or canvas is blank.
     * @param {number} [size=200] - Target dimension (square)
     * @returns {string|null}
     */
    getSnapshot(size = 200) {
        try {
            // Try xeokit's canvas path first, then fall back to DOM lookup
            let srcCanvas = this.viewer?.scene?.canvas?.canvas;
            if (!srcCanvas) {
                srcCanvas = document.getElementById('ifc-viewer-canvas');
            }
            if (!srcCanvas || srcCanvas.width === 0 || srcCanvas.height === 0) {
                console.warn('[Snapshot] No canvas found or canvas has zero size');
                return null;
            }

            const offscreen = document.createElement('canvas');
            offscreen.width = size;
            offscreen.height = size;
            const ctx = offscreen.getContext('2d');

            // Center-crop the largest square from the source canvas
            const sq = Math.min(srcCanvas.width, srcCanvas.height);
            const sx = (srcCanvas.width - sq) / 2;
            const sy = (srcCanvas.height - sq) / 2;
            ctx.drawImage(srcCanvas, sx, sy, sq, sq, 0, 0, size, size);

            // Blank detection: sample pixels to ensure the model is visible
            const sample = ctx.getImageData(0, 0, size, size).data;
            const bgR = 42, bgG = 42, bgB = 42; // viewer bg ~#2a2a2a
            let nonBgPixels = 0;
            const step = 40; // sample every 40th pixel for speed
            for (let i = 0; i < sample.length; i += step * 4) {
                const r = sample[i], g = sample[i + 1], b = sample[i + 2];
                if (Math.abs(r - bgR) > 12 || Math.abs(g - bgG) > 12 || Math.abs(b - bgB) > 12) {
                    nonBgPixels++;
                }
            }
            const totalSampled = Math.ceil(sample.length / (step * 4));
            if (nonBgPixels / totalSampled < 0.03) {
                // Less than 3% non-background — likely blank canvas
                return null;
            }

            return offscreen.toDataURL('image/jpeg', 0.72);
        } catch (e) {
            console.warn('Snapshot capture failed:', e);
            return null;
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
