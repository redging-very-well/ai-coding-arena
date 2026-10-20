// Preflight for `npm start` / `npm run dev`: isolated-vm 6.1.2 ships prebuilt
// binaries only for Node 22 (ABI 127) and Node 24 (ABI 137). On any other
// version it fails deep inside sandbox startup, so fail early with a fix.
const SUPPORTED_MAJORS = [22, 24];

export function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const tooOld = major === 22 && minor < 13;
  if (SUPPORTED_MAJORS.includes(major) && !tooOld) return;
  console.error(
    `Pixel Clash needs Node 24 LTS (or 22.13+). This is Node ${process.versions.node}.\n` +
      'The sandbox (isolated-vm) has no build for this version.\n' +
      'Fix:  nvm install 24 && nvm use 24   (or: fnm use 24 / brew install node@24)\n' +
      'Then: rm -rf node_modules && npm ci && npm run build && npm start',
  );
  process.exit(1);
}
