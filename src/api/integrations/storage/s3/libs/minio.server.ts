import { ConfigService, S3 } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import * as MinIo from 'minio';
import { join } from 'path';
import { Readable, Transform } from 'stream';

const logger = new Logger('S3 Service');

const BUCKET = new ConfigService().get<S3>('S3');

// Uploads can legitimately take a while for large media, but they should never
// hang forever. Cap per-operation time so a flaky S3 endpoint cannot block the
// caller indefinitely. Overridable via S3_TIMEOUT_MS.
const S3_TIMEOUT_MS = Number(process.env.S3_TIMEOUT_MS ?? 60_000);

function withTimeout<T>(op: Promise<T>, label: string, ms = S3_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`S3 ${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([op, timeout]).finally(() => clearTimeout(timer));
}

interface Metadata extends MinIo.ItemBucketMetadata {
  'Content-Type': string;
}

const minioClient = (() => {
  if (BUCKET?.ENABLE) {
    return new MinIo.Client({
      endPoint: BUCKET.ENDPOINT,
      port: BUCKET.PORT,
      useSSL: BUCKET.USE_SSL,
      accessKey: BUCKET.ACCESS_KEY,
      secretKey: BUCKET.SECRET_KEY,
      region: BUCKET.REGION,
    });
  }
})();

const bucketName = BUCKET.BUCKET_NAME;

const bucketExists = async () => {
  if (minioClient) {
    try {
      const list = await minioClient.listBuckets();
      return list.find((bucket) => bucket.name === bucketName);
    } catch {
      return false;
    }
  }
};

const setBucketPolicy = async () => {
  if (minioClient) {
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucketName}/*`],
        },
      ],
    };
    await minioClient.setBucketPolicy(bucketName, JSON.stringify(policy));
  }
};

const createBucket = async () => {
  if (minioClient) {
    try {
      const exists = await bucketExists();
      if (!exists) {
        await minioClient.makeBucket(bucketName);
      }
      if (!BUCKET.SKIP_POLICY) {
        await setBucketPolicy();
      }
      logger.info(`S3 Bucket ${bucketName} - ON`);
      return true;
    } catch (error) {
      logger.error('S3 ERROR:');
      logger.error(error);
      return false;
    }
  }
};

createBucket();

const uploadFile = async (fileName: string, file: Buffer | Transform | Readable, size: number, metadata: Metadata) => {
  if (minioClient) {
    const objectName = join('evolution-api', fileName);
    try {
      metadata['custom-header-application'] = 'evolution-api';
      return await withTimeout(
        minioClient.putObject(bucketName, objectName, file, size, metadata),
        `putObject ${objectName}`,
      );
    } catch (error) {
      logger.error(error);
      return error;
    }
  }
};

const getObjectUrl = async (fileName: string, expiry?: number) => {
  if (minioClient) {
    try {
      const objectName = join('evolution-api', fileName);
      const op = expiry
        ? minioClient.presignedGetObject(bucketName, objectName, expiry)
        : minioClient.presignedGetObject(bucketName, objectName);
      return await withTimeout(op, `presignedGetObject ${objectName}`);
    } catch (error) {
      throw new BadRequestException(error?.message);
    }
  }
};

const uploadTempFile = async (
  folder: string,
  fileName: string,
  file: Buffer | Transform | Readable,
  size: number,
  metadata: Metadata,
) => {
  if (minioClient) {
    const objectName = join(folder, fileName);
    try {
      metadata['custom-header-application'] = 'evolution-api';
      return await withTimeout(
        minioClient.putObject(bucketName, objectName, file, size, metadata),
        `putObject ${objectName}`,
      );
    } catch (error) {
      logger.error(error);
      return error;
    }
  }
};

const deleteFile = async (folder: string, fileName: string) => {
  if (minioClient) {
    const objectName = join(folder, fileName);
    try {
      return await withTimeout(minioClient.removeObject(bucketName, objectName), `removeObject ${objectName}`);
    } catch (error) {
      logger.error(error);
      return error;
    }
  }
};

export { BUCKET, deleteFile, getObjectUrl, uploadFile, uploadTempFile };
