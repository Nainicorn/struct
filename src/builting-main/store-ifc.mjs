import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'us-east-1' });

export const handler = async (event) => {
  console.log('StoreIFC input:', event);
  const { userId, renderId, ifcContent } = event;

  try {
    const ifc_s3_path = `s3://builting-ifc/${userId}/${renderId}/output.ifc`;
    const s3Key = `${userId}/${renderId}/output.ifc`;

    console.log(`Storing IFC to s3://builting-ifc/${s3Key}`);

    // Upload IFC file to builting-ifc bucket
    await s3.send(
      new PutObjectCommand({
        Bucket: 'builting-ifc',
        Key: s3Key,
        Body: ifcContent,
        ContentType: 'application/octet-stream'
      })
    );

    console.log('IFC file uploaded successfully');

    return {
      ...event,
      ifc_s3_path
    };
  } catch (error) {
    console.error('StoreIFC error:', error);
    throw error;
  }
};
