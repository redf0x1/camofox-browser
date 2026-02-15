const path = require('path');
const { launchServer } = require('../../dist/src/utils/launcher');
const { loadConfig } = require('../../dist/src/utils/config');

let serverProcess = null;
let serverPort = null;

async function waitForServer(port, maxRetries = 30, interval = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) {
        return true;
      }
    } catch (e) {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Server failed to start on port ${port} after ${maxRetries} attempts`);
}

async function startServer(port = 0, extraEnv = {}) {
  const cfg = loadConfig();
  const pluginDir = path.join(__dirname, '../..');

  const log = {
    info: (msg) => { if (process.env.DEBUG_SERVER) console.log(msg); },
    error: (msg) => { if (process.env.DEBUG_SERVER) console.error(msg); },
  };

  const maxStartAttempts = 5;
  let lastErr = null;

  for (let attempt = 0; attempt < maxStartAttempts; attempt++) {
    const usePort = port || Math.floor(3100 + Math.random() * 900);

    serverProcess = launchServer({
      pluginDir,
      port: usePort,
      env: { ...cfg.serverEnv, DEBUG_RESPONSES: 'false', ...extraEnv },
      log,
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to start server:', err);
    });

    serverPort = usePort;

    try {
      await waitForServer(usePort);
      console.log(`camofox-browser server started on port ${usePort}`);
      return usePort;
    } catch (err) {
      lastErr = err;
      // Port collision or slow start — kill and retry with a different port.
      try {
        serverProcess.kill('SIGTERM');
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
      serverProcess = null;
      serverPort = null;
      // If a specific port was requested, don't retry with a different one.
      if (port) break;
    }
  }

  throw lastErr || new Error('Server failed to start');
}

async function stopServer() {
  if (serverProcess) {
    return new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        if (serverProcess) {
          serverProcess.kill('SIGKILL');
        }
      }, 5000);

      serverProcess.on('close', () => {
        clearTimeout(killTimer);
        serverProcess = null;
        serverPort = null;
        resolve();
      });

      serverProcess.kill('SIGTERM');
    });
  }
}

function getServerUrl() {
  if (!serverPort) throw new Error('Server not started');
  return `http://localhost:${serverPort}`;
}

function getServerPort() {
  return serverPort;
}

module.exports = {
  startServer,
  stopServer,
  getServerUrl,
  getServerPort
};
