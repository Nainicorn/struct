import template from './layout.hbs';
import './layout.css';
import header from '../header/header';
import sidebar from '../sidebar/sidebar';
import renderbox from '../renderbox/renderbox';
import details from '../details/details';

const layout = {
    _userCollapsed: false,
    _autoCollapsed: false,

    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    _render() {
        const $body = document.body;
        let html = template({ main: true });
        $body.innerHTML = html;
    },

    async _loadData() {
        await header.init();
        await sidebar.init();
        await renderbox.init();
        await details.init();
    },

    _bindListeners() {
        const $backdrop = document.querySelector('.__sidebar-backdrop');
        if ($backdrop) {
            $backdrop.addEventListener('click', () => {
                this._userCollapsed = true;
                document.body.setAttribute('data-collapsed', 'true');
            });
        }

        // Listen for user-initiated toggle from header
        document.addEventListener('sidebarToggled', () => {
            const isCollapsed = document.body.getAttribute('data-collapsed') === 'true';
            this._userCollapsed = isCollapsed;
            this._autoCollapsed = false;
        });

        this._syncCollapsedState();

        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => this._syncCollapsedState(), 100);
        });
    },

    _syncCollapsedState() {
        const isNarrow = window.innerWidth <= 900;

        if (isNarrow && !this._autoCollapsed) {
            this._autoCollapsed = true;
            document.body.setAttribute('data-collapsed', 'true');
        } else if (!isNarrow && this._autoCollapsed) {
            this._autoCollapsed = false;
            // Restore to user preference — only reopen if user didn't manually collapse
            if (!this._userCollapsed) {
                document.body.setAttribute('data-collapsed', 'false');
            }
        }
    }
};

export default layout;
