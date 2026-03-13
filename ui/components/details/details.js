import template from './details.hbs';
import './details.css';
import rendersService from '../../services/rendersService.js';
import modalService from '../../services/modalService.js';

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

        // Download report button
        const reportBtn = this.element.querySelector('.__details-download-report');
        if (reportBtn) {
            reportBtn.addEventListener('click', async () => {
                await this._downloadReport();
            });
        }

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

        // Display traceability report
        this._displayTracingReport(render);

        // Display quality score
        this._displayQualityScore(render);

        // Display validation summary
        this._displayValidation(render);

        // Display model statistics
        this._displayStats(render);

        // Show download report button if render is complete
        const reportBtn = this.element.querySelector('.__details-download-report');
        if (reportBtn) {
            reportBtn.style.display = render.status === 'completed' ? 'flex' : 'none';
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
        // Clear all content when hiding
        const titleEl = this.element.querySelector('.__details-title');
        const descEl = this.element.querySelector('.__details-description');
        const filesContainer = this.element.querySelector('.__details-files');
        const traceSection = this.element.querySelector('.__details-traceability');
        const traceContent = this.element.querySelector('.__details-traceability-content');
        const qualitySection = this.element.querySelector('.__details-quality');
        const qualityContent = this.element.querySelector('.__details-quality-content');
        const valSection = this.element.querySelector('.__details-validation');
        const valContent = this.element.querySelector('.__details-validation-content');
        const statsSection = this.element.querySelector('.__details-stats');
        const statsContent = this.element.querySelector('.__details-stats-content');
        if (titleEl) titleEl.textContent = '';
        if (descEl) descEl.textContent = '';
        if (filesContainer) filesContainer.innerHTML = '';
        if (traceContent) traceContent.innerHTML = '';
        if (traceSection) traceSection.style.display = 'none';
        if (qualityContent) qualityContent.innerHTML = '';
        if (qualitySection) qualitySection.style.display = 'none';
        if (valContent) valContent.innerHTML = '';
        if (valSection) valSection.style.display = 'none';
        if (statsContent) statsContent.innerHTML = '';
        if (statsSection) statsSection.style.display = 'none';
    },

    /**
     * Display render title
     */
    _displayTitle(render) {
        const titleEl = this.element.querySelector('.__details-title');
        if (titleEl) {
            titleEl.textContent = render.ai_generated_title || render.title || 'Untitled Render';
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
        if (!tr && !mode) { section.style.display = 'none'; return; }

        section.style.display = 'flex';

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
        if (score === undefined && !render.validationSummary) { section.style.display = 'none'; return; }

        section.style.display = 'flex';
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
     * Display validation summary
     */
    _displayValidation(render) {
        const section = this.element.querySelector('.__details-validation');
        const content = this.element.querySelector('.__details-validation-content');
        if (!section || !content) return;

        const vs = render.validationSummary;
        if (!vs) { section.style.display = 'none'; return; }

        section.style.display = 'flex';

        const checks = [
            { label: 'Geometry Valid', pass: vs.valid, icon: vs.valid ? '✓' : '✗' },
            { label: 'Spatial Hierarchy', pass: vs.valid, icon: vs.valid ? '✓' : '✗' },
            { label: 'Revit Compatibility', pass: vs.revitCompatScore >= 70,
              detail: `${vs.revitCompatScore || 0}%`,
              icon: vs.revitCompatScore >= 70 ? '✓' : '!' },
        ];

        // Proxy check
        const proxyPct = vs.totalElements > 0 ? Math.round(vs.proxyCount * 100 / vs.totalElements) : 0;
        checks.push({
            label: 'Proxy Elements',
            pass: proxyPct < 30,
            detail: `${vs.proxyCount} (${proxyPct}%)`,
            icon: proxyPct < 30 ? '✓' : '!'
        });

        // Errors/warnings
        if (vs.errorCount > 0) {
            checks.push({ label: 'Validation Errors', pass: false, detail: `${vs.errorCount}`, icon: '✗' });
        }
        if (vs.warningCount > 0) {
            checks.push({ label: 'Warnings', pass: vs.warningCount < 5, detail: `${vs.warningCount}`, icon: '!' });
        }

        content.innerHTML = checks.map(c => {
            const cls = c.pass ? '__val-pass' : (c.icon === '!' ? '__val-warn' : '__val-fail');
            return `<div class="__val-row ${cls}">
                <span class="__val-icon">${c.icon}</span>
                <span class="__val-label">${c.label}</span>
                ${c.detail ? `<span class="__val-detail">${c.detail}</span>` : ''}
            </div>`;
        }).join('');
    },

    /**
     * Display model statistics (IFC class counts)
     */
    _displayStats(render) {
        const section = this.element.querySelector('.__details-stats');
        const content = this.element.querySelector('.__details-stats-content');
        if (!section || !content) return;

        const counts = render.elementCounts;
        if (!counts || Object.keys(counts).length === 0) { section.style.display = 'none'; return; }

        section.style.display = 'flex';

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
            console.log('Deleting render:', renderId);

            await rendersService.deleteRender(renderId);

            // Redirect to welcome screen (same as new render)
            document.dispatchEvent(new CustomEvent('newRenderRequested'));

            // Refresh renders list in sidebar
            document.dispatchEvent(new CustomEvent('rendersUpdated'));

            console.log('Render deleted successfully');
        } catch (error) {
            console.error('Error deleting render:', error);
            await modalService.alert('Error', `Failed to delete render: ${error.message}`);
        }
    }
};

export default details;
