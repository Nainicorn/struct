import template from './layout.hbs';
import './layout.css';
import header from '../header/header';
import sidebar from '../sidebar/sidebar';
import renderbox from '../renderbox/renderbox';

const layout = {
    element: null,

    init() {
        const body = document.body;
        body.innerHTML = template();

        header.init();
        sidebar.init();
        renderbox.init();
    }
};

export default layout;
