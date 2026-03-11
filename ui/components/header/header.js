import template from './header.hbs';
import './header.css';
import usersService from '../../services/usersService.js';
import authService from '../../services/authService.js';

const header = {
    // Initialize the header component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('.__header');
        let html = template({ main: true });
        this.element.innerHTML = html;
    },

    // Load user data from service
    async _loadData() {
        try {
            this.user = await usersService.getCurrentUser();
            this._updateUserDisplay();
        } catch (error) {
            console.error('Failed to load user:', error);
        }
    },

    // Update user display in header
    _updateUserDisplay() {
        if (this.user) {
            const $userName = this.element.querySelector('.__header-user-name');
            if ($userName) {
                $userName.textContent = this.user.name || 'User';
            }
        }
    },

    // Bind event listeners
    _bindListeners() {
        this.element.addEventListener('click', (e) => {
            // Handle toggle button
            const $toggle = e.target.closest('.__header-toggle');
            if ($toggle) {
                this._handleToggle();
                return;
            }

            // Handle logout button
            const $logout = e.target.closest('.__header-logout');
            if ($logout) {
                this._handleLogout();
                return;
            }
        });
    },

    // Set title in header center
    setTitle(title) {
        const $center = this.element.querySelector('.__header-center');
        if ($center) {
            if (title) {
                $center.textContent = title;
                $center.style.display = 'block';
            } else {
                $center.textContent = '';
                $center.style.display = 'none';
            }
        }
    },

    // Clear title from header center
    clearTitle() {
        this.setTitle('');
    },

    _handleToggle() {
        const $body = document.body;
        const isCollapsed = $body.getAttribute('data-collapsed') === 'true';
        $body.setAttribute('data-collapsed', isCollapsed ? 'false' : 'true');
        document.dispatchEvent(new CustomEvent('sidebarToggled'));
    },

    _handleLogout() {
        authService.logout();
    }
};

export default header;
