import { validateFiles, validateDestinationDir, decodeFilesToTemp, cleanupTempDir, FileValidationError } from "./src/file-utils.js";
import { readdir, readFile, stat } from "fs/promises";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`   PASS: ${msg}`);
    passed++;
  } else {
    console.log(`   FAIL: ${msg}`);
    failed++;
  }
}

function shouldThrow(fn: () => void, msg: string): boolean {
  try {
    fn();
    console.log(`   FAIL: ${msg} (no error thrown)`);
    failed++;
    return false;
  } catch (e) {
    if (e instanceof FileValidationError) {
      console.log(`   PASS: ${msg}`);
      passed++;
      return true;
    }
    console.log(`   FAIL: ${msg} (wrong error type: ${e.constructor.name})`);
    failed++;
    return false;
  }
}

async function runTests() {
  console.log("Running MCP wrapper file-utils unit tests...\n");

  // Test 1: undefined files - ok
  console.log("1. validateFiles(undefined)");
  validateFiles(undefined);
  console.log("   PASS: no error");
  passed++;

  // Test 2: empty array - ok
  console.log("\n2. validateFiles([])");
  validateFiles([]);
  console.log("   PASS: no error");
  passed++;

  // Test 3: too many files (21)
  console.log("\n3. Too many files (21)");
  const twentyOneFiles = Array.from({ length: 21 }, (_, i) => ({
    name: `file${i}.txt`,
    content: Buffer.from("test").toString("base64"),
  }));
  shouldThrow(() => validateFiles(twentyOneFiles), "rejects 21 files");

  // Test 4: empty name
  console.log("\n4. Empty file name");
  shouldThrow(
    () => validateFiles([{ name: "", content: Buffer.from("x").toString("base64") }]),
    "rejects empty name"
  );

  // Test 5: absolute path
  console.log("\n5. Absolute path name");
  shouldThrow(
    () => validateFiles([{ name: "/etc/passwd", content: Buffer.from("x").toString("base64") }]),
    "rejects absolute path"
  );

  // Test 6: path traversal
  console.log("\n6. Path traversal name");
  shouldThrow(
    () => validateFiles([{ name: "../secret", content: Buffer.from("x").toString("base64") }]),
    "rejects path traversal"
  );

  // Test 7: only dots
  console.log("\n7. Only-dots name");
  shouldThrow(
    () => validateFiles([{ name: "..", content: Buffer.from("x").toString("base64") }]),
    "rejects only-dots"
  );

  // Test 8: NUL byte
  console.log("\n8. NUL byte in name");
  shouldThrow(
    () => validateFiles([{ name: "file\0.txt", content: Buffer.from("x").toString("base64") }]),
    "rejects NUL byte"
  );

  // Test 9: duplicate names
  console.log("\n9. Duplicate names");
  shouldThrow(
    () => validateFiles([
      { name: "a.txt", content: Buffer.from("x").toString("base64") },
      { name: "a.txt", content: Buffer.from("y").toString("base64") },
    ]),
    "rejects duplicates"
  );

  // Test 10: malformed base64
  console.log("\n10. Malformed base64");
  shouldThrow(
    () => validateFiles([{ name: "bad.txt", content: "not-valid-base64!!!" }]),
    "rejects malformed base64"
  );

  // Test 11: oversized file (single file > 2MiB)
  console.log("\n11. Oversized file (>2MiB)");
  const bigContent = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41).toString("base64");
  shouldThrow(
    () => validateFiles([{ name: "big.bin", content: bigContent }]),
    "rejects >2MiB file"
  );

  // Test 12: valid single file
  console.log("\n12. Valid single file");
  const validContent = Buffer.from("hello world").toString("base64");
  validateFiles([{ name: "test.txt", content: validContent }]);
  console.log("   PASS: no error");
  passed++;

  // Test 13: valid 20 files under limits
  console.log("\n13. Valid 20 files under limits");
  const twentyValid = Array.from({ length: 20 }, (_, i) => ({
    name: `file${i}.txt`,
    content: Buffer.from(`content ${i}`).toString("base64"),
  }));
  validateFiles(twentyValid);
  console.log("   PASS: no error");
  passed++;

  // Test 14: decodeFilesToTemp writes correct files
  console.log("\n14. decodeFilesToTemp");
  const tmpDir = await decodeFilesToTemp([
    { name: "a.txt", content: Buffer.from("alpha").toString("base64") },
    { name: "b.txt", content: Buffer.from("beta").toString("base64"), mime_type: "text/plain" },
  ]);
  const files = await readdir(tmpDir);
  assert(files.includes("a.txt"), "a.txt exists");
  assert(files.includes("b.txt"), "b.txt exists");
  const contentA = await readFile(`${tmpDir}/a.txt`, "utf8");
  assert(contentA === "alpha", "a.txt content correct");
  const contentB = await readFile(`${tmpDir}/b.txt`, "utf8");
  assert(contentB === "beta", "b.txt content correct");
  const aStat = await stat(`${tmpDir}/a.txt`);
  assert((aStat.mode & 0o777) === 0o600, "file mode is 0600");

  // Test 15: cleanupTempDir
  console.log("\n15. cleanupTempDir");
  await cleanupTempDir(tmpDir);
  let exists = true;
  try { await readdir(tmpDir); } catch { exists = false; }
  assert(!exists, "temp dir removed");

  // Test 16: validateDestinationDir - undefined (ok)
  console.log("\n16. validateDestinationDir(undefined)");
  validateDestinationDir(undefined);
  console.log("   PASS: no error");
  passed++;

  // Test 17: validateDestinationDir - empty string (workspace root)
  console.log("\n17. validateDestinationDir - empty string (root)");
  validateDestinationDir("");
  console.log("   PASS: no error");
  passed++;

  // Test 18: validateDestinationDir - dot (workspace root)
  console.log("\n18. validateDestinationDir - dot (root)");
  validateDestinationDir(".");
  console.log("   PASS: no error");
  passed++;

  // Test 19: validateDestinationDir - valid relative
  console.log("\n19. validateDestinationDir - valid relative");
  validateDestinationDir("docs/images/pickleshell");
  console.log("   PASS: no error");
  passed++;

  // Test 20: validateDestinationDir - absolute path rejected
  console.log("\n20. validateDestinationDir - absolute path");
  shouldThrow(
    () => validateDestinationDir("/etc/passwd"),
    "rejects absolute path"
  );

  // Test 21: validateDestinationDir - path traversal rejected
  console.log("\n21. validateDestinationDir - path traversal");
  shouldThrow(
    () => validateDestinationDir("../../secrets"),
    "rejects path traversal"
  );

  // Test 22: validateDestinationDir - NUL byte rejected
  console.log("\n22. validateDestinationDir - NUL byte");
  shouldThrow(
    () => validateDestinationDir("docs\0/evil"),
    "rejects NUL byte"
  );

  // Test 23: validateDestinationDir - ".." rejected
  console.log("\n23. validateDestinationDir - double dot");
  shouldThrow(
    () => validateDestinationDir(".."),
    "rejects double dot"
  );

  // Test 24: validateFiles with per-file dest_dir
  console.log("\n24. validateFiles with per-file dest_dir");
  validateFiles([
    { name: "a.txt", content: Buffer.from("x").toString("base64"), dest_dir: "docs/images" },
  ]);
  console.log("   PASS: no error");
  passed++;

  // Test 25: validateFiles - per-file dest_dir traversal rejected
  console.log("\n25. validateFiles - per-file dest_dir traversal rejected");
  shouldThrow(
    () => validateFiles([
      { name: "a.txt", content: Buffer.from("x").toString("base64"), dest_dir: "../../etc" },
    ]),
    "rejects per-file dest_dir traversal"
  );

  // Regression: O_EXCL — decodeFilesToTemp uses exclusive creation
  console.log("\n26. O_EXCL regression — decodeFilesToTemp uses exclusive open");
  let exclCode = "";
  let openFlags = "";
  const exclMock = async (p: string, f: string, _m?: number) => {
    openFlags += f;
    const err: any = new Error("EEXIST: file already exists");
    err.code = "EEXIST";
    throw err;
  };
  let dir26 = "";
  try {
    dir26 = await decodeFilesToTemp(
      [{ name: "a.txt", content: Buffer.from("x").toString("base64") }],
      exclMock
    );
  } catch (e: any) {
    exclCode = e.code;
  }
  // Verify dir was cleaned up after error
  const { access } = await import("fs/promises");
  let dir26Gone = true;
  if (dir26) {
    try {
      await access(dir26);
      dir26Gone = false;
    } catch { /* gone */ }
  }
  const flagsCorrect = openFlags.includes("wx");
  if (exclCode === "EEXIST" && dir26Gone && flagsCorrect) {
    console.log("   PASS: EEXIST propagated, dir cleaned, open used 'wx' flag");
    passed++;
  } else {
    console.log(`   FAIL: code=${exclCode}, dirGone=${dir26Gone}, flags=${openFlags}`);
    failed++;
  }

  // Regression: randomUUID — temp dir names are valid UUIDs
  console.log("\n27. randomUUID regression — temp dir name is UUID format");
  const dir27 = await decodeFilesToTemp([
    { name: "u.txt", content: Buffer.from("u").toString("base64") },
  ]);
  const uuidPattern = /^mcp-files-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const dirName = dir27.split("/").pop() || "";
  if (uuidPattern.test(dirName)) {
    console.log("   PASS: temp dir name matches UUIDv4 format");
    passed++;
  } else {
    console.log(`   FAIL: temp dir name '${dirName}' is not UUIDv4`);
    failed++;
  }
  await cleanupTempDir(dir27);

  // Regression: fd-close + dir cleanup — writeFile error triggers close and rm
  console.log("\n28. fd-close + cleanup regression — close called, dir removed");
  let closeCalled = false;
  let writeErrDir = "";
  const mockOpenFn = async (_p: string, _f: string, _m?: number) => ({
    writeFile: async () => { throw new Error("simulated write failure"); },
    close: async () => { closeCalled = true; },
  });
  let writeErrorCaught = false;
  try {
    writeErrDir = await decodeFilesToTemp(
      [{ name: "fail.txt", content: Buffer.from("x").toString("base64") }],
      mockOpenFn
    );
  } catch (e: any) {
    writeErrorCaught = e.message === "simulated write failure";
  }
  let writeErrDirGone = true;
  if (writeErrDir) {
    try {
      await access(writeErrDir);
      writeErrDirGone = false;
    } catch { /* gone */ }
  }
  if (writeErrorCaught && closeCalled && writeErrDirGone) {
    console.log("   PASS: close() called, dir removed after writeFile error");
    passed++;
  } else {
    console.log(`   FAIL: caught=${writeErrorCaught}, close=${closeCalled}, dirGone=${writeErrDirGone}`);
    failed++;
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
