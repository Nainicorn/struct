// Cookie Service - Handle all cookie operations
const cookieService = {
    set(cname, cvalue, minutes = 60) {
        const d = new Date();
        d.setTime(d.getTime() + minutes * 60 * 1000);
        const expires = `expires=${d.toUTCString()}`;
        document.cookie = `${cname}=${cvalue};${expires};path=/`;
    },

    get(cname) {
        const nameEQ = cname + "=";
        const ca = document.cookie.split(';');
        for (let i = 0; i < ca.length; i++) {
            let c = ca[i].trim();
            if (c.indexOf(nameEQ) === 0) {
                return c.substring(nameEQ.length, c.length);
            }
        }
        return null;
    },

    delete(cname) {
        this.set(cname, "", -1);
    }
};

export default cookieService;
