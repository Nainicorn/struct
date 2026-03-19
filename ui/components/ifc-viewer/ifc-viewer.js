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
                transparent: true,
                saoEnabled: true,
                backgroundColor: [0.164, 0.164, 0.164], // Match #2a2a2a dark theme
                preserveDrawingBuffer: true // Required for canvas snapshot capture
            });

            // Initialize web-ifc API instance
            await this._initIfcAPI();

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
     * Initialize or re-initialize the web-ifc API with WASM
     */
    async _initIfcAPI() {
        this.ifcAPI = new WebIFC.IfcAPI();
        this.ifcAPI.SetWasmPath('/');
        await this.ifcAPI.Init();
        // Verify WASM module loaded
        if (!this.ifcAPI.wasmModule) {
            throw new Error('web-ifc WASM module failed to initialize');
        }
        console.log('web-ifc WASM initialized successfully');
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

            // Re-init IfcAPI if WASM module is missing (can happen after errors)
            if (!this.ifcAPI?.wasmModule) {
                console.warn('web-ifc WASM not ready, re-initializing...');
                await this._initIfcAPI();
                // Recreate loader with fresh IfcAPI
                this.ifcLoader = new WebIFCLoaderPlugin(this.viewer, {
                    WebIFC: WebIFC,
                    IfcAPI: this.ifcAPI
                });
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
                loaderConfig.src = srcOrArrayBuffer;
            } else if (srcOrArrayBuffer instanceof ArrayBuffer) {
                loaderConfig.ifc = srcOrArrayBuffer;
            } else {
                throw new Error('Invalid input: must be URL string or ArrayBuffer');
            }

            // Load new model — xeokit's load() returns the model synchronously
            // but parsing happens async. Wrap in a Promise that resolves on 'loaded'.
            this.currentModel = await new Promise((resolve, reject) => {
                const model = this.ifcLoader.load(loaderConfig);
                model.on('loaded', () => resolve(model));
                model.on('error', (err) => reject(new Error(err || 'IFC load failed')));
                // Safety timeout — if neither event fires in 30s, resolve anyway
                setTimeout(() => resolve(model), 30000);
            });

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

            // Fill with dark background first (canvas may be transparent)
            ctx.fillStyle = '#2a2a2a';
            ctx.fillRect(0, 0, size, size);

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
                // Less than 0.5% non-background — likely blank canvas
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
        // Remove previous listener to prevent duplicates (stacked listeners cause chip to flash)
        if (this._pickSubId !== undefined) {
            this.viewer.scene.input.off(this._pickSubId);
        }
        this._pickSubId = this.viewer.scene.input.on('mouseclicked', (coords) => {
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

    // ==================== Telemetry Overlay ====================

    _overlayActive: false,
    _colorizedEntityIds: [], // Track which entities we've colorized

    // Status sensor color mapping
    _statusColors: {
        running: [0.13, 0.77, 0.37],  // green
        idle:    [0.98, 0.80, 0.08],   // yellow
        fault:   [0.94, 0.26, 0.26],   // red
    },

    /**
     * Apply telemetry color overlay to model elements based on sensor data.
     * Colors elements by matching sensor element_type to IFC metaObject types.
     * @param {Array} sensors - Sensor objects from sensorService
     * @param {string} filterType - 'all' or specific sensor type to visualize
     */
    applyTelemetryOverlay(sensors, filterType = 'all') {
        if (!this.viewer || !sensors || sensors.length === 0) return;

        // Clear previous overlay first
        this.clearTelemetryOverlay();
        this._overlayActive = true;

        // Group sensors by element_type, taking the worst/highest value per type
        const sensorsByType = {};
        for (const s of sensors) {
            if (filterType !== 'all' && s.sensor_type !== filterType) continue;
            const key = s.element_type;
            if (!sensorsByType[key]) sensorsByType[key] = [];
            sensorsByType[key].push(s);
        }

        if (Object.keys(sensorsByType).length === 0) return;

        // Iterate all meta objects and colorize matching entities
        const metaObjects = this.viewer.metaScene?.metaObjects || {};
        for (const [entityId, metaObj] of Object.entries(metaObjects)) {
            const typeSensors = sensorsByType[metaObj.type];
            if (!typeSensors || typeSensors.length === 0) continue;

            const entity = this.viewer.scene.objects[entityId];
            if (!entity) continue;

            // Use the first sensor for this type (round-robin could be added later)
            const sensor = typeSensors[0];
            let color;

            if (sensor.unit === null && this._statusColors[sensor.current_value]) {
                // Categorical (equipment status)
                color = this._statusColors[sensor.current_value];
            } else if (sensor.min_range !== null && sensor.max_range !== null) {
                // Numeric — normalize and map to heatmap
                const normalized = Math.max(0, Math.min(1,
                    (sensor.current_value - sensor.min_range) / (sensor.max_range - sensor.min_range)
                ));
                color = this._valueToHeatColor(normalized);
            }

            if (color) {
                entity.colorize = color;
                this._colorizedEntityIds.push(entityId);
            }
        }
    },

    /**
     * Remove all telemetry overlays, restoring default element colors.
     */
    clearTelemetryOverlay() {
        if (!this.viewer) return;

        for (const entityId of this._colorizedEntityIds) {
            const entity = this.viewer.scene.objects[entityId];
            if (entity) entity.colorize = null;
        }
        this._colorizedEntityIds = [];
        this._overlayActive = false;
    },

    /**
     * Map a normalized value (0–1) to an RGB color on a blue→green→yellow→red gradient.
     * @param {number} t - Value between 0 and 1
     * @returns {number[]} [r, g, b] each 0–1
     */
    _valueToHeatColor(t) {
        // 4-stop gradient: blue(0) → green(0.33) → yellow(0.66) → red(1)
        const stops = [
            [0.00, 0.23, 0.51, 0.96], // blue
            [0.33, 0.13, 0.77, 0.37], // green
            [0.66, 0.98, 0.80, 0.08], // yellow
            [1.00, 0.94, 0.26, 0.26], // red
        ];

        // Find the two stops to interpolate between
        let lower = stops[0], upper = stops[stops.length - 1];
        for (let i = 0; i < stops.length - 1; i++) {
            if (t >= stops[i][0] && t <= stops[i + 1][0]) {
                lower = stops[i];
                upper = stops[i + 1];
                break;
            }
        }

        const range = upper[0] - lower[0];
        const f = range > 0 ? (t - lower[0]) / range : 0;

        return [
            lower[1] + f * (upper[1] - lower[1]),
            lower[2] + f * (upper[2] - lower[2]),
            lower[3] + f * (upper[3] - lower[3]),
        ];
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
