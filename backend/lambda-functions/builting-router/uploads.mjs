import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import renders from './renders.mjs';

const s3 = new S3Client({});
const DATA_BUCKET = process.env.DATA_BUCKET || 'builting-data';

const ALLOWED_EXTENSIONS = new Set(['.txt', '.pdf', '.xlsx', '.xls', '.docx', '.dxf',
  '.vsm', '.dwg', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.csv', '.json']);
const MAX_FILES = 20;
const MAX_FILENAME_LENGTH = 255;

function validateFileNames(fileNames) {
  if (!Array.isArray(fileNames) || fileNames.length === 0) {
    return 'At least one file is required';
  }
  if (fileNames.length > MAX_FILES) {
    return `Too many files (max ${MAX_FILES})`;
  }
  for (const name of fileNames) {
    if (typeof name !== 'string' || name.length === 0) return 'Invalid filename';
    if (name.length > MAX_FILENAME_LENGTH) return `Filename too long: ${name.substring(0, 50)}...`;
    if (/[\/\\]|\.\.|\x00/.test(name)) return `Invalid characters in filename: ${name}`;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(name)) return `Control characters in filename: ${name}`;
    const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
    if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
      return `Unsupported file type: ${ext || 'none'}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`;
    }
  }
  return null;
}

const uploads = {
  handle: async (event) => {
    const { fileNames, description } = JSON.parse(event.body || '{}');
    const userId = event._authenticatedUserId;

    try {
      // Validate file names before doing anything
      const validationError = validateFileNames(fileNames);
      if (validationError) {
        return { error: validationError, statusCode: 400 };
      }

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
        const cmd = new PutObjectCommand({ Bucket: DATA_BUCKET, Key: `${path}/${name}` });
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
