import login from './components/login/login.js';
import layout from './components/layout/layout.js';
import authenticateService from './services/authenticateService.js';

const main = {
    init() {
        const loggedIn = authenticateService.isAuthenticated();
        if (loggedIn) {
            layout.init();
        } else {
            login.init();
        }
    }
};

main.init();
