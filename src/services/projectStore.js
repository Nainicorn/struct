// Project Store - Track currently selected project
const projectStore = {
  currentProject: null,

  setProject(projectData) {
    this.currentProject = projectData;
    if (projectData?.id) {
      localStorage.setItem('current_project_id', projectData.id);
      localStorage.setItem('current_project_data', JSON.stringify(projectData));
    }
  },

  getProjectId() {
    if (this.currentProject?.id) return this.currentProject.id;
    return localStorage.getItem('current_project_id');
  },

  getProject() {
    if (this.currentProject) return this.currentProject;
    const stored = localStorage.getItem('current_project_data');
    return stored ? JSON.parse(stored) : null;
  },

  clear() {
    this.currentProject = null;
    localStorage.removeItem('current_project_id');
    localStorage.removeItem('current_project_data');
  }
};

export { projectStore };
