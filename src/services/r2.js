import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: config.r2.endpoint,
  credentials: {
    accessKeyId:     config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
  requestChecksumCalculation:  'WHEN_REQUIRED',
  responseChecksumValidation:  'WHEN_REQUIRED',
});

// Returns a signed URL the frontend can PUT a file to directly (expires in 1 hour)
export async function getSignedUploadUrl(key, contentType) {
  const command = new PutObjectCommand({
    Bucket:      config.r2.bucket,
    Key:         key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, command, { expiresIn: 3600 });
}

// Uploads a Buffer directly from the server (no signed URL round-trip)
export async function putObject(key, buffer, contentType) {
  const command = new PutObjectCommand({
    Bucket:       config.r2.bucket,
    Key:          key,
    Body:         buffer,
    ContentType:  contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  });
  await r2.send(command);
  return `${config.r2.publicUrl}/${key}`;
}

// Downloads an object's bytes as a Buffer (server-side).
export async function getObjectBuffer(key) {
  const out = await r2.send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }));
  return Buffer.from(await out.Body.transformToByteArray());
}

// Server-side copy of an object to a new key (no download round-trip). Used to SNAPSHOT a shared
// asset (e.g. a cake-template thumbnail) into a tenant-owned key, so the copy is INDEPENDENT of the
// source — it survives even if the source is later replaced or deleted. CopySource must be
// URI-encoded. MetadataDirective REPLACE lets us set our own content-type + immutable cache.
export async function copyObject(srcKey, destKey, contentType) {
  await r2.send(new CopyObjectCommand({
    Bucket:            config.r2.bucket,
    CopySource:        encodeURIComponent(`${config.r2.bucket}/${srcKey}`),
    Key:               destKey,
    ContentType:       contentType || 'application/octet-stream',
    MetadataDirective: 'REPLACE',
    CacheControl:      'public, max-age=31536000, immutable',
  }));
  return `${config.r2.publicUrl}/${destKey}`;
}

// Deletes an object by key. R2 treats deleting a missing key as success, so this is
// safe to call even if the file is already gone.
export async function deleteObject(key) {
  await r2.send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }));
}

// Returns a signed URL to read a file (expires in 1 hour)
export async function getSignedReadUrl(key) {
  const command = new GetObjectCommand({
    Bucket: config.r2.bucket,
    Key:    key,
  });
  return getSignedUrl(r2, command, { expiresIn: 3600 });
}
