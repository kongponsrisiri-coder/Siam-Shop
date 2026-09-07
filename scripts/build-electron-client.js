// Build the React client for the desktop till (SIAMSHOP-ELECTRON-001).
// Cross-platform (Windows CI has no `VAR=x cmd` syntax): sets ELECTRON_BUILD=1
// and an EMPTY VITE_API_BASE (the desktop reads the cloud URL from its
// config.json, never from the build), then runs the client's vite build →
// client/dist-electron. Also ignores client/.env.local so a dev machine's
// production API URL can't leak into an installer.
const { spawnSync } = require('child_process');
const path = require('path');

const clientDir = path.join(__dirname, '..', 'client');
const env = { ...process.env, ELECTRON_BUILD: '1', VITE_API_BASE: '' };
const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: clientDir, env, stdio: 'inherit', shell: process.platform === 'win32',
});
process.exit(r.status == null ? 1 : r.status);
