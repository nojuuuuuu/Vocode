import pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';

export function attachTerminalServer(server, getWorkspace, host = '127.0.0.1', spawnTerminal = pty.spawn) {
  const sockets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128_000, perMessageDeflate: false });

  server.on('upgrade', (request, socket, head) => {
    const port = server.address()?.port;
    const origin = `http://${host}:${port}`;
    if (request.url !== '/api/terminal' || request.headers.host !== `${host}:${port}` || request.headers.origin !== origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    try { wss.handleUpgrade(request, socket, head, connection => wss.emit('connection', connection)); }
    catch { socket.destroy(); }
  });

  wss.on('connection', connection => {
    connection.on('error', () => {});
    if (sockets.size >= 8) {
      connection.send(JSON.stringify({ type: 'error', message: '同時に開けるターミナルは8つまでです。' }));
      connection.close();
      return;
    }

    let terminal;
    let exited = false;
    try {
      const cwd = getWorkspace();
      const shell = process.platform === 'win32' ? process.env.ComSpec || 'powershell.exe' : process.env.SHELL || '/bin/sh';
      terminal = spawnTerminal(shell, process.platform === 'win32' ? [] : ['-l'], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd,
        env: { ...process.env, PWD: cwd, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      });
      sockets.set(connection, terminal);
      terminal.onData(data => {
        if (connection.readyState === WebSocket.OPEN && connection.bufferedAmount < 1_000_000) {
          connection.send(JSON.stringify({ type: 'output', data }));
        }
      });
      terminal.onExit(({ exitCode }) => {
        exited = true;
        sockets.delete(connection);
        if (connection.readyState === WebSocket.OPEN) {
          connection.send(JSON.stringify({ type: 'exit', exitCode }));
          connection.close();
        }
      });
      connection.send(JSON.stringify({ type: 'ready', cwd }));
    } catch (error) {
      connection.send(JSON.stringify({ type: 'error', message: `シェルを起動できませんでした: ${error.message}` }));
      connection.close();
      return;
    }

    connection.on('message', (raw, isBinary) => {
      if (isBinary || exited) return;
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
      if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 65_536) {
        try { terminal.write(message.data); } catch { /* The shell has exited. */ }
      } else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)
        && message.cols >= 2 && message.cols <= 500 && message.rows >= 2 && message.rows <= 200) {
        try { terminal.resize(message.cols, message.rows); } catch { /* The shell has exited. */ }
      }
    });
    connection.on('close', () => {
      sockets.delete(connection);
      if (!exited) { try { terminal.kill(); } catch { /* Already closed. */ } }
    });
  });

  function closeAll() {
    for (const [connection, terminal] of sockets) {
      try { terminal.kill(); } catch { /* Already closed. */ }
      if (connection.readyState === WebSocket.OPEN) connection.close(1000, 'Workspace changed');
    }
    sockets.clear();
  }

  server.on('close', () => { closeAll(); wss.close(); });
  return { closeAll };
}
