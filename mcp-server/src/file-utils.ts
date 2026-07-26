import { mkdir, rm, open } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import type { FileItem } from "./types.js";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const DANGEROUS_NAME = /^\.+$/;
const ABSOLUTE_PATH = /^(\/|~|[A-Z]:\\\\?)/i;
const PATH_TRAVERSAL = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const NUL_BYTE = /\0/;

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

function validateRelativePath(value: string, label: string): void {
  if (!value || value === '.') return;

  if (ABSOLUTE_PATH.test(value)) {
    throw new FileValidationError(
      `${label} must not be an absolute path: ${value}`
    );
  }

  if (PATH_TRAVERSAL.test(value)) {
    throw new FileValidationError(
      `${label} must not contain path traversal: ${value}`
    );
  }

  if (NUL_BYTE.test(value)) {
    throw new FileValidationError(
      `${label} contains NUL byte`
    );
  }

  if (DANGEROUS_NAME.test(value)) {
    throw new FileValidationError(
      `${label} must not be only dots: ${value}`
    );
  }
}

export function validateFiles(files: FileItem[] | undefined): void {
  if (!files || files.length === 0) return;

  if (files.length > MAX_FILES) {
    throw new FileValidationError(
      `Too many files: ${files.length} exceeds maximum of ${MAX_FILES}`
    );
  }

  const names = new Set<string>();

  for (const file of files) {
    if (!file.name || typeof file.name !== "string") {
      throw new FileValidationError("Each file must have a non-empty name");
    }

    if (file.name.length > 256) {
      throw new FileValidationError(
        `File name too long: ${file.name.length} chars (max 256)`
      );
    }

    if (NUL_BYTE.test(file.name)) {
      throw new FileValidationError(
        `File name contains NUL byte: ${file.name}`
      );
    }

    if (ABSOLUTE_PATH.test(file.name)) {
      throw new FileValidationError(
        `File name must not be an absolute path: ${file.name}`
      );
    }

    if (PATH_TRAVERSAL.test(file.name)) {
      throw new FileValidationError(
        `File name must not contain path traversal: ${file.name}`
      );
    }

    if (DANGEROUS_NAME.test(file.name)) {
      throw new FileValidationError(
        `File name must not be only dots: ${file.name}`
      );
    }

    if (names.has(file.name)) {
      throw new FileValidationError(`Duplicate file name: ${file.name}`);
    }
    names.add(file.name);

    validateRelativePath(file.dest_dir || "", `dest_dir for ${file.name}`);

    if (!file.content || typeof file.content !== "string") {
      throw new FileValidationError(
        `File ${file.name} must have non-empty base64 content`
      );
    }

    const decoded = Buffer.from(file.content, "base64");
    if (
      decoded.toString("base64") !== file.content.replace(/\s/g, "")
    ) {
      throw new FileValidationError(
        `File ${file.name} contains malformed base64`
      );
    }

    if (decoded.length === 0) {
      throw new FileValidationError(
        `File ${file.name} decoded content is empty`
      );
    }

    if (decoded.length > MAX_FILE_BYTES) {
      throw new FileValidationError(
        `File ${file.name} is ${decoded.length} bytes, exceeds ${MAX_FILE_BYTES} byte limit`
      );
    }
  }

  const totalDecoded = files.reduce(
    (sum, f) => sum + Buffer.from(f.content, "base64").length,
    0
  );
  if (totalDecoded > MAX_TOTAL_BYTES) {
    throw new FileValidationError(
      `Total decoded size ${totalDecoded} bytes exceeds ${MAX_TOTAL_BYTES} byte limit`
    );
  }
}

export function validateDestinationDir(dir: string | undefined): void {
  if (!dir) return;
  validateRelativePath(dir, "destination_dir");
}

export async function decodeFilesToTemp(
  files: FileItem[]
): Promise<string> {
  const baseDir = process.env.MCP_TEMP_DIR || join(process.env.HOME || "/tmp", ".mcp-temp");
  const dir = join(baseDir, `mcp-files-${randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  for (const file of files) {
    const decoded = Buffer.from(file.content, "base64");
    const fd = await open(join(dir, file.name), "wx", 0o600);
    await fd.writeFile(decoded);
    await fd.close();
  }

  return dir;
}

export async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
