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
  let sessionId = null;
  let nextShareRequest = 0;
  const sharingRequests = new Map();

  function resolveSharingRequests() {
    for (const resolve of sharingRequests.values()) resolve(null);
    sharingRequests.clear();
  }

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
    sessionId = null;
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
        sessionId = message.sessionId;
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
      } else if (message.type === 'sharing') {
        const resolve = sharingRequests.get(message.requestId);
        if (resolve) {
          sharingRequests.delete(message.requestId);
          resolve(message.enabled);
        }
      }
    });
    connection.addEventListener('close', () => {
      if (socket !== connection) return;
      socket = null;
      sessionId = null;
      resolveSharingRequests();
      if (!exited) onState('disconnected');
    });
    connection.addEventListener('error', () => {
      if (socket === connection) onState('error');
    });
  }

  function disconnect() {
    const connection = socket;
    socket = null;
    sessionId = null;
    resolveSharingRequests();
    if (connection && [WebSocket.CONNECTING, WebSocket.OPEN].includes(connection.readyState)) connection.close();
    onState('disconnected');
  }

  return {
    connect,
    disconnect,
    restart() { disconnect(); connect(); },
    fit,
    getSessionId() { return socket?.readyState === WebSocket.OPEN ? sessionId : null; },
    setAiSharing(enabled) {
      if (!this.getSessionId()) return Promise.resolve(null);
      const requestId = String(++nextShareRequest);
      return new Promise(resolve => {
        const timeout = setTimeout(() => { sharingRequests.delete(requestId); resolve(null); }, 2000);
        sharingRequests.set(requestId, value => { clearTimeout(timeout); resolve(value); });
        send({ type: 'sharing', enabled, requestId });
      });
    },
    focus() { terminal.focus(); },
    clear() { terminal.clear(); },
    dispose() { disconnect(); resizeObserver.disconnect(); input.dispose(); terminal.dispose(); }
  };
}
