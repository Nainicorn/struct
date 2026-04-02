import { Viewer, WebIFCLoaderPlugin } from '@xeokit/xeokit-sdk';
import * as WebIFC from 'web-ifc';

const ifcViewer = {
    viewer: null,
    ifcLoader: null,
    currentModel: null,
    ifcAPI: null,

    // Kept open after load for on-demand property queries (expressID → psets)
    _queryModelId: null,
    _ifcBuffer: null,
    // Reset on each new model load so diagnostics run once per model
    _telemetryDiagLogged: false,

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
                await this._initIfcAPI();
                // Recreate loader with fresh IfcAPI
                this.ifcLoader = new WebIFCLoaderPlugin(this.viewer, {
                    WebIFC: WebIFC,
                    IfcAPI: this.ifcAPI
                });
            }

            // Close previous query model to free WASM memory
            if (this._queryModelId !== null) {
                try { this.ifcAPI.CloseModel(this._queryModelId); } catch (_) {}
                this._queryModelId = null;
                this._ifcBuffer = null;
            }
            this._telemetryDiagLogged = false;

            // Clear existing model
            if (this.currentModel) {
                this.currentModel.destroy();
                this.currentModel = null;
            }

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

            // Store the buffer and reopen it in a dedicated query model so we can
            // call getItemProperties / getPropertySets after the loader has closed its copy.
            if (srcOrArrayBuffer instanceof ArrayBuffer) {
                this._ifcBuffer = srcOrArrayBuffer;
                try {
                    this._queryModelId = this.ifcAPI.OpenModel(new Uint8Array(this._ifcBuffer));
                } catch (e) {
                    console.warn('[IFC] Could not open query model for property lookup:', e);
                }
            }

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
            } catch (cameraError) {
                // Non-fatal — viewer will still work with default camera position
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
        if (this._queryModelId !== null) {
            try { this.ifcAPI?.CloseModel(this._queryModelId); } catch (_) {}
            this._queryModelId = null;
            this._ifcBuffer = null;
        }
        this._telemetryDiagLogged = false;
        if (this.currentModel) {
            this.currentModel.destroy();
            this.currentModel = null;
        }
    },

    /**
     * Fetch and flatten all property sets for a clicked IFC element.
     * Entity ID format from xeokit WebIFCLoaderPlugin: "{modelId}#{expressID}"
     * Returns array of { name, props: [{name, value}] } groups, or null on failure.
     * @param {string} entityId - xeokit entity ID
     * @returns {Promise<Array|null>}
     */
    async getElementProperties(entityId) {
        if (!this.ifcAPI || this._queryModelId === null) return null;

        // Parse expressID — xeokit entity ID format is "modelId#expressID"
        const rawId = entityId.includes('#') ? entityId.split('#').pop() : entityId;
        const expressId = parseInt(rawId, 10);
        if (isNaN(expressId) || expressId <= 0) return null;

        try {
            const [rawProps, psets] = await Promise.all([
                this.ifcAPI.properties.getItemProperties(this._queryModelId, expressId, true),
                this.ifcAPI.properties.getPropertySets(this._queryModelId, expressId, true)
            ]);
            const groups        = this._flattenProperties(rawProps, psets);
            const geometry      = this._extractGeometry(entityId);
            const relationships = this._extractRelationships(rawProps);
            return { groups, geometry, relationships };
        } catch (e) {
            console.warn('[IFC] getElementProperties failed for', entityId, e);
            return null;
        }
    },

    /**
     * Flatten raw web-ifc property data into display groups.
     * Skips null/empty values and geometry/reference fields.
     * @param {Object} rawProps - result of getItemProperties
     * @param {Array}  psets    - result of getPropertySets
     * @returns {Array} [ { name: string, props: [{name, value}] } ]
     */
    _flattenProperties(rawProps, psets) {
        const groups = [];

        // Direct entity attributes (Name, Tag, ObjectType, PredefinedType, etc.)
        if (rawProps) {
            const SKIP = new Set([
                'expressID', 'type', 'GlobalId', 'OwnerHistory',
                'ObjectPlacement', 'Representation', 'ContainedInStructure',
                'HasAssignments', 'IsDefinedBy', 'HasOpenings', 'ConnectedTo',
                'IsDecomposedBy', 'Decomposes', 'HasAssociations'
            ]);
            const attrs = [];
            for (const [key, val] of Object.entries(rawProps)) {
                if (SKIP.has(key)) continue;
                const v = this._extractIfcVal(val);
                if (v === null || v === undefined || v === '' || typeof v === 'object') continue;
                attrs.push({ name: key, value: String(v) });
            }
            if (attrs.length > 0) groups.push({ name: 'Attributes', props: attrs });
        }

        // Property sets (IfcPropertySet, IfcElementQuantity)
        if (Array.isArray(psets)) {
            for (const pset of psets) {
                if (!pset) continue;
                const items = pset.HasProperties || pset.Quantities || [];
                const props = [];
                for (const item of items) {
                    if (!item?.Name) continue;
                    const name = this._extractIfcVal(item.Name);
                    if (!name) continue;
                    // Try all common value fields
                    const rawVal = item.NominalValue ?? item.LengthValue ?? item.AreaValue
                        ?? item.VolumeValue ?? item.CountValue ?? item.WeightValue ?? item.Value;
                    const v = this._extractIfcVal(rawVal);
                    if (v === null || v === undefined || v === '' || typeof v === 'object') continue;
                    props.push({ name: String(name), value: String(v) });
                }
                if (props.length === 0) continue;
                const psetName = this._extractIfcVal(pset.Name) || 'Properties';
                groups.push({ name: String(psetName), props });
            }
        }

        return groups;
    },

    /**
     * Coerce a web-ifc relationship field (single object or array) to an array.
     */
    _toArray(v) {
        return !v ? [] : Array.isArray(v) ? v : [v];
    },

    /**
     * Unwrap a web-ifc value wrapper { type, value } → primitive, or return as-is.
     */
    _extractIfcVal(v) {
        if (v === null || v === undefined) return null;
        if (typeof v !== 'object') return v;
        if ('value' in v) return v.value;
        return null;
    },

    /**
     * Compute bounding-box geometry for a picked element from xeokit's scene.
     * Returns { width, depth, height, center } in model units (metres), or null.
     * @param {string} entityId - full xeokit entity ID (e.g. "model0#12345")
     */
    _extractGeometry(entityId) {
        try {
            const entity = this.viewer?.scene?.objects?.[entityId];
            if (!entity?.aabb) return null;
            const [x0, y0, z0, x1, y1, z1] = entity.aabb;
            const width  = Math.abs(x1 - x0);
            const depth  = Math.abs(y1 - y0);
            const height = Math.abs(z1 - z0);
            if (width + depth + height < 0.001) return null;
            return {
                width:  parseFloat(width.toFixed(3)),
                depth:  parseFloat(depth.toFixed(3)),
                height: parseFloat(height.toFixed(3)),
                center: `(${((x0+x1)/2).toFixed(2)}, ${((y0+y1)/2).toFixed(2)}, ${((z0+z1)/2).toFixed(2)})`
            };
        } catch (_) {
            return null;
        }
    },

    /**
     * Extract IFC relationship data from raw item properties.
     * Reads fields that _flattenProperties intentionally skips.
     * Returns array of { name, value } entries, or null if none found.
     * @param {Object} rawProps - result of getItemProperties
     */
    _extractRelationships(rawProps) {
        if (!rawProps) return null;
        const rels = [];

        // ContainedInStructure → "Contained In" (storey / space name)
        for (const rel of this._toArray(rawProps.ContainedInStructure)) {
            if (!rel || typeof rel !== 'object') continue;
            const struct = rel.RelatingStructure;
            if (struct && typeof struct === 'object') {
                const name = this._extractIfcVal(struct.Name) || this._extractIfcVal(struct.LongName);
                if (name) { rels.push({ name: 'Contained In', value: String(name) }); break; }
            }
        }

        // Decomposes → "Part Of" (parent element name)
        for (const rel of this._toArray(rawProps.Decomposes)) {
            if (!rel || typeof rel !== 'object') continue;
            const parent = rel.RelatingObject;
            if (parent && typeof parent === 'object') {
                const name = this._extractIfcVal(parent.Name);
                if (name) { rels.push({ name: 'Part Of', value: String(name) }); break; }
            }
        }

        // IsDecomposedBy → "Sub-elements" count
        let subCount = 0;
        for (const rel of this._toArray(rawProps.IsDecomposedBy)) {
            if (!rel || typeof rel !== 'object') continue;
            const objs = rel.RelatedObjects;
            subCount += Array.isArray(objs) ? objs.length : 1;
        }
        if (subCount > 0) rels.push({ name: 'Sub-elements', value: String(subCount) });

        // HasOpenings → "Openings" count
        const openings = this._toArray(rawProps.HasOpenings);
        if (openings.length > 0) rels.push({ name: 'Openings', value: String(openings.length) });

        // ConnectedTo → "Connections" count
        const connections = this._toArray(rawProps.ConnectedTo);
        if (connections.length > 0) rels.push({ name: 'Connections', value: String(connections.length) });

        // HasAssignments → "System" (first group name)
        for (const rel of this._toArray(rawProps.HasAssignments)) {
            if (!rel || typeof rel !== 'object') continue;
            const group = rel.RelatingGroup;
            if (group && typeof group === 'object') {
                const name = this._extractIfcVal(group.Name);
                if (name) { rels.push({ name: 'System', value: String(name) }); break; }
            }
        }

        return rels.length > 0 ? rels : null;
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
     * Mapping: sensor.element_type (IFC type string e.g. "IfcSpace") matched against
     * metaScene metaObject.type — NOT by expressID, since the sensors Lambda stores
     * synthetic element_id strings, not integer IFC line numbers.
     * @param {Array} sensors - Sensor objects from sensorService
     * @param {string} filterType - 'all' or specific sensor type to visualize
     */
    applyTelemetryOverlay(sensors, filterType = 'all') {
        if (!this.viewer || !sensors || sensors.length === 0) return;

        // Guard: model must be fully loaded before applying overlay.
        // The polling callback can fire before loadIFC resolves — if currentModel is
        // null or the scene has no objects yet, bail out. renderbox.loadIFCFromUrl
        // will re-apply once the model is ready.
        if (!this.currentModel) {
            console.warn('[Telemetry] applyTelemetryOverlay: model not loaded yet — will retry after load');
            return;
        }
        const sceneObjects = this.viewer.scene.objects;
        if (!sceneObjects || Object.keys(sceneObjects).length === 0) {
            console.warn('[Telemetry] applyTelemetryOverlay: scene has no objects yet — will retry after load');
            return;
        }

        // Clear previous overlay first
        this.clearTelemetryOverlay();
        this._overlayActive = true;

        // Group sensors by element_type after applying filter
        const sensorsByType = {};
        let filteredCount = 0;
        for (const s of sensors) {
            if (filterType !== 'all' && s.sensor_type !== filterType) continue;
            filteredCount++;
            const key = s.element_type;
            if (!sensorsByType[key]) sensorsByType[key] = [];
            sensorsByType[key].push(s);
        }

        const uniqueTypes = Object.keys(sensorsByType);
        console.log(`[Telemetry] ${sensors.length} sensors fetched, ${filteredCount} after filter "${filterType}", covering ${uniqueTypes.length} type(s): [${uniqueTypes.join(', ')}]`);

        if (uniqueTypes.length === 0) {
            console.warn('[Telemetry] No sensors matched the current filter — overlay not applied');
            return;
        }

        const metaObjects = this.viewer.metaScene?.metaObjects || {};

        // Diagnostic summary runs once per model load (not on every 30s sensor poll)
        if (!this._telemetryDiagLogged) {
            this._telemetryDiagLogged = true;
            const metaTypeCount = {};
            for (const metaObj of Object.values(metaObjects)) {
                metaTypeCount[metaObj.type] = (metaTypeCount[metaObj.type] || 0) + 1;
            }
            console.log(`[Telemetry] Scene: ${Object.keys(metaObjects).length} metaObjects across ${Object.keys(metaTypeCount).length} IFC type(s)`);
            for (const t of uniqueTypes) {
                const count = metaTypeCount[t] || 0;
                if (count === 0) {
                    console.warn(`[Telemetry] No scene objects for type "${t}" — ${sensorsByType[t].length} sensor(s) will not map`);
                } else {
                    console.log(`[Telemetry] Type "${t}": ${count} scene object(s) available for ${sensorsByType[t].length} sensor(s)`);
                }
            }
        }

        // Colorize matching entities
        let mapped = 0;
        let failed = 0;

        for (const [entityId, metaObj] of Object.entries(metaObjects)) {
            const typeSensors = sensorsByType[metaObj.type];
            if (!typeSensors || typeSensors.length === 0) continue;

            const entity = this.viewer.scene.objects[entityId];
            if (!entity) { failed++; continue; }

            // Use the first sensor for this type
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
                mapped++;
            } else {
                failed++;
            }
        }

        console.log(`[Telemetry] Overlay result: ${mapped} entities colorized, ${failed} failed to map`);
    },

    /**
     * Remove all telemetry overlays, restoring default element colors.
     */
    clearTelemetryOverlay() {
        if (!this.viewer) return;

        for (const entityId of this._colorizedEntityIds) {
            const entity = this.viewer.scene.objects[entityId];
            if (entity) entity.colorize = [1, 1, 1];
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
            if (this._queryModelId !== null) {
                try { this.ifcAPI?.CloseModel(this._queryModelId); } catch (_) {}
                this._queryModelId = null;
                this._ifcBuffer = null;
            }
            if (this.currentModel) {
                this.currentModel.destroy();
                this.currentModel = null;
            }
            if (this.viewer) {
                this.viewer.destroy();
                this.viewer = null;
            }
            this.ifcLoader = null;
        } catch (error) {
            console.error('Error destroying viewer:', error);
        }
    }
};

export default ifcViewer;
