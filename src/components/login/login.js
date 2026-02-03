import loginTemplate from './login.hbs';
import './login.css';

const login = {
    // Check if user is logged in via local storage
    verify() {
        return localStorage.getItem('userEmail') !== null;
    },

    // Clear local storage and reload
    logout() {
        localStorage.removeItem('userEmail');
        window.location.reload();
    },

    // Initialize login page
    init() {
        const body = document.body;
        body.innerHTML = loginTemplate();
        this._bindEvents();
    },

    _bindEvents() {
        const form = document.querySelector('#login-form');
        const emailInput = document.querySelector('#email');

        if (!form) return;

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this._handleLogin(emailInput);
        });
    },

    _handleLogin(emailInput) {
        const email = emailInput.value.trim();
        const errorMsg = document.querySelector('#error-message');
        const submitBtn = document.querySelector('#submit');

        if (this._isValidEmail(email)) {
            submitBtn.disabled = true;
            // Save to local storage
            localStorage.setItem('userEmail', email);
            // Reload to show authenticated app
            setTimeout(() => {
                window.location.reload();
            }, 300);
        } else {
            if (errorMsg) {
                errorMsg.textContent = 'Please enter a valid email address.';
            }
        }
    },

    _isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }
};

export default login;
