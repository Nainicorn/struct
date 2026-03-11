import aws from './aws.js';

const rendersService = {
  async getRenders() {
    return await aws.call('/api/renders', { method: 'GET' });
  },

  async getRender(renderId) {
    return await aws.call(`/api/renders/${renderId}`, { method: 'GET' });
  },

  async deleteRender(renderId) {
    return await aws.call(`/api/renders/${renderId}`, { method: 'DELETE' });
  },

  async getDownloadUrl(renderId) {
    return await aws.call(`/api/renders/${renderId}/download`, { method: 'GET' });
  }
};

export default rendersService;
