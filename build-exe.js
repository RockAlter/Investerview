'use strict';
// Builds a single-file executable (dist/InvestorView.exe on Windows) using Node's
// "single executable application" support. Run with: npm run build   (Node 20+)
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const root = __dirname;
const build = path.join(root, 'build'), dist = path.join(root, 'dist');
const exe = path.join(dist, process.platform === 'win32' ? 'InvestorView.exe' : 'investorview');
const blob = path.join(build, 'sea-prep.blob');
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

// 1. bundle server.js + the page files into a blob
const assets = {};
for (const f of fs.readdirSync(path.join(root, 'public'))) assets['public/' + f] = path.join(root, 'public', f);
const cfg = path.join(build, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({ main: path.join(root, 'server.js'), output: blob, disableExperimentalSEAWarning: true, assets }, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });

// 2. copy the Node runtime; on Windows give it the app's icon and name and make it a windowed program
//    (no console window: the app shows its own window, see openApp in server.js); then inject the blob
fs.copyFileSync(process.execPath, exe);
if (process.platform === 'win32') {
  const version = require('./package.json').version;
  const tools = path.join(build, 'tools');
  fs.mkdirSync(tools, { recursive: true });
  if (!fs.existsSync(path.join(tools, 'node_modules', 'rcedit'))) execSync('npm install --no-save --no-audit --no-fund --prefix "' + tools + '" rcedit@4', { stdio: 'inherit' });
  const rcedit = path.join(tools, 'node_modules', 'rcedit', 'bin', process.arch === 'x64' ? 'rcedit-x64.exe' : 'rcedit.exe');
  execFileSync(rcedit, [exe, '--set-icon', path.join(root, 'icon.ico'), '--set-file-version', version, '--set-product-version', version,
    '--set-version-string', 'ProductName', 'InvestorView', '--set-version-string', 'FileDescription', 'InvestorView',
    '--set-version-string', 'OriginalFilename', 'InvestorView.exe', '--set-version-string', 'InternalName', 'InvestorView',
    '--set-version-string', 'CompanyName', 'InvestorView', '--set-version-string', 'LegalCopyright', 'InvestorView; includes the Node.js runtime'], { stdio: 'inherit' });
  // PE header: Subsystem (optional header + 68) 3 = console, 2 = windowed
  const fd = fs.openSync(exe, 'r+'), b4 = Buffer.alloc(4), b2 = Buffer.alloc(2);
  fs.readSync(fd, b4, 0, 4, 0x3c);
  const at = b4.readUInt32LE(0) + 24 + 68;
  fs.readSync(fd, b2, 0, 2, at);
  if (b2.readUInt16LE(0) !== 3 && b2.readUInt16LE(0) !== 2) throw new Error('Unexpected PE subsystem ' + b2.readUInt16LE(0));
  b2.writeUInt16LE(2, 0); fs.writeSync(fd, b2, 0, 2, at); fs.closeSync(fd);
}
const args = [`"${exe}"`, 'NODE_SEA_BLOB', `"${blob}"`, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execSync('npx --yes postject ' + args.join(' '), { stdio: 'inherit', cwd: root });

console.log(`\nBuilt ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
