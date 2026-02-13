import aws from './aws.js';
import { userStore } from './userStore.js';

const rendersService = {
  async getRenders() {
    const user = userStore.getUser();
    const userId = user?.id;
    return await aws.call(`/api/renders?userId=${userId}`, { method: 'GET' });
  },

  async getRender(renderId) {
    const user = userStore.getUser();
    const userId = user?.id;
    return await aws.call(`/api/renders/${renderId}?userId=${userId}`, { method: 'GET' });
  },

  async deleteRender(renderId) {
    const user = userStore.getUser();
    const userId = user?.id;
    return await aws.call(`/api/renders/${renderId}?userId=${userId}`, { method: 'DELETE' });
  },

  async getDownloadUrl(renderId) {
    const user = userStore.getUser();
    const userId = user?.id;
    return await aws.call(`/api/renders/${renderId}/download?userId=${userId}`, { method: 'GET' });
  }
};

export default rendersService;
