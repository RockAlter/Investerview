'use strict';
// Builds a single-file executable (dist/Investerview.exe on Windows) using Node's
// "single executable application" support. Run with: npm run build   (Node 20+)
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const root = __dirname;
const build = path.join(root, 'build'), dist = path.join(root, 'dist');
const exe = path.join(dist, process.platform === 'win32' ? 'Investerview.exe' : 'investerview');
const blob = path.join(build, 'sea-prep.blob');
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

// 1. bundle server.js + the page files into a blob
const assets = {};
for (const f of fs.readdirSync(path.join(root, 'public'))) assets['public/' + f] = path.join(root, 'public', f);
const cfg = path.join(build, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({ main: path.join(root, 'server.js'), output: blob, disableExperimentalSEAWarning: true, assets }, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });

// 2. copy the Node runtime and inject the blob into it
fs.copyFileSync(process.execPath, exe);
const args = [`"${exe}"`, 'NODE_SEA_BLOB', `"${blob}"`, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execSync('npx --yes postject ' + args.join(' '), { stdio: 'inherit', cwd: root });

console.log(`\nBuilt ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
