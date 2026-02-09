import loginTemplate from './login.hbs';
import './login.css';
import authenticateService from '../../services/authenticateService.js';

const login = {
    // Initialize the login component
    async init() {
        this._render();
        await this._loadData();
        this._bindListeners();
    },

    // Render HTML using Handlebars template
    _render() {
        this.element = document.querySelector('body');
        let html = loginTemplate({ main: true });
        this.element.innerHTML = html;
    },

    // Load initial data
    async _loadData() {
        // No data loading needed for login page
    },

    // Bind event listeners
    _bindListeners() {
        this.element.addEventListener('submit', (e) => {
            if (e.target.id === 'login-form') {
                e.preventDefault();
                this._handleLogin();
            }
        });

        // Optional: handle "Enter" key press
        this.element.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && e.target.id === 'email') {
                this._handleLogin();
            }
        });
    },

    _handleLogin() {
        const $emailInput = document.querySelector('#email');
        const $passwordInput = document.querySelector('#password');
        const $errorMsg = document.querySelector('#error-message');
        const $submitBtn = document.querySelector('#submit');

        const email = $emailInput.value.trim();
        const password = $passwordInput ? $passwordInput.value.trim() : '';

        if (!this._isValidEmail(email)) {
            if ($errorMsg) {
                $errorMsg.textContent = 'Please enter a valid email address.';
            }
            return;
        }

        if (!password) {
            if ($errorMsg) {
                $errorMsg.textContent = 'Please enter a password.';
            }
            return;
        }

        $submitBtn.disabled = true;
        this._attemptLogin(email, password, $emailInput, $errorMsg, $submitBtn);
    },

    async _attemptLogin(email, password, $emailInput, $errorMsg, $submitBtn) {
        try {
            // Call authenticateService to login
            await authenticateService.login(email, password);
            // Redirect to dashboard on success
            window.location.href = '/';
        } catch (error) {
            $submitBtn.disabled = false;
            if ($errorMsg) {
                $errorMsg.textContent = error.message || 'Login failed. Please try again.';
            }
            $emailInput.focus();
        }
    },

    _isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }
};

export default login;
