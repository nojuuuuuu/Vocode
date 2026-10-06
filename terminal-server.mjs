import pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

function readableOutput(value) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function attachTerminalServer(server, getWorkspace, host = '127.0.0.1', spawnTerminal = pty.spawn) {
  const sockets = new Map();
  const sessions = new Map();
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
      const session = { id: randomUUID(), cwd, terminal, connection, output: '', shared: false, listeners: new Set(), queue: Promise.resolve() };
      sockets.set(connection, session);
      sessions.set(session.id, session);
      terminal.onData(data => {
        session.output = (session.output + data).slice(-48_000);
        for (const listener of session.listeners) listener(data);
        if (connection.readyState === WebSocket.OPEN && connection.bufferedAmount < 1_000_000) {
          connection.send(JSON.stringify({ type: 'output', data }));
        }
      });
      terminal.onExit(({ exitCode }) => {
        exited = true;
        sockets.delete(connection);
        sessions.delete(session.id);
        for (const listener of session.listeners) listener('');
        if (connection.readyState === WebSocket.OPEN) {
          connection.send(JSON.stringify({ type: 'exit', exitCode }));
          connection.close();
        }
      });
      connection.send(JSON.stringify({ type: 'ready', cwd, sessionId: session.id }));
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
      if (message.type === 'sharing' && typeof message.enabled === 'boolean') {
        const session = sockets.get(connection);
        if (session) {
          session.shared = message.enabled;
          connection.send(JSON.stringify({ type: 'sharing', enabled: session.shared, requestId: message.requestId }));
        }
      } else if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 65_536) {
        try { terminal.write(message.data); } catch { /* The shell has exited. */ }
      } else if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)
        && message.cols >= 2 && message.cols <= 500 && message.rows >= 2 && message.rows <= 200) {
        try { terminal.resize(message.cols, message.rows); } catch { /* The shell has exited. */ }
      }
    });
    connection.on('close', () => {
      const session = sockets.get(connection);
      sockets.delete(connection);
      if (session) {
        sessions.delete(session.id);
        for (const listener of session.listeners) listener('');
      }
      if (!exited) { try { terminal.kill(); } catch { /* Already closed. */ } }
    });
  });

  function getSession(id) {
    const session = sessions.get(id);
    return session?.shared && session.cwd === getWorkspace() && session.connection.readyState === WebSocket.OPEN ? session : null;
  }

  function readSession(id, maxChars = 12_000) {
    const session = getSession(id);
    if (!session) return null;
    return readableOutput(session.output).slice(-Math.max(1000, Math.min(16_000, maxChars)));
  }

  async function inputSession(id, text) {
    const session = getSession(id);
    if (!session) return { error: 'ターミナルとの接続がありません。' };
    if (typeof text !== 'string' || !text.trim() || text.length > 2000 || /[\r\n\0]/.test(text)) {
      return { error: '1行のコマンドを2000文字以内で指定してください。' };
    }
    const run = async () => {
      if (!getSession(id)) return { error: 'ターミナルとの接続が切れました。' };
      let captured = '';
      let finish;
      const completed = new Promise(resolve => { finish = resolve; });
      const timeout = setTimeout(() => finish('timeout'), 12_000);
      let idle;
      const onData = data => {
        if (!getSession(id)) { finish('disconnected'); return; }
        captured = (captured + data).slice(-16_000);
        clearTimeout(idle);
        idle = setTimeout(() => finish('idle'), 900);
      };
      session.listeners.add(onData);
      try {
        session.terminal.write(`${text}\r`);
        const status = await completed;
        return { output: readableOutput(captured).slice(-12_000), status };
      } catch (error) {
        return { error: `入力できませんでした: ${error.message}` };
      } finally {
        clearTimeout(timeout);
        clearTimeout(idle);
        session.listeners.delete(onData);
      }
    };
    const result = session.queue.then(run);
    session.queue = result.catch(() => {});
    return result;
  }

  function closeAll() {
    for (const [connection, session] of sockets) {
      sessions.delete(session.id);
      for (const listener of session.listeners) listener('');
      try { session.terminal.kill(); } catch { /* Already closed. */ }
      if (connection.readyState === WebSocket.OPEN) connection.close(1000, 'Workspace changed');
    }
    sockets.clear();
  }

  server.on('close', () => { closeAll(); wss.close(); });
  return { closeAll, readSession, inputSession };
}
