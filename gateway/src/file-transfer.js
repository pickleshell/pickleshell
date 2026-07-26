const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INBOX_DIR = '.inbox';
const DIRECTORY_FLAGS =
  fs.constants.O_RDONLY |
  fs.constants.O_DIRECTORY |
  fs.constants.O_NOFOLLOW;
const TEMP_FILE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  fs.constants.O_NOFOLLOW;

function safeResolve(base, rel) {
  const root = path.resolve(base);
  if (!rel || rel === '.') {
    return root;
  }
  const resolved = path.resolve(root, rel);
  if (!resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

function fdPath(fd, name = '') {
  return name ? `/proc/self/fd/${fd}/${name}` : `/proc/self/fd/${fd}`;
}

function openDirectory(parentFd, name) {
  const childPath = fdPath(parentFd, name);

  try {
    return fs.openSync(childPath, DIRECTORY_FLAGS);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  try {
    fs.mkdirSync(childPath, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  return fs.openSync(childPath, DIRECTORY_FLAGS);
}

function openDestinationDirectory(workspace, relativeDir) {
  const resolved = safeResolve(workspace, relativeDir);
  if (!resolved) {
    throw new Error(`dest_dir escapes workspace: ${relativeDir}`);
  }

  const rootFd = fs.openSync(workspace, DIRECTORY_FLAGS);
  const fds = [rootFd];
  const normalized = path.relative(path.resolve(workspace), resolved);
  const components = normalized ? normalized.split(path.sep) : [];

  try {
    let currentFd = rootFd;
    for (const component of components) {
      currentFd = openDirectory(currentFd, component);
      fds.push(currentFd);
    }
    return { fd: currentFd, fds, resolved };
  } catch (err) {
    for (const fd of fds.reverse()) fs.closeSync(fd);
    throw err;
  }
}

function validateFileName(name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name === '.' ||
    name === '..' ||
    path.basename(name) !== name ||
    name.includes('\0')
  ) {
    throw new Error(`Unsafe destination filename: ${name}`);
  }
}

function assertDestinationIsNotSymlink(destPath) {
  try {
    if (fs.lstatSync(destPath).isSymbolicLink()) {
      throw new Error('Destination file is a symbolic link');
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function copySourceToFd(sourcePath, destinationFd, name) {
  let sourceFd;
  try {
    sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Source file not found: ${name} (path=${sourcePath})`);
    }
    throw err;
  }

  try {
    const stat = fs.fstatSync(sourceFd);
    if (!stat.isFile()) {
      throw new Error(`Source is not a regular file: ${name}`);
    }

    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null)) > 0) {
      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(
          destinationFd,
          buffer,
          offset,
          bytesRead - offset,
          null
        );
      }
    }
    return stat;
  } finally {
    fs.closeSync(sourceFd);
  }
}

function writeFileSafely(directoryFd, name, sourcePath, overwrite) {
  const destinationPath = fdPath(directoryFd, name);
  const tempName = `.pickleshell-${process.pid}-${crypto.randomUUID()}.tmp`;
  const tempPath = fdPath(directoryFd, tempName);
  let tempFd;
  let tempExists = false;

  assertDestinationIsNotSymlink(destinationPath);

  try {
    tempFd = fs.openSync(tempPath, TEMP_FILE_FLAGS, 0o600);
    tempExists = true;
    const stat = copySourceToFd(sourcePath, tempFd, name);
    fs.fchmodSync(tempFd, 0o600);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;

    if (overwrite) {
      assertDestinationIsNotSymlink(destinationPath);
      fs.renameSync(tempPath, destinationPath);
      tempExists = false;
    } else {
      try {
        fs.linkSync(tempPath, destinationPath);
      } catch (err) {
        if (err.code === 'EEXIST') {
          throw new Error(
            `File already exists at destination: ${name}. ` +
            'Set overwrite: true to replace.'
          );
        }
        throw err;
      }
      fs.unlinkSync(tempPath);
      tempExists = false;
    }

    return stat;
  } finally {
    if (tempFd !== undefined) fs.closeSync(tempFd);
    if (tempExists) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup of our unpredictable temporary name.
      }
    }
  }
}

function copyFilesToWorkspace(filePaths, workspace, destinationDir, requestId) {
  const summary = [];

  for (const file of filePaths) {
    validateFileName(file.name);
    const name = file.name;
    const destSubdir = file.dest_dir || (destinationDir != null ? destinationDir : null);
    const overwrite = file.overwrite === true;
    const relativeDir =
      destSubdir != null ? destSubdir : path.join(INBOX_DIR, requestId);
    const destination = openDestinationDirectory(workspace, relativeDir);

    try {
      const dest = path.join(destination.resolved, name);
      console.log(`[FILE] Copying: name=${name} src=${file.path}`);
      const stat = writeFileSafely(
        destination.fd,
        name,
        file.path,
        overwrite
      );

      summary.push({
        name,
        path: dest,
        mime_type: file.mime_type || 'application/octet-stream',
        size: stat.size,
      });

      console.log(
        `[FILE] Copied ${name} (${stat.size} bytes) to ${destination.resolved}`
      );
    } finally {
      for (const fd of destination.fds.reverse()) fs.closeSync(fd);
    }
  }

  return summary;
}

function cleanupInbox(inboxDir) {
  try {
    fs.rmSync(inboxDir, { recursive: true, force: true });
    console.log(`[FILE] Cleaned up inbox: ${inboxDir}`);
  } catch {
    // best effort
  }
}

function buildFileSummaryPrompt(fileSummary) {
  if (!fileSummary || fileSummary.length === 0) return '';

  const lines = ['\n\nThe following files were delivered to the workspace:'];
  for (const f of fileSummary) {
    lines.push(`- ${f.path} (${f.mime_type}, ${f.size} bytes)`);
  }
  return lines.join('\n');
}

module.exports = {
  safeResolve,
  copyFilesToWorkspace,
  cleanupInbox,
  buildFileSummaryPrompt,
};
