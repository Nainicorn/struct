const userStore = {
  user: null,

  setUser(userData) {
    this.user = userData;
    if (userData?.id) {
      localStorage.setItem('user_id', userData.id);
      localStorage.setItem('user_data', JSON.stringify(userData));
    }
  },

  getUserId() {
    if (this.user?.id) return this.user.id;
    return localStorage.getItem('user_id');
  },

  getUser() {
    if (this.user) return this.user;
    const stored = localStorage.getItem('user_data');
    return stored ? JSON.parse(stored) : null;
  },

  clear() {
    this.user = null;
    localStorage.removeItem('user_id');
    localStorage.removeItem('user_data');
  }
};

export { userStore };
