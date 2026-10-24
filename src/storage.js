import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";

let adapter;
export const setStorage = (value) => {
  adapter = value;
}; // dependency injection for integration tests
export function storage() {
  if (adapter) return adapter;
  const client = new S3Client({
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    forcePathStyle: config.s3ForcePathStyle,
    maxAttempts: 2,
    ...(config.s3AccessKeyId
      ? {
          credentials: {
            accessKeyId: config.s3AccessKeyId,
            secretAccessKey: config.s3SecretAccessKey,
          },
        }
      : {}),
  });
  const send = (command) =>
    client.send(command, { abortSignal: AbortSignal.timeout(30000) });
  return (adapter = {
    put: (key, body, mime) =>
      send(
        new PutObjectCommand({
          Bucket: config.s3Bucket,
          Key: key,
          Body: body,
          ContentType: mime,
          CacheControl: "private, no-store",
        }),
      ),
    get: async (key) =>
      (await send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key })))
        .Body,
    delete: (key) =>
      send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key })),
    check: () => send(new HeadBucketCommand({ Bucket: config.s3Bucket })),
  });
}
