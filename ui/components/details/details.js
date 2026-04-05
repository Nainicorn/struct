import template from './details.hbs';
import './details.css';
import rendersService from '../../services/rendersService.js';
import modalService from '../../services/modalService.js';
import sensorService from '../../services/sensorService.js';

const details = {
    element: null,
    currentRender: null,

    // Initialize the details component
    async init() {
        this._render();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__details');
        let html = template({ main: true });
        this.element.innerHTML = html;
    },

    // Bind event listeners
    _bindListeners() {
        // Listen for render selection from sidebar
        document.addEventListener('renderSelected', async (e) => {
            await this.show(e.detail.render);
        });

        // Listen for new render request
        document.addEventListener('newRenderRequested', () => {
            this.hide();
        });

        // Close button (overlay mode)
        const closeBtn = this.element.querySelector('.__details-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hide());
        }

        // Backdrop click closes details
        const backdrop = document.querySelector('.__details-backdrop');
        if (backdrop) {
            backdrop.addEventListener('click', () => this.hide());
        }

        // ESC key closes details panel
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.element.classList.contains('__details-visible')) {
                this.hide();
            }
        });

        // Download report button
        const reportBtn = this.element.querySelector('.__details-download-report');
        if (reportBtn) {
            reportBtn.addEventListener('click', async () => {
                await this._downloadReport();
            });
        }

        // Listen for telemetry toggle from renderbox
        document.addEventListener('telemetryToggled', (e) => {
            if (e.detail.active && e.detail.sensors) {
                this._updateSensorReadings(e.detail.sensors);
            }
        });

        // Delete button
        const deleteBtn = this.element.querySelector('.__details-delete');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async () => {
                await this._handleDelete();
            });
        }
    },

    /**
     * Show render details
     */
    async show(render) {
        if (!render) return;

        this.currentRender = render;

        // Display title
        this._displayTitle(render);

        // Display description
        this._displayDescription(render);

        // Display files
        if (render.source_files && Array.isArray(render.source_files)) {
            this._displayFiles(render.source_files);
        }

        // Display refinement report (if this render was refined)
        this._displayRefinement(render);

        // Display traceability report
        this._displayTracingReport(render);

        // Display quality score
        this._displayQualityScore(render);

        // Display model statistics
        this._displayStats(render);

        // Display structural notes
        this._displayStructuralWarnings(render);

        // Display generation warnings
        this._displayWarnings(render);

        // Display unmodeled findings
        this._displayOmitted(render);

        // Display live sensor telemetry (only for completed renders)
        if (render.status === 'completed') {
            this._displaySensors(render);
        }

        // Show download report button if render is complete
        const reportBtn = this.element.querySelector('.__details-download-report');
        if (reportBtn) {
            reportBtn.classList.toggle('hidden', render.status !== 'completed');
        }

        // Show the details panel
        this.element.classList.add('__details-visible');

        // Show backdrop on smaller screens
        const backdrop = document.querySelector('.__details-backdrop');
        if (backdrop && window.innerWidth <= 1100) {
            backdrop.style.display = 'block';
        }
    },

    /**
     * Hide render details
     */
    hide() {
        this.element.classList.remove('__details-visible');
        this.currentRender = null;

        // Hide backdrop
        const backdrop = document.querySelector('.__details-backdrop');
        if (backdrop) {
            backdrop.style.display = 'none';
        }
        // Clear text fields
        const titleEl = this.element.querySelector('.__details-title');
        const descEl = this.element.querySelector('.__details-description');
        const filesContainer = this.element.querySelector('.__details-files');
        if (titleEl) titleEl.textContent = '';
        if (descEl) descEl.textContent = '';
        if (filesContainer) filesContainer.innerHTML = '';

        // Clear and hide all collapsible sections
        const sections = ['traceability', 'quality', 'stats', 'refinement', 'structural', 'warnings', 'omitted', 'sensors'];
        for (const name of sections) {
            const section = this.element.querySelector(`.__details-${name}`);
            const content = this.element.querySelector(`.__details-${name}-content`);
            if (content) content.innerHTML = '';
            if (section) section.classList.add('hidden');
        }
    },

    /**
     * Display render title
     */
    _displayTitle(render) {
        const titleEl = this.element.querySelector('.__details-title');
        if (titleEl) {
            const title = render.ai_generated_title || render.title || 'Untitled Render';
            titleEl.textContent = title;
            titleEl.title = title;
        }
    },

    /**
     * Display render description
     */
    _displayDescription(render) {
        const descEl = this.element.querySelector('.__details-description');
        if (descEl) {
            descEl.textContent = render.ai_generated_description || render.description || 'No description available';
        }
    },

    /**
     * Display refinement info (revision, change summary, warnings)
     */
    _displayRefinement(render) {
        const section = this.element.querySelector('.__details-refinement');
        const content = this.element.querySelector('.__details-refinement-content');
        if (!section || !content) return;

        const rr = render.refinementReport;
        const refCount = render.refine_count;
        if (!rr && !refCount) { section.classList.add('hidden'); return; }

        section.classList.remove('hidden');
        let html = '';

        if (refCount) {
            html += `<div class="__trace-row"><span class="__trace-label">Revision</span><span class="__trace-value">#${refCount}</span></div>`;
        }
        if (render.refinement) {
            const escaped = render.refinement.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html += `<div class="__trace-row"><span class="__trace-label">Last Edit</span><span class="__trace-value" style="font-style:italic">"${escaped}"</span></div>`;
        }

        if (rr && rr.summary) {
            const s = rr.summary;
            html += `<div class="__trace-row"><span class="__trace-label">Changes</span><span class="__trace-value">${s.addedCount || 0} added, ${s.removedCount || 0} removed, ${s.modifiedCount || 0} modified</span></div>`;

            if (s.driftRejected) {
                html += `<div class="__warn-item __warn-item--warn"><span class="__warn-icon">!</span><span class="__warn-text">Drift rejected: LLM output discarded, only targeted patches applied</span></div>`;
            } else if (s.driftDetected) {
                html += `<div class="__warn-item __warn-item--warn"><span class="__warn-icon">!</span><span class="__warn-text">Structural drift detected: structural elements changed despite equipment-only request</span></div>`;
            }
            if (s.disproportionate) {
                html += `<div class="__warn-item __warn-item--warn"><span class="__warn-icon">!</span><span class="__warn-text">Large-scale changes: over 50% of elements affected</span></div>`;
            }
            if (s.unresolvedTargets && s.unresolvedTargets.length > 0) {
                const ambiguousCount = s.unresolvedTargets.filter(t => t.reason === 'AMBIGUOUS').length;
                const otherCount = s.unresolvedTargets.length - ambiguousCount;
                if (ambiguousCount > 0) {
                    html += `<div class="__warn-item __warn-item--warn"><span class="__warn-icon">!</span><span class="__warn-text">${ambiguousCount} requested change(s) not applied — ambiguous element match</span></div>`;
                }
                if (otherCount > 0) {
                    html += `<div class="__warn-item __warn-item--info"><span class="__warn-icon">i</span><span class="__warn-text">${otherCount} target(s) could not be resolved</span></div>`;
                }
            }
        }

        // Phase 6: Readiness delta display
        const rd = render.readinessDelta;
        if (rd && rd.previousScore !== undefined && rd.currentScore !== undefined) {
            const deltaSign = rd.delta >= 0 ? '+' : '';
            const deltaClass = rd.delta > 0 ? 'positive' : rd.delta < 0 ? 'negative' : 'neutral';
            html += `<div class="__trace-row"><span class="__trace-label">Readiness</span><span class="__trace-value"><span class="__refinement-delta __refinement-delta--${deltaClass}">${rd.previousScore} → ${rd.currentScore} (${deltaSign}${rd.delta})</span></span></div>`;
        }

        // Phase 6: Authoring suitability transition
        if (rd && rd.previousAuthoringSuitability && rd.currentAuthoringSuitability && rd.previousAuthoringSuitability !== rd.currentAuthoringSuitability) {
            html += `<div class="__trace-row"><span class="__trace-label">Authoring</span><span class="__trace-value">${rd.previousAuthoringSuitability} → ${rd.currentAuthoringSuitability}</span></div>`;
        }

        // Phase 6: Scope confidence display
        const sc = rr?.scopeConfidence;
        if (sc !== undefined && sc !== null) {
            const band = sc >= 70 ? 'high' : sc >= 40 ? 'medium' : 'low';
            html += `<div class="__trace-row"><span class="__trace-label">Scope Confidence</span><span class="__trace-value"><span class="__refinement-confidence __refinement-confidence--${band}"><span class="__refinement-confidence-bar"><span class="__refinement-confidence-fill" style="width:${sc}%"></span></span> <span class="__refinement-confidence-label">${sc}/100</span></span></span></div>`;
        }

        // Phase 6: Refinement type
        if (rr?.refinementType && rr.refinementType !== 'MIXED') {
            const typeLabel = rr.refinementType.replace(/_/g, ' ').toLowerCase().replace(/^\w/, c => c.toUpperCase());
            html += `<div class="__trace-row"><span class="__trace-label">Type</span><span class="__trace-value">${typeLabel}</span></div>`;
        }

        content.innerHTML = html;
    },

    /**
     * Display source files as downloadable boxes
     */
    _displayFiles(fileNames) {
        const filesContainer = this.element.querySelector('.__details-files');
        if (!filesContainer) return;

        filesContainer.innerHTML = fileNames.map((fileName) => {
            const fileExt = this._getFileExtension(fileName);
            return `
                <div class="__details-file-item-box __details-file-downloadable" data-filename="${fileName}" title="Click to download ${fileName}">
                    <span class="__details-file-item-box-name">${fileName}</span>
                    <span class="__details-file-item-box-badge">${fileExt}</span>
                </div>
            `;
        }).join('');

        // Bind click handlers for download
        filesContainer.querySelectorAll('.__details-file-downloadable').forEach(el => {
            el.addEventListener('click', () => this._downloadSourceFile(el.dataset.filename));
        });
    },

    /**
     * Download a source file
     */
    async _downloadSourceFile(fileName) {
        if (!this.currentRender) return;

        try {
            const result = await rendersService.getSourceFile(this.currentRender.render_id, fileName);
            if (result.error) {
                console.error('Source file download error:', result.error);
                return;
            }

            // Decode base64 and trigger download
            const byteChars = atob(result.fileData);
            const byteArray = new Uint8Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) {
                byteArray[i] = byteChars.charCodeAt(i);
            }
            const blob = new Blob([byteArray]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Error downloading source file:', error);
        }
    },

    /**
     * Get file extension from filename
     */
    _getFileExtension(filename) {
        const ext = filename.split('.').pop().toUpperCase();
        return ext.length > 5 ? ext.substring(0, 5) : ext;
    },

    /**
     * Display traceability / generation report
     */
    _displayTracingReport(render) {
        const section = this.element.querySelector('.__details-traceability');
        const content = this.element.querySelector('.__details-traceability-content');
        if (!section || !content) return;

        const tr = render.tracingReport;
        const mode = render.outputMode;
        if (!tr && !mode) { section.classList.add('hidden'); return; }

        section.classList.remove('hidden');

        const modeColors = { FULL_SEMANTIC: '#4ade80', HYBRID: '#facc15', PROXY_ONLY: '#f87171' };
        const roleColors = { NARRATIVE: '#60a5fa', TECHNICAL_NARRATIVE: '#818cf8', SCHEDULE: '#fb923c', SIMULATION: '#34d399', DEFAULT: '#9ca3af', UNKNOWN: '#9ca3af' };

        let html = '';

        // Output mode badge
        if (mode) {
            const col = modeColors[mode] || '#9ca3af';
            html += `<div class="__trace-row"><span class="__trace-label">Output Mode</span><span class="__trace-badge" style="background:${col}22;color:${col};border:1px solid ${col}44">${mode}</span></div>`;
        }

        if (tr) {
            // Confidence breakdown
            const { high = 0, medium = 0, low = 0 } = tr.confidence || {};
            const total = tr.totalElements || 0;
            if (total > 0) {
                html += `<div class="__trace-row"><span class="__trace-label">Elements</span><span class="__trace-value">${total} total &nbsp;·&nbsp; <span style="color:#4ade80">${high} high</span> &nbsp;·&nbsp; <span style="color:#facc15">${medium} med</span> &nbsp;·&nbsp; <span style="color:#f87171">${low} low</span></span></div>`;
            }

            // Per-file contribution rows
            const byFile = tr.byFile || {};
            const fileNames = Object.keys(byFile);
            if (fileNames.length > 0) {
                html += `<div class="__trace-files">`;
                for (const fname of fileNames) {
                    const entry = byFile[fname];
                    const role = entry.sourceRole || 'UNKNOWN';
                    const col = roleColors[role] || '#9ca3af';
                    const typeStr = Object.entries(entry.types || {}).map(([t, c]) => `${c}×${t}`).join(', ');
                    html += `<div class="__trace-file-row"><span class="__trace-file-name" title="${fname}">${fname}</span><span class="__trace-badge" style="background:${col}22;color:${col};border:1px solid ${col}44">${role}</span><span class="__trace-count">${entry.count} el</span></div>`;
                    if (typeStr) html += `<div class="__trace-file-types">${typeStr}</div>`;
                }
                html += `</div>`;
            }

            // Source breakdown (LLM / VSM / DEFAULT)
            const src = tr.bySource || {};
            const srcParts = Object.entries(src).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`);
            if (srcParts.length > 0) {
                html += `<div class="__trace-row __trace-row-muted"><span class="__trace-label">Sources</span><span class="__trace-value">${srcParts.join(' &nbsp;·&nbsp; ')}</span></div>`;
            }
        }

        content.innerHTML = html;
    },

    /**
     * Display model quality score
     */
    _displayQualityScore(render) {
        const section = this.element.querySelector('.__details-quality');
        const content = this.element.querySelector('.__details-quality-content');
        if (!section || !content) return;

        const score = render.qualityScore;
        if (score === undefined && !render.validationSummary) { section.classList.add('hidden'); return; }

        section.classList.remove('hidden');
        const displayScore = score || 0;
        const scoreColor = displayScore >= 80 ? '#4ade80' : displayScore >= 60 ? '#facc15' : '#f87171';
        const scoreLabel = displayScore >= 80 ? 'Excellent' : displayScore >= 60 ? 'Good' : 'Needs Review';

        content.innerHTML = `
            <div class="__quality-score-row">
                <div class="__quality-score-ring" style="--score-color: ${scoreColor}; --score-pct: ${displayScore}%">
                    <span class="__quality-score-value">${displayScore}</span>
                </div>
                <div class="__quality-score-meta">
                    <span class="__quality-score-label" style="color:${scoreColor}">${scoreLabel}</span>
                    <span class="__quality-score-desc">Based on semantic coverage, validation, and structure completeness</span>
                </div>
            </div>
        `;
    },

    /**
     * Display model statistics (IFC class counts)
     */
    _displayStats(render) {
        const section = this.element.querySelector('.__details-stats');
        const content = this.element.querySelector('.__details-stats-content');
        if (!section || !content) return;

        const counts = render.elementCounts;
        if (!counts || Object.keys(counts).length === 0) { section.classList.add('hidden'); return; }

        section.classList.remove('hidden');

        // Sort by count descending, show top entries
        const sorted = Object.entries(counts)
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1]);

        const classColors = {
            'IfcWall': '#a1a1a8', 'IfcWallStandardCase': '#a1a1a8',
            'IfcSlab': '#8a8a90', 'IfcColumn': '#9090a0',
            'IfcSpace': '#60a5fa', 'IfcDoor': '#92613a', 'IfcWindow': '#7ec8e3',
            'IfcDuctSegment': '#3b82f6', 'IfcPipeSegment': '#34d399',
            'IfcFan': '#f59e0b', 'IfcPump': '#14b8a6',
            'IfcBuildingElementProxy': '#ef4444',
        };

        const total = sorted.reduce((s, [, v]) => s + v, 0);

        content.innerHTML = `
            <div class="__stats-total">Total: ${total} elements</div>
            <div class="__stats-grid">
                ${sorted.map(([cls, count]) => {
                    const readable = cls.replace('Ifc', '').replace(/([a-z])([A-Z])/g, '$1 $2');
                    const color = classColors[cls] || '#9ca3af';
                    const pct = Math.round(count * 100 / total);
                    return `<div class="__stats-row">
                        <span class="__stats-dot" style="background:${color}"></span>
                        <span class="__stats-name">${readable}</span>
                        <span class="__stats-count">${count}</span>
                        <span class="__stats-bar"><span class="__stats-bar-fill" style="width:${pct}%;background:${color}"></span></span>
                    </div>`;
                }).join('')}
            </div>
        `;

        // Phase 11: Show export format badges
        const exportSection = this.element.querySelector('.__details-export-formats');
        const exportBadges = this.element.querySelector('.__details-export-badges');
        if (exportSection && exportBadges) {
            const formats = render.exportFormats || render.export_formats || ['IFC4'];
            if (formats.length > 0) {
                exportSection.classList.remove('hidden');
                exportBadges.innerHTML = formats.map(f => {
                    const isExtra = f !== 'IFC4';
                    return `<span class="__details-export-badge${isExtra ? ' __details-export-badge--active' : ''}">${f}</span>`;
                }).join('');
            } else {
                exportSection.classList.add('hidden');
            }
        }
    },

    /**
     * Display structural notes (envelope fallback, geometry approximations, continuity, mounting)
     */
    _displayStructuralWarnings(render) {
        const section = this.element.querySelector('.__details-structural');
        const content = this.element.querySelector('.__details-structural-content');
        if (!section || !content) return;

        const sw = render.structuralWarnings || [];
        if (sw.length === 0) { section.classList.add('hidden'); return; }

        section.classList.remove('hidden');

        const renderItem = (icon, cls, text) =>
            `<div class="__warn-item ${cls}"><span class="__warn-icon">${icon}</span><span class="__warn-text">${text}</span></div>`;

        content.innerHTML = sw.map(w => {
            switch (w.type) {
                case 'envelope_fallback':
                    return renderItem('!', '__warn-item--warn', 'Simplified envelope generated — source had insufficient structural detail');
                case 'dimension_clamps':
                    return renderItem('!', '__warn-item--warn', `${w.count} element dimension${w.count > 1 ? 's' : ''} clamped to valid range`);
                case 'shell_continuity':
                    return renderItem('i', '__warn-item--info', `${w.pairsAligned} shell pairs aligned across ${w.groups} continuity group${w.groups > 1 ? 's' : ''}`);
                case 'equipment_mounted':
                    return renderItem('i', '__warn-item--info', `${w.count} equipment piece${w.count > 1 ? 's' : ''} repositioned for realistic mounting` + (w.originGuard > 0 ? ` (${w.originGuard} relocated from origin)` : ''));
                case 'geometry_approximation':
                    return renderItem('i', '__warn-item--info', `${w.count} curved geometr${w.count > 1 ? 'ies' : 'y'} approximated to rectangular`);
                case 'junction_transitions':
                    return renderItem('i', '__warn-item--info', `${w.elementCount} junction transition helpers generated (approximation geometry, not canonical structure)` + (w.voidHelpers > 0 ? ` — ${w.voidHelpers} companion void${w.voidHelpers > 1 ? 's' : ''}` : ''));
                case 'shell_extensions':
                    return renderItem('i', '__warn-item--info', `${w.count} shell pieces extended at ${w.nodes} junction${w.nodes > 1 ? 's' : ''} for continuity`);
                case 'curved_geometry':
                    return renderItem('i', '__warn-item--info', `${(w.circularCount || 0) + (w.horseshoeCount || 0)} circular/horseshoe voids approximated as polygons. Shell pieces remain rectangular.`);
                case 'opening_validation':
                    return renderItem('i', '__warn-item--info', `${w.total} openings validated, ${w.rehosted} rehosted, ${w.downgraded} downgraded to unresolved`);
                case 'wall_cleanup': {
                    const skipNote = w.skippedOverCap > 0 ? ` (${w.skippedOverCap} skipped — exceeded 0.3m movement cap)` : '';
                    return renderItem('i', '__warn-item--info', `${w.snappedCount} wall axes cleaned for alignment${skipNote}`);
                }
                case 'interior_coherence':
                    return renderItem('i', '__warn-item--info', `Interior coherence: ${w.grade}`);
                case 'refinement_report': {
                    const s = w.summary || {};
                    return renderItem('i', '__warn-item--info', `Revision — ${s.addedCount || 0} added, ${s.removedCount || 0} removed, ${s.modifiedCount || 0} modified`);
                }
                case 'approximation_proxies':
                    return renderItem('i', '__warn-item--info', `${w.count} approximation helper prox${w.count > 1 ? 'ies' : 'y'} (junction/bend plugs) — excluded from canonical element counts`);
                case 'safety':
                    return renderItem('!', '__warn-item--warn', w.detail);
                default:
                    return renderItem('i', '__warn-item--info', w.type + (w.detail ? `: ${w.detail}` : ''));
            }
        }).join('');
    },

    /**
     * Display generation warnings (proxies, missing systems, fallbacks)
     */
    _displayWarnings(render) {
        const section = this.element.querySelector('.__details-warnings');
        const content = this.element.querySelector('.__details-warnings-content');
        if (!section || !content) return;

        const warnings = [];
        const counts = render.elementCounts || {};
        const total = Object.values(counts).reduce((s, n) => s + n, 0);
        const proxyCount = counts['IfcBuildingElementProxy'] || 0;
        const proxyPct = total > 0 ? Math.round(proxyCount * 100 / total) : 0;
        const vs = render.validationSummary || {};
        const mode = render.outputMode;
        const tr = render.tracingReport || {};

        if (proxyPct > 30)
            warnings.push({ level: 'warn', text: `${proxyPct}% of elements are unclassified proxies` });
        if (!counts['IfcPipeSegment'] && !counts['IfcPump'] && total > 10)
            warnings.push({ level: 'info', text: 'No piping or pump systems detected' });
        if (mode === 'PROXY_ONLY')
            warnings.push({ level: 'warn', text: 'Model in PROXY_ONLY fallback mode' });
        if (tr.envelopeFallbackApplied)
            warnings.push({ level: 'info', text: 'Simplified envelope — insufficient structural detail in source' });
        if (tr.interiorSuppression?.suppressed > 0)
            warnings.push({ level: 'info', text: `${tr.interiorSuppression.suppressed} implausible rooms removed` });
        if (vs.warningCount > 3)
            warnings.push({ level: 'warn', text: `${vs.warningCount} IFC validation warnings` });

        const confDist = tr.confidence || {};
        if (confDist.low > confDist.high && confDist.low > 0)
            warnings.push({ level: 'info', text: `More low-confidence (${confDist.low}) than high-confidence (${confDist.high}) elements` });

        if (warnings.length === 0) { section.classList.add('hidden'); return; }
        section.classList.remove('hidden');

        content.innerHTML = warnings.map(w => {
            const cls = w.level === 'warn' ? '__warn-item--warn' : '__warn-item--info';
            const icon = w.level === 'warn' ? '!' : 'i';
            return `<div class="__warn-item ${cls}"><span class="__warn-icon">${icon}</span><span class="__warn-text">${w.text}</span></div>`;
        }).join('');
    },

    /**
     * Display unmodeled findings from source fusion
     */
    _displayOmitted(render) {
        const section = this.element.querySelector('.__details-omitted');
        const content = this.element.querySelector('.__details-omitted-content');
        if (!section || !content) return;

        const fusion = render.tracingReport?.sourceFusion || render.sourceFusion || {};
        const log = fusion.log || [];
        const unresolved = log.filter(l => l.reason === 'no_anchor' || l.reason === 'low_confidence' || l.reason === 'metadata_only_low_confidence');

        if (unresolved.length === 0) { section.classList.add('hidden'); return; }
        section.classList.remove('hidden');

        const reasonLabels = { no_anchor: 'No anchor', low_confidence: 'Low confidence', metadata_only_low_confidence: 'Low confidence' };

        content.innerHTML =
            `<p class="__omitted-desc">${unresolved.length} item${unresolved.length > 1 ? 's' : ''} found in documents but not modeled:</p>` +
            unresolved.slice(0, 10).map(u =>
                `<div class="__omitted-item">
                    <span class="__omitted-name">${u.name || 'Unknown'}</span>
                    <span class="__omitted-type">${u.type || ''}</span>
                    <span class="__omitted-reason">${reasonLabels[u.reason] || u.reason}</span>
                </div>`
            ).join('') +
            (unresolved.length > 10 ? `<p class="__omitted-more">+ ${unresolved.length - 10} more</p>` : '');
    },

    /**
     * Display sensor telemetry section for a completed render
     */
    async _displaySensors(render) {
        const section = this.element.querySelector('.__details-sensors');
        const content = this.element.querySelector('.__details-sensors-content');
        if (!section || !content) return;

        try {
            const data = await sensorService.getSensors(render.render_id);
            const sensors = data.sensors || [];

            if (sensors.length === 0) { section.classList.add('hidden'); return; }

            section.classList.remove('hidden');
            this._renderSensorCards(content, sensors);
        } catch (e) {

            section.classList.add('hidden');
        }
    },

    /**
     * Update sensor readings when telemetry polling refreshes data
     */
    _updateSensorReadings(sensors) {
        const content = this.element.querySelector('.__details-sensors-content');
        if (!content || !sensors || sensors.length === 0) return;

        const section = this.element.querySelector('.__details-sensors');
        if (section) section.classList.remove('hidden');
        this._renderSensorCards(content, sensors);
    },

    /**
     * Render sensor cards grouped by type
     */
    _renderSensorCards(container, sensors) {
        const statusColors = { normal: '#4ade80', warning: '#facc15', critical: '#ef4444' };
        const typeIcons = {
            TEMPERATURE: '&#x1f321;',
            AIRFLOW: '&#x1f4a8;',
            EQUIPMENT_STATUS: '&#x2699;',
            STRUCTURAL_LOAD: '&#x1f3d7;'
        };
        const typeLabels = {
            TEMPERATURE: 'Temperature',
            AIRFLOW: 'Airflow',
            EQUIPMENT_STATUS: 'Equipment Status',
            STRUCTURAL_LOAD: 'Structural Load'
        };

        // Group by sensor_type
        const grouped = {};
        for (const s of sensors) {
            if (!grouped[s.sensor_type]) grouped[s.sensor_type] = [];
            grouped[s.sensor_type].push(s);
        }

        let html = '';
        for (const [type, items] of Object.entries(grouped)) {
            const icon = typeIcons[type] || '';
            const label = typeLabels[type] || type;
            html += `<div class="__sensor-group">`;
            html += `<div class="__sensor-group-header"><span class="__sensor-group-icon">${icon}</span> ${label} <span class="__sensor-group-count">(${items.length})</span></div>`;

            for (const s of items.slice(0, 10)) {
                const color = statusColors[s.status] || '#94a3b8';
                const displayValue = s.unit ? `${s.current_value} ${s.unit}` : s.current_value;
                html += `<div class="__sensor-card" style="border-left-color:${color}">
                    <div class="__sensor-card-info">
                        <span class="__sensor-card-name">${s.display_name}</span>
                        <span class="__sensor-card-element">${s.element_type}</span>
                    </div>
                    <div class="__sensor-card-reading">
                        <span class="__sensor-value">${displayValue}</span>
                        <span class="__sensor-status" style="background:${color}22;color:${color}">${s.status}</span>
                    </div>
                </div>`;
            }
            if (items.length > 10) {
                html += `<div class="__sensor-more">+ ${items.length - 10} more</div>`;
            }
            html += `</div>`;
        }

        container.innerHTML = html;
    },

    /**
     * Download verification report
     */
    async _downloadReport() {
        if (!this.currentRender) return;
        try {
            const result = await rendersService.getVerificationReport(this.currentRender.render_id);
            if (result.error) {
                console.error('Report download error:', result.error);
                return;
            }
            const blob = new Blob([JSON.stringify(result.report, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `verification_report_${this.currentRender.render_id}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error('Error downloading report:', error);
        }
    },

    /**
     * Handle delete render
     */
    async _handleDelete() {
        if (!this.currentRender) return;

        const confirmed = await modalService.confirm(
            'Delete Render',
            'Are you sure you want to delete this render? This cannot be undone.',
            'Delete',
            'Cancel'
        );
        if (!confirmed) return;

        try {
            const renderId = this.currentRender.render_id;
            await rendersService.deleteRender(renderId);

            // Redirect to welcome screen (same as new render)
            document.dispatchEvent(new CustomEvent('newRenderRequested'));

            // Refresh renders list in sidebar
            document.dispatchEvent(new CustomEvent('rendersUpdated'));

        } catch (error) {
            console.error('Error deleting render:', error);
            await modalService.alert('Error', `Failed to delete render: ${error.message}`);
        }
    }
};

export default details;
