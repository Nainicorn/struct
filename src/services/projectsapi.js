import aws from './aws.js';

// Default project name for auto-created projects
const DEFAULT_PROJECT_NAME = 'My Projects';

export default {
  /**
   * Get all projects for the current user
   * @returns {Promise<Array>} Array of project objects
   */
  getProjects: async () => {
    return aws.call('/api/projects');
  },

  /**
   * Get a specific project by ID
   * @param {string} projectId - Project ID
   * @returns {Promise<Object>} Project object
   */
  getProject: async (projectId) => {
    return aws.call(`/api/projects/${projectId}`);
  },

  /**
   * Create a new project
   * @param {string} name - Project name
   * @returns {Promise<Object>} { id, name, user_id, created_at, updated_at, status }
   */
  addProject: async (name) => {
    return aws.call('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: name || DEFAULT_PROJECT_NAME })
    });
  },

  /**
   * Update a project
   * @param {string} projectId - Project ID
   * @param {string} name - New project name
   * @returns {Promise<Object>} Updated project object
   */
  updateProject: async (projectId, name) => {
    return aws.call(`/api/projects/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    });
  },

  /**
   * Delete a project (cascades to delete all renders)
   * @param {string} projectId - Project ID
   * @returns {Promise<Object>} { deleted: true, id }
   */
  deleteProject: async (projectId) => {
    return aws.call(`/api/projects/${projectId}`, {
      method: 'DELETE'
    });
  },

  /**
   * Get or create default project for current user
   * Checks if a default project exists, creates one if not
   * @returns {Promise<Object>} Project object
   */
  getOrCreateDefaultProject: async () => {
    try {
      const projects = await exports.default.getProjects();

      // Look for existing default project
      const defaultProject = projects.find(p => p.name === DEFAULT_PROJECT_NAME);
      if (defaultProject) {
        return defaultProject;
      }

      // Create new default project if none exists
      return await exports.default.addProject(DEFAULT_PROJECT_NAME);
    } catch (error) {
      console.error('Error getting or creating default project:', error);
      throw error;
    }
  }
};
