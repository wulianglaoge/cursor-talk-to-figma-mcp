import { randomUUID } from "crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { Client } from "minio";
import { z } from "zod";

const UPLOAD_TIMEOUT_MS = 60000;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

const projectRootSchema = z.string().refine(path.isAbsolute, "projectRoot must be an absolute path");

export const minioConfigFields = {
  endPoint: z.string().trim().min(1).max(255).refine(
    (value) => !value.includes("://") && !/[/?#\s]/.test(value),
    "endPoint must be a hostname or IP address without protocol or path"
  ),
  port: z.number().int().min(1).max(65535),
  useSSL: z.boolean(),
  accessKey: z.string().min(1).max(512),
  secretKey: z.string().min(1).max(1024),
  bucket: z.string().regex(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    "bucket must be a valid MinIO bucket name"
  ),
  prefix: z.string().max(1024).refine(
    (value) => !/[\u0000-\u001f\\]/.test(value) && !value.split("/").includes(".."),
    "prefix contains an invalid path"
  ),
  publicBaseUrl: z.string().max(2048).refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "publicBaseUrl must be an HTTP(S) URL without credentials"),
};

const minioConfigSchema = z.object({
  ...minioConfigFields,
  port: minioConfigFields.port.default(9000),
  useSSL: minioConfigFields.useSSL.default(false),
  prefix: minioConfigFields.prefix.default(""),
  publicBaseUrl: minioConfigFields.publicBaseUrl.default(""),
});

const setMinioConfigSchema = z.object({
  projectRoot: projectRootSchema,
  ...z.object(minioConfigFields).partial().shape,
});

type MinioConfig = z.infer<typeof minioConfigSchema>;

export interface MinioUploadContext {
  config: MinioConfig;
  client: Client;
}

interface UploadImageOptions {
  projectRoot: string;
  imageData: string | Buffer;
  mimeType?: string;
  format?: string;
  filename?: string;
  scale?: number;
  context?: MinioUploadContext;
}

interface LocalUploadImageOptions {
  projectRoot: string;
  path: string;
  filename?: string;
  context?: MinioUploadContext;
}

async function runWithTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), UPLOAD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout!);
  }
}

function minioOperationError(error: any, operation: string): Error {
  const code = error?.code || error?.name;
  if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(code)) {
    return new Error("MinIO authentication failed; check accessKey and secretKey");
  }
  return new Error(`MinIO ${operation} failed${code ? ` (${code})` : ""}: ${error?.message || "Unknown error"}`);
}

function configPath(projectRoot: string): string {
  return path.join(projectRoot, "minio.json");
}

async function assertProjectRoot(projectRoot: string): Promise<void> {
  projectRootSchema.parse(projectRoot);
  let projectStat;
  try {
    projectStat = await stat(projectRoot);
  } catch {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }
  if (!projectStat.isDirectory()) {
    throw new Error(`projectRoot is not a directory: ${projectRoot}`);
  }
}

async function readConfig(projectRoot: string): Promise<MinioConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(projectRoot), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Unable to read MinIO config: ${error.message}`);
  }
  try {
    return minioConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid MinIO config: ${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
    throw new Error("Invalid MinIO config: minio.json is not valid JSON");
  }
}

export async function createMinioUploadContext(projectRoot: string): Promise<MinioUploadContext> {
  await assertProjectRoot(projectRoot);
  const config = await readConfig(projectRoot);
  if (!config) {
    throw new Error(`MinIO is not configured for ${projectRoot}. Call set_minio_config first.`);
  }
  const client = new Client({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
  try {
    const bucketExists = await runWithTimeout(
      client.bucketExists(config.bucket),
      "MinIO preflight timed out after 60s"
    );
    if (!bucketExists) {
      throw new Error(`Bucket does not exist or is not accessible: ${config.bucket}`);
    }
  } catch (error) {
    throw minioOperationError(error, "preflight");
  }
  return { config, client };
}

async function ensureGitignore(projectRoot: string): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (content.split(/\r?\n/).some((line) => line.trim() === "minio.json")) return false;
  const separator = content && !content.endsWith("\n") && !content.endsWith("\r") ? "\n" : "";
  await writeFile(gitignorePath, `${content}${separator}minio.json\n`, "utf8");
  return true;
}

export async function setMinioConfig(input: unknown) {
  const { projectRoot, ...updates } = setMinioConfigSchema.parse(input);
  await assertProjectRoot(projectRoot);
  const existing = await readConfig(projectRoot);
  const config = minioConfigSchema.parse({ ...(existing || {}), ...updates });
  const destination = configPath(projectRoot);
  const temporary = path.join(projectRoot, `.minio.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const gitignoreUpdated = await ensureGitignore(projectRoot);
  return {
    success: true,
    configPath: destination,
    gitignoreUpdated,
    config: {
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSSL,
      bucket: config.bucket,
      prefix: config.prefix,
      publicBaseUrl: config.publicBaseUrl,
      credentialsConfigured: true,
    },
  };
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+/, "");
  return normalized && !normalized.endsWith("/") ? `${normalized}/` : normalized;
}

function buildObjectName(prefix: string, filename: string | undefined, extension: string): string {
  const basename = path.basename((filename || "figma-export").replace(/\\/g, "/"));
  const currentExtension = path.extname(basename);
  const stem = (currentExtension ? basename.slice(0, -currentExtension.length) : basename)
    .replace(/[\u0000-\u001f]/g, "_")
    .trim()
    .slice(0, 120) || "figma-export";
  return `${normalizePrefix(prefix)}${stem}-${Date.now()}-${randomUUID()}.${extension}`;
}

function buildPublicUrl(config: MinioConfig, objectName: string): string {
  const encodedObjectName = objectName.split("/").map(encodeURIComponent).join("/");
  if (config.publicBaseUrl) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/${encodedObjectName}`;
  }
  const protocol = config.useSSL ? "https" : "http";
  const portPart = (config.useSSL && config.port === 443) || (!config.useSSL && config.port === 80)
    ? ""
    : `:${config.port}`;
  return `${protocol}://${config.endPoint}${portPart}/${config.bucket}/${encodedObjectName}`;
}

const imageMimeTypes: Record<string, string> = {
  PNG: "image/png",
  JPG: "image/jpeg",
  GIF: "image/gif",
  WEBP: "image/webp",
  SVG: "image/svg+xml",
  PDF: "application/pdf",
};

function validateImage(imageData: string | Buffer, format: string, mimeType?: string): Buffer {
  const expectedMimeType = imageMimeTypes[format];
  if (!expectedMimeType) throw new Error(`Unsupported image format: ${format}`);
  if (mimeType && mimeType !== expectedMimeType) {
    throw new Error(`Image MIME type ${mimeType} does not match format ${format}`);
  }
  const buffer = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData, "base64");
  if (!buffer.length) throw new Error("Image is empty");
  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB upload limit`);
  }
  return buffer;
}

function detectLocalImage(buffer: Buffer): { format: string; mimeType: string } {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: "PNG", mimeType: imageMimeTypes.PNG };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { format: "JPG", mimeType: imageMimeTypes.JPG };
  }
  const header = buffer.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
    return { format: "GIF", mimeType: imageMimeTypes.GIF };
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return { format: "WEBP", mimeType: imageMimeTypes.WEBP };
  }
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { format: "PDF", mimeType: imageMimeTypes.PDF };
  }
  const text = buffer.subarray(0, 4096).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text)) {
    return { format: "SVG", mimeType: imageMimeTypes.SVG };
  }
  throw new Error("Unsupported local image; expected PNG, JPG, GIF, WEBP, SVG, or PDF content");
}

async function readLocalImage(filePath: string): Promise<{ buffer: Buffer; format: string; mimeType: string }> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`Local image does not exist: ${filePath}`);
    throw new Error(`Unable to access local image: ${error?.message || "Unknown error"}`);
  }
  if (!fileStat.isFile()) throw new Error(`Local image path is not a file: ${filePath}`);
  if (fileStat.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(`Local image exceeds the ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB upload limit: ${filePath}`);
  }
  const buffer = await readFile(filePath);
  if (!buffer.length) throw new Error(`Local image is empty: ${filePath}`);
  return { buffer, ...detectLocalImage(buffer) };
}

export async function uploadLocalImageToMinio(options: LocalUploadImageOptions) {
  await assertProjectRoot(options.projectRoot);
  const localPath = path.isAbsolute(options.path)
    ? path.normalize(options.path)
    : path.resolve(options.projectRoot, options.path);
  const { buffer, format, mimeType } = await readLocalImage(localPath);
  const result = await uploadImageToMinio({
    projectRoot: options.projectRoot,
    imageData: buffer,
    mimeType,
    format,
    filename: options.filename || path.basename(localPath),
    context: options.context,
  });
  return { ...result, localPath };
}

export async function uploadImageToMinio(options: UploadImageOptions) {
  await assertProjectRoot(options.projectRoot);
  const { config, client } = options.context || await createMinioUploadContext(options.projectRoot);
  const format = (options.format || "PNG").toUpperCase();
  const buffer = validateImage(options.imageData, format, options.mimeType);
  const extension = format === "JPG" ? "jpg" : format.toLowerCase();
  const objectName = buildObjectName(config.prefix, options.filename, extension);
  const mimeType = options.mimeType || imageMimeTypes[format];
  try {
    await runWithTimeout(
      client.putObject(config.bucket, objectName, buffer, buffer.length, { "Content-Type": mimeType }),
      "MinIO upload timed out after 60s"
    );
  } catch (error) {
    throw minioOperationError(error, "upload");
  }
  return {
    imageUrl: buildPublicUrl(config, objectName),
    bucket: config.bucket,
    objectName,
    mimeType,
    format,
    scale: options.scale ?? 1,
    size: buffer.length,
  };
}
