import { startDaemon } from '../packages/murmur/dist/daemon/server.js';

if (!process.argv[2]) throw new Error('Pass a dedicated private preview state directory.');
const daemon = await startDaemon(process.argv[2]);
console.log(`Murmur preview listening on http://127.0.0.1:${daemon.port}/ui/`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  void daemon.close().catch(() => { process.exitCode = 1; });
});
