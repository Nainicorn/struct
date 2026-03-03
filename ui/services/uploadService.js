import aws from './aws.js';
import { userStore } from './userStore.js';

const uploadService = {
  async getPresignedUrls(fileNames, description = '') {
    const user = userStore.getUser();
    const userId = user?.id;
    if (!userId) throw new Error('User not authenticated');

    return await aws.call('/api/uploads/presigned', {
      method: 'POST',
      body: JSON.stringify({ fileNames, userId, description })
    });
  },

  async uploadToS3(url, file) {
    const res = await fetch(url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' }
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  },

  async uploadDescription(url, description) {
    const blob = new Blob([description], { type: 'text/plain' });
    const res = await fetch(url, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'text/plain' }
    });
    if (!res.ok) throw new Error(`Description upload failed: ${res.status}`);
  },

  async finalizeRender(renderId) {
    const user = userStore.getUser();
    const userId = user?.id;
    if (!userId) throw new Error('User not authenticated');

    return await aws.call(`/api/renders/${renderId}/finalize?userId=${encodeURIComponent(userId)}`, {
      method: 'POST'
    });
  }
};

export default uploadService;
