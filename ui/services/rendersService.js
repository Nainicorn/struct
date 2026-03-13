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
  },

  async getSourceFile(renderId, fileName) {
    return await aws.call(`/api/renders/${renderId}/sources/${encodeURIComponent(fileName)}`, { method: 'GET' });
  },

  async getVerificationReport(renderId) {
    return await aws.call(`/api/renders/${renderId}/report`, { method: 'GET' });
  },

  async refineRender(renderId, refinement) {
    return await aws.call(`/api/renders/${renderId}/refine`, {
      method: 'POST',
      body: JSON.stringify({ refinement })
    });
  }
};

export default rendersService;
