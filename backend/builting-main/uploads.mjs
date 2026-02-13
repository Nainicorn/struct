import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getUserIdFromCookies } from './auth.mjs';
import { randomUUID } from 'crypto';
import renders from './renders.mjs';

const s3 = new S3Client({ region: 'us-east-1' });

const uploads = {
  handle: async (event) => {
    const { fileNames, userId, description } = JSON.parse(event.body || '{}');

    if (!userId) {
      console.log('No userId in request body - returning 401');
      return { error: 'Auth required', statusCode: 401 };
    }

    try {
      console.log('Upload request for user:', userId);

      // Generate renderId (UUID) instead of timestamp
      const renderId = randomUUID();
      const path = `uploads/${userId}/${renderId}`;

      // Add description.txt to file list if description provided
      const allFileNames = [...fileNames];
      if (description && description.trim()) {
        allFileNames.push('description.txt');
      }

      // Create render record in DynamoDB BEFORE generating presigned URLs
      await renders.createRender(userId, renderId, description, allFileNames);

      // Generate presigned URLs for all files (including description.txt)
      const uploadUrls = {};
      for (const name of allFileNames) {
        const cmd = new PutObjectCommand({ Bucket: 'builting-data', Key: `${path}/${name}` });
        uploadUrls[name] = await getSignedUrl(s3, cmd, { expiresIn: 900 });
      }

      return {
        uploadUrls,
        s3_path: path,
        renderId,
        descriptionUrl: uploadUrls['description.txt'] || null
      };
    } catch (error) {
      console.error('Upload error:', error);
      return { error: error.message, statusCode: 500 };
    }
  }
};

export default uploads;
