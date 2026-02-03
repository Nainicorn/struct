import template from './sidebar.hbs';
import './sidebar.css';
import controls from '../controls/controls';
import renders from '../renders/renders';

const sidebar = {
    element: null,

    init() {
        this.element = document.querySelector('.__sidebar');
        this.element.innerHTML = template();

        controls.init();
        renders.init();
    }
};

export default sidebar;
