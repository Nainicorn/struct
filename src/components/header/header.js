import template from './header.hbs';
import './header.css';

const header = {
    element: null,

    init() {
        this.element = document.querySelector('.__header');
        this.element.innerHTML = template();

        this._bindEvents();
    },

    _bindEvents() {
        this.element.addEventListener('click', (e) => {
            // Handle toggle button
            const toggle = e.target.closest('.__header-toggle');
            if (toggle) {
                this._toggle();
                return;
            }

            // Handle logout button
            const logout = e.target.closest('.__header-logout');
            if (logout) {
                this._handleLogout();
                return;
            }
        });
    },

    _toggle() {
        const body = document.body;
        const isCollapsed = body.getAttribute('data-collapsed') === 'true';
        body.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true');
    },

    _handleLogout() {
        localStorage.removeItem('userEmail');
        window.location.reload();
    }
};

export default header;
