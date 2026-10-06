import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export function createWorkspaceTerminal(parent, onState) {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: {
      background: '#111b24', foreground: '#d9e7e5', cursor: '#8deac1',
      selectionBackground: '#456c5e', black: '#101820', brightBlack: '#667987'
    }
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(parent);
  let socket = null;
  let exited = false;

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function fit() {
    if (!parent.clientWidth || !parent.clientHeight) return;
    fitAddon.fit();
    send({ type: 'resize', cols: terminal.cols, rows: terminal.rows });
  }

  const resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(parent);
  const input = terminal.onData(data => {
    for (let offset = 0; offset < data.length; offset += 16_384) {
      send({ type: 'input', data: data.slice(offset, offset + 16_384) });
    }
  });

  function connect() {
    if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) {
      fit();
      terminal.focus();
      return;
    }
    terminal.reset();
    terminal.writeln('シェルに接続しています…');
    onState('connecting');
    exited = false;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(`${protocol}//${location.host}/api/terminal`);
    socket = connection;
    connection.addEventListener('open', () => {
      if (socket !== connection) return;
      fit();
      terminal.focus();
    });
    connection.addEventListener('message', event => {
      if (socket !== connection) return;
      let message;
      try { message = JSON.parse(event.data); }
      catch { return; }
      if (message.type === 'output') terminal.write(message.data);
      else if (message.type === 'ready') {
        onState('ready', message.cwd);
        fit();
      } else if (message.type === 'exit') {
        exited = true;
        terminal.writeln(`\r\n[シェルが終了しました: ${message.exitCode}]`);
        onState('exited');
      } else if (message.type === 'error') {
        exited = true;
        terminal.writeln(`\r\n[${message.message}]`);
        onState('error');
      }
    });
    connection.addEventListener('close', () => {
      if (socket !== connection) return;
      socket = null;
      if (!exited) onState('disconnected');
    });
    connection.addEventListener('error', () => {
      if (socket === connection) onState('error');
    });
  }

  function disconnect() {
    const connection = socket;
    socket = null;
    if (connection && [WebSocket.CONNECTING, WebSocket.OPEN].includes(connection.readyState)) connection.close();
    onState('disconnected');
  }

  return {
    connect,
    disconnect,
    restart() { disconnect(); connect(); },
    fit,
    focus() { terminal.focus(); },
    clear() { terminal.clear(); },
    dispose() { disconnect(); resizeObserver.disconnect(); input.dispose(); terminal.dispose(); }
  };
}
