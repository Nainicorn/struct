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

            // True isometric diagonal initial camera — jumpTo maintains this look
            // direction, so all model types (buildings, flat networks, long tunnels)
            // get a useful corner-above view rather than a front-elevation view.
            this.viewer.camera.eye = [-80, -80, 80];
            this.viewer.camera.look = [0, 0, 0];
            this.viewer.camera.up = [0, 0, 1];

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

            // Fit model to view with orientation-aware camera placement
            try {
                this.viewer.cameraFlight.jumpTo(this.currentModel);

                // After initial fit, check if model is very elongated (long single tunnel)
                // and reposition camera to a proper side-oblique view (not top-down).
                // Threshold >15 avoids firing on flat planar networks (ratio ~3-4).
                const aabb = this.currentModel.aabb;
                if (aabb) {
                    const dx = aabb[3] - aabb[0];
                    const dy = aabb[4] - aabb[1];
                    const dz = aabb[5] - aabb[2];
                    const longest = Math.max(dx, dy, dz);
                    const shortest = Math.min(dx > 0.1 ? dx : Infinity, dy > 0.1 ? dy : Infinity, dz > 0.1 ? dz : Infinity);
                    if (longest > 20 && longest / shortest > 15) {
                        const cx = (aabb[0] + aabb[3]) / 2;
                        const cy = (aabb[1] + aabb[4]) / 2;
                        const cz = (aabb[2] + aabb[5]) / 2;
                        // Side distance: 65% of tunnel length (sees full length from side)
                        // Height: 20% of tunnel length (~17° elevation — proper side view)
                        const sideDist = longest * 0.65;
                        const height = longest * 0.2;
                        if (dx >= dy) {
                            // Tunnel along X — view from Y-side
                            this.viewer.camera.eye = [cx, cy - sideDist, cz + height];
                        } else {
                            // Tunnel along Y — view from X-side
                            this.viewer.camera.eye = [cx - sideDist, cy, cz + height];
                        }
                        this.viewer.camera.look = [cx, cy, cz];
                        this.viewer.camera.up = [0, 0, 1];
                    }
                }
                console.log('Camera positioned to fit model');
            } catch (cameraError) {
                console.warn('Camera positioning error (non-fatal):', cameraError);
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
            if (nonBgPixels / totalSampled < 0.005) {
                // Less than 0.5% non-background — likely blank canvas (lowered for thin elongated models)
                return null;
            }

            return offscreen.toDataURL('image/jpeg', 0.72);
        } catch (e) {
            console.warn('Snapshot capture failed:', e);
            return null;
        }
    },

    /**
     * Set up pick (click-to-select) events on the viewer canvas.
     * Fires a custom 'elementPicked' DOM event with { id, type, name } when an element is clicked.
     * Fires 'elementPickCleared' when background is clicked.
     */
    setupPickEvents() {
        if (!this.viewer) return;
        this.viewer.scene.input.on('mouseclicked', (coords) => {
            const pickResult = this.viewer.scene.pick({ canvasPos: coords });
            if (pickResult && pickResult.entity) {
                const entity = pickResult.entity;
                const metaObject = this.viewer.metaScene.metaObjects[entity.id];
                document.dispatchEvent(new CustomEvent('elementPicked', {
                    detail: {
                        id: entity.id,
                        type: metaObject?.type || 'Unknown',
                        name: metaObject?.name || entity.id
                    }
                }));
            } else {
                document.dispatchEvent(new CustomEvent('elementPickCleared'));
            }
        });
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
