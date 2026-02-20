import login from './components/login/login.js';
import layout from './components/layout/layout.js';
import authService from './services/authService.js';
import './styles/modal.css';

const main = {
    init() {
        const loggedIn = authService.isAuthenticated();
        if (loggedIn) {
            layout.init();
        } else {
            login.init();
        }
    }
};

main.init();
