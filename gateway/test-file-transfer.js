const fs = require('fs');
const path = require('path');
const fileTransfer = require('./src/file-transfer');

const WORKSPACE = '/tmp/test-workspace-' + Date.now();

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`   PASS: ${msg}`);
    passed++;
  } else {
    console.log(`   FAIL: ${msg}`);
    failed++;
  }
}

function shouldThrow(fn, msg) {
  try {
    fn();
    console.log(`   FAIL: ${msg} (no error thrown)`);
    failed++;
  } catch (e) {
    console.log(`   PASS: ${msg}`);
    passed++;
  }
}

function runTests() {
  console.log('Running file-transfer unit tests...\n');

  // Setup
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE, 'docs', 'images'), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'existing.txt'), 'existing');

  const srcFile = path.join(WORKSPACE, '_src', 'source.txt');
  fs.mkdirSync(path.join(WORKSPACE, '_src'), { recursive: true });
  fs.writeFileSync(srcFile, 'hello world');

  // Test 1: safeResolve - relative path
  console.log('1. safeResolve - relative path');
  const resolved = fileTransfer.safeResolve(WORKSPACE, 'docs/images');
  assert(resolved === path.join(WORKSPACE, 'docs', 'images'), 'resolves relative path');

  // Test 1b: safeResolve - empty string (workspace root)
  console.log('\n1b. safeResolve - empty string (root)');
  const rootEmpty = fileTransfer.safeResolve(WORKSPACE, '');
  assert(rootEmpty === WORKSPACE, 'empty string resolves to workspace root');

  // Test 1c: safeResolve - "." (workspace root)
  console.log('\n1c. safeResolve - dot (root)');
  const rootDot = fileTransfer.safeResolve(WORKSPACE, '.');
  assert(rootDot === WORKSPACE, 'dot resolves to workspace root');

  // Test 2: safeResolve - path traversal rejected
  console.log('\n2. safeResolve - path traversal');
  const escaped = fileTransfer.safeResolve(WORKSPACE, '../etc/passwd');
  assert(escaped === null, 'rejects path traversal');

  // Test 3: safeResolve - absolute path rejected
  console.log('\n3. safeResolve - absolute path');
  const absolute = fileTransfer.safeResolve(WORKSPACE, '/etc/passwd');
  assert(absolute === null, 'rejects absolute path');

  // Test 4: safeResolve - ".." rejected
  console.log('\n4. safeResolve - double dot');
  const doubleDot = fileTransfer.safeResolve(WORKSPACE, '..');
  assert(doubleDot === null, 'rejects double dot');

  // Test 5: copyFilesToWorkspace - no destination (fallback to .inbox)
  console.log('\n5. copyFilesToWorkspace - fallback to .inbox');
  const requestId = `test-${Date.now()}`;
  const summary5 = fileTransfer.copyFilesToWorkspace(
    [{ name: 'source.txt', path: srcFile, mime_type: 'text/plain' }],
    WORKSPACE, null, requestId
  );
  assert(summary5.length === 1, 'one file copied');
  assert(summary5[0].name === 'source.txt', 'correct filename');
  assert(summary5[0].size === 11, 'correct size');
  assert(summary5[0].path.includes('.inbox'), 'dest is in .inbox');
  const content5 = fs.readFileSync(summary5[0].path, 'utf8');
  assert(content5 === 'hello world', 'content matches');

  // Test 6: copyFilesToWorkspace - with destination_dir
  console.log('\n6. copyFilesToWorkspace - destination_dir');
  const summary6 = fileTransfer.copyFilesToWorkspace(
    [{ name: 'source.txt', path: srcFile, mime_type: 'text/plain' }],
    WORKSPACE, 'docs/images', requestId
  );
  assert(summary6.length === 1, 'one file copied');
  const expectedDest = path.join(WORKSPACE, 'docs', 'images', 'source.txt');
  assert(summary6[0].path === expectedDest, 'dest is in docs/images');
  const content6 = fs.readFileSync(summary6[0].path, 'utf8');
  assert(content6 === 'hello world', 'content matches');

  // Test 7: copyFilesToWorkspace - per-file dest_dir override
  console.log('\n7. copyFilesToWorkspace - per-file dest_dir override');
  const summary7 = fileTransfer.copyFilesToWorkspace(
    [{ name: 'source.txt', path: srcFile, dest_dir: 'docs' }],
    WORKSPACE, 'docs/images', requestId
  );
  assert(summary7.length === 1, 'one file copied');
  const expectedDest7 = path.join(WORKSPACE, 'docs', 'source.txt');
  assert(summary7[0].path === expectedDest7, 'per-file dest_dir overrides request-level');

  // Test 8: copyFilesToWorkspace - dest_dir escapes workspace
  console.log('\n8. copyFilesToWorkspace - dest_dir escapes workspace');
  shouldThrow(
    () => fileTransfer.copyFilesToWorkspace(
      [{ name: 'bad.txt', path: srcFile, dest_dir: '../../etc' }],
      WORKSPACE, null, requestId
    ),
    'rejects dest_dir escaping workspace'
  );

  // Test 9: copyFilesToWorkspace - overwrite protection
  console.log('\n9. copyFilesToWorkspace - overwrite protection');
  fs.writeFileSync(path.join(WORKSPACE, 'docs', 'existing.txt'), 'original');
  shouldThrow(
    () => fileTransfer.copyFilesToWorkspace(
      [{ name: 'existing.txt', path: srcFile }],
      WORKSPACE, 'docs', requestId
    ),
    'rejects overwrite without flag'
  );

  // Test 10: copyFilesToWorkspace - overwrite allowed
  console.log('\n10. copyFilesToWorkspace - overwrite allowed');
  const summary10 = fileTransfer.copyFilesToWorkspace(
    [{ name: 'existing.txt', path: srcFile, overwrite: true }],
    WORKSPACE, 'docs', requestId
  );
  assert(summary10.length === 1, 'one file copied');
  const content10 = fs.readFileSync(summary10[0].path, 'utf8');
  assert(content10 === 'hello world', 'file overwritten');

  // Test 11: copyFilesToWorkspace - root destination (empty string)
  console.log('\n11. copyFilesToWorkspace - root destination (empty string)');
  const srcFile2 = path.join(WORKSPACE, '_src', 'source-root.txt');
  fs.writeFileSync(srcFile2, 'root test');
  const summary11 = fileTransfer.copyFilesToWorkspace(
    [{ name: 'source-root.txt', path: srcFile2 }],
    WORKSPACE, '', requestId
  );
  assert(summary11.length === 1, 'one file copied');
  const expectedRoot = path.join(WORKSPACE, 'source-root.txt');
  assert(summary11[0].path === expectedRoot, 'file placed at workspace root');

  // Test 12: copyFilesToWorkspace - root destination (dot)
  console.log('\n12. copyFilesToWorkspace - root destination (dot)');
  const srcFile3 = path.join(WORKSPACE, '_src', 'source-dot.txt');
  fs.writeFileSync(srcFile3, 'dot test');
  const summary12 = fileTransfer.copyFilesToWorkspace(
    [{ name: 'source-dot.txt', path: srcFile3 }],
    WORKSPACE, '.', requestId
  );
  assert(summary12.length === 1, 'one file copied');
  const expectedRootDot = path.join(WORKSPACE, 'source-dot.txt');
  assert(summary12[0].path === expectedRootDot, 'file placed at workspace root via dot');

  // Test 13: copyFilesToWorkspace - non-existent source
  console.log('\n13. copyFilesToWorkspace - non-existent source');
  shouldThrow(
    () => fileTransfer.copyFilesToWorkspace(
      [{ name: 'missing.txt', path: '/tmp/nonexistent.txt' }],
      WORKSPACE, null, requestId
    ),
    'rejects non-existent source'
  );

  // Test 14: buildFileSummaryPrompt
  console.log('\n14. buildFileSummaryPrompt');
  const prompt = fileTransfer.buildFileSummaryPrompt(summary6);
  assert(prompt.includes('source.txt'), 'prompt includes filename');
  assert(prompt.includes('text/plain'), 'prompt includes mime type');
  assert(prompt.includes('11 bytes'), 'prompt includes size');
  const emptyPrompt = fileTransfer.buildFileSummaryPrompt(null);
  assert(emptyPrompt === '', 'null summary returns empty string');
  const emptyArray = fileTransfer.buildFileSummaryPrompt([]);
  assert(emptyArray === '', 'empty array returns empty string');

  // Test 15: file mode 0600
  console.log('\n15. File permissions');
  const fileStat = fs.statSync(summary6[0].path);
  assert((fileStat.mode & 0o777) === 0o600, 'file has mode 0600');

  // Test 16: dir mode 0700 (check a freshly created dir, not pre-existing)
  console.log('\n16. Directory permissions');
  const freshDir = fileTransfer.copyFilesToWorkspace(
    [{ name: 'source.txt', path: srcFile }],
    WORKSPACE, 'fresh-subdir', requestId
  );
  const dirStat = fs.statSync(path.join(WORKSPACE, 'fresh-subdir'));
  assert((dirStat.mode & 0o777) === 0o700, 'newly created dest dir has mode 0700');

  // Test 17: intermediate directory symlink must not be followed
  console.log('\n17. Security - intermediate directory symlink');
  const outsideDir = path.join(path.dirname(WORKSPACE), `outside-${Date.now()}`);
  fs.mkdirSync(path.join(outsideDir, 'nested'), { recursive: true });
  fs.symlinkSync(outsideDir, path.join(WORKSPACE, 'linked-parent'));
  shouldThrow(
    () => fileTransfer.copyFilesToWorkspace(
      [{ name: 'escaped.txt', path: srcFile }],
      WORKSPACE, 'linked-parent/nested', requestId
    ),
    'rejects symlink in an intermediate directory'
  );
  assert(
    !fs.existsSync(path.join(outsideDir, 'nested', 'escaped.txt')),
    'does not write through intermediate symlink'
  );

  // Test 18: final file symlink must not be followed, even with overwrite
  console.log('\n18. Security - final file symlink');
  const outsideVictim = path.join(outsideDir, 'victim.txt');
  fs.writeFileSync(outsideVictim, 'do not replace');
  fs.symlinkSync(outsideVictim, path.join(WORKSPACE, 'docs', 'linked-file.txt'));
  shouldThrow(
    () => fileTransfer.copyFilesToWorkspace(
      [{ name: 'linked-file.txt', path: srcFile, overwrite: true }],
      WORKSPACE, 'docs', requestId
    ),
    'rejects final destination symlink'
  );
  assert(
    fs.readFileSync(outsideVictim, 'utf8') === 'do not replace',
    'does not overwrite final symlink target'
  );

  // Test 19: a missing final file inside a symlinked directory stays outside
  console.log('\n19. Security - missing file inside symlink directory');
  fs.symlinkSync(outsideDir, path.join(WORKSPACE, 'linked-missing'));
  shouldThrow(
    () => fileTransfer.copyFilesToWorkspace(
      [{ name: 'new-outside.txt', path: srcFile }],
      WORKSPACE, 'linked-missing', requestId
    ),
    'rejects missing destination inside symlink directory'
  );
  assert(
    !fs.existsSync(path.join(outsideDir, 'new-outside.txt')),
    'does not create missing file outside workspace'
  );

  // Test 20: normal create and overwrite remain functional
  console.log('\n20. Security regression - normal create and overwrite');
  const regressionSource = path.join(WORKSPACE, '_src', 'regression.txt');
  fs.writeFileSync(regressionSource, 'version one');
  const regressionCreate = fileTransfer.copyFilesToWorkspace(
    [{ name: 'regression.txt', path: regressionSource }],
    WORKSPACE, 'security-regression', requestId
  );
  assert(
    fs.readFileSync(regressionCreate[0].path, 'utf8') === 'version one',
    'normal creation still works'
  );
  fs.writeFileSync(regressionSource, 'version two');
  const regressionOverwrite = fileTransfer.copyFilesToWorkspace(
    [{ name: 'regression.txt', path: regressionSource, overwrite: true }],
    WORKSPACE, 'security-regression', requestId
  );
  assert(
    fs.readFileSync(regressionOverwrite[0].path, 'utf8') === 'version two',
    'normal overwrite still works'
  );

  // Cleanup
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
