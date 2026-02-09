import aws from './aws.js';

const api = {
  /**
   * Get all renders for current user
   * @returns {Promise<Array>} Array of render objects
   */
  getRenders: async () => {
    return aws.call('/api/renders');
  },

  /**
   * Create a new render and get presigned upload URLs
   * @param {Array<string>} fileNames - Array of file names to upload
   * @returns {Promise<Object>} { id, uploadUrls, timestamp }
   */
  createRender: async (fileNames) => {
    return aws.call('/api/renders', {
      method: 'POST',
      body: JSON.stringify({ fileNames })
    });
  },

  /**
   * Upload a file to S3 using presigned URL
   * @param {string} url - Presigned S3 URL
   * @param {File} file - File object to upload
   * @returns {Promise<boolean>} True if successful
   */
  uploadToS3: async (url, file) => {
    const response = await fetch(url, {
      method: 'PUT',
      body: file,
      headers: {
        'Content-Type': file.type || 'application/octet-stream'
      }
    });
    return response.ok;
  },

  /**
   * Trigger the render processing pipeline (Step Functions)
   * @param {string} renderId - Render ID
   * @returns {Promise<Object>} { status: 'processing', renderId }
   */
  triggerProcessing: async (renderId) => {
    return aws.call(`/api/renders/${renderId}/process`, {
      method: 'POST'
    });
  },

  /**
   * Get presigned download URL for a completed IFC file
   * @param {string} renderId - Render ID
   * @returns {Promise<Object>} { downloadUrl }
   */
  getDownloadUrl: async (renderId) => {
    return aws.call(`/api/renders/${renderId}/download`);
  },

  /**
   * Delete a render
   * @param {string} renderId - Render ID
   * @returns {Promise<Object>} { deleted: true }
   */
  deleteRender: async (renderId) => {
    return aws.call(`/api/renders/${renderId}`, {
      method: 'DELETE'
    });
  },

  /**
   * Poll for render completion status
   * @param {Function} onUpdate - Callback with updated renders array
   * @param {number} interval - Poll interval in ms (default 4000)
   * @returns {void}
   */
  poll: (onUpdate, interval = 4000) => {
    const poll = async () => {
      try {
        const renders = await api.getRenders();
        onUpdate(renders);

        // Continue polling if any renders are still processing
        const hasProcessing = renders.some(r =>
          r.status === 'pending' || r.status === 'processing'
        );

        if (hasProcessing) {
          setTimeout(poll, interval);
        }
      } catch (error) {
        console.error('Poll error:', error);
        // Retry after interval on error
        setTimeout(poll, interval);
      }
    };

    poll();
  }
};

export default api;
