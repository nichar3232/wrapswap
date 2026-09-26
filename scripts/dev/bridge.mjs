// Publish loopback-only component servers without changing their implementation.
import { networkInterfaces } from 'node:os';
import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
const [kind, ...command] = process.argv.slice(2);
const port = Number(process.env[kind === 'api' ? 'API_PORT' : 'CRANK_HEALTH_PORT']);
const address = Object.values(networkInterfaces()).flat().find(x => x.family === 'IPv4' && !x.internal)?.address;
if (!address) throw Error('container has no external interface');
const server = createServer(socket => {
  const upstream = connect(port, '127.0.0.1');
  socket.pipe(upstream).pipe(socket);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});
server.listen(port, address);
const child = spawn(command[0], command.slice(1), {stdio:'inherit'});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { server.close(); process.exit(code ?? 1); });
