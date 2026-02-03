import login from './components/login/login.js';
import layout from './components/layout/layout.js';

const main = {
    init() {
        const loggedIn = login.verify();
        if (loggedIn) {
            layout.init();
        } else {
            login.init();
        }
    }
};

main.init();
