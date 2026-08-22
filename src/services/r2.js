import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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

// Returns a signed URL the frontend can PUT a file to directly (expires in 1 hour).
//
// SEC-5: `contentLength` is signed INTO the signature, not merely checked. A presigned PUT otherwise
// constrains the key and the content-type and NOTHING ELSE — the body goes straight from the browser
// to R2 and never passes through us, so a size limit enforced in the client is advice, not a limit:
// any authenticated caller (customers included — sign-upload needs only `design:create`) could PUT a
// multi-GB object into a bucket we pay for and serve publicly. Signing Content-Length makes R2 itself
// the enforcer: the PUT must send exactly the length we signed, so a client that under-declares its
// size to slip past the cap produces a signature mismatch and is rejected at the edge.
export async function getSignedUploadUrl(key, contentType, contentLength) {
  const command = new PutObjectCommand({
    Bucket:        config.r2.bucket,
    Key:           key,
    ContentType:   contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(r2, command, { expiresIn: 3600, signableHeaders: new Set(['content-length']) });
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

// Is this key already in the bucket? HEAD, so no bytes are moved to find out.
//
// Existence is a sufficient test for "the right bytes are already here", which is only true because
// of two things: keys are UUIDs minted per upload, so nothing ever writes twice to one (replacing an
// element's picture mints a NEW key and repoints the row), and PutObject is atomic, so a failed
// upload leaves NO object rather than a truncated one. Neither holds for a hand-made key reused by
// somebody in the R2 console — that would defeat this, and there is no cheap way to notice.
//
// Any error that is not a plain 404 also reads as "not here": the caller's fallback is to copy,
// which is what it did before this existed. Guessing "present" from an ambiguous answer would skip a
// file that needs copying and leave a picture broken; guessing "absent" only costs a copy.
export async function objectExists(key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: config.r2.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
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

// ── Soft delete ─────────────────────────────────────────────────────────────────────
// Move an object under `deleted/` instead of destroying it, so a wrong call is recoverable and
// the bin can be reviewed before anything is really gone.
//
// The generated assets this exists for cost real money to produce and are impossible to
// reconstruct — the model will not return the same picture twice — so "delete" meaning "gone" is
// the wrong default for them. Reviewed and emptied by hand; this is deliberately NOT swept
// automatically, because an automatic sweep is just a slower permanent delete.
//
// Copy-then-delete rather than a move (S3 has no move). If the copy fails, nothing is deleted and
// the caller sees the error — the object is never lost between the two calls.
export async function archiveObject(key) {
  if (!key) return null;
  const archived = `deleted/${key}`;
  await copyObject(key, archived);
  await deleteObject(key);
  return archived;
}

// Returns a signed URL to read a file (expires in 1 hour)
export async function getSignedReadUrl(key) {
  const command = new GetObjectCommand({
    Bucket: config.r2.bucket,
    Key:    key,
  });
  return getSignedUrl(r2, command, { expiresIn: 3600 });
}
