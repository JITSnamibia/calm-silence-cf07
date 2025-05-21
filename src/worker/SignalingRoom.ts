// src/worker/SignalingRoom.ts

// Env type is globally available from worker-configuration.d.ts,
// which includes bindings like R2, KV, and other DOs.
// For this specific DO, 'env' is passed but not directly used unless
// this DO needed to interact with other bindings (e.g., logging to KV).

export class SignalingRoom implements DurableObject {
  state: DurableObjectState;
  env: Env; 
  sessions: WebSocket[];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    
    // Optional: Load persisted data or perform initial setup if needed.
    // For a simple signaling server, in-memory session management is often sufficient.
    // this.state.blockConcurrencyWhile(async () => {
    //   // Example: const storedSessions = await this.state.storage.get('sessions');
    //   // this.sessions = storedSessions || [];
    // });
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const { 0: client, 1: server } = webSocketPair;

    // Accept the server-side WebSocket
    server.accept();
    this.sessions.push(server);

    server.addEventListener('message', event => {
      const messageData = event.data;
      // Broadcast the message to all other clients in this room
      this.sessions.forEach(session => {
        if (session !== server && session.readyState === WebSocket.OPEN) {
          try {
            session.send(messageData);
          } catch (sendError) {
            console.error(`SignalingRoom: Error sending message to a session: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
            // Consider removing the session if send fails, or implement a more robust error handling/retry mechanism.
            // For simplicity, we'll just log here. If a session is consistently failing,
            // it might be closed by the 'close' or 'error' event handlers eventually.
          }
        }
      });
    });

    const closeOrErrorHandler = () => {
      this.sessions = this.sessions.filter(session => session !== server);
      // For a large number of sessions or more complex state, you might use a Set for better performance on removal.
      // e.g., if (this.sessions instanceof Set) { this.sessions.delete(server); }
      console.log(`SignalingRoom: WebSocket session removed. Current sessions: ${this.sessions.length}`);
    };

    server.addEventListener('close', event => {
      console.log(`SignalingRoom: WebSocket closed. Code: ${event.code}, Reason: "${event.reason}", WasClean: ${event.wasClean}.`);
      closeOrErrorHandler();
    });

    server.addEventListener('error', event => {
      const error = event.error || event; // event itself might be the error object
      console.error(`SignalingRoom: WebSocket error. Error: ${error instanceof Error ? error.message : String(error)}`);
      closeOrErrorHandler();
    });
    
    console.log(`SignalingRoom: New WebSocket connection established. Current sessions: ${this.sessions.length}`);

    return new Response(null, {
      status: 101, // Switching Protocols
      webSocket: client,
    });
  }

  // The Durable Object runtime automatically calls these handlers if defined
  // AND if state.acceptWebSocket(ws) is used.
  // Since we are manually managing WebSocketPair and using addEventListener,
  // these explicit methods are not strictly necessary for the current implementation
  // but are good for reference or future refactoring if state.acceptWebSocket() is adopted.

  // async webSocketMessage(ws: WebSocket, message: any) {
  //   // This is called when a WebSocket message is received from a client.
  //   // `ws` is the server-side WebSocket object.
  //   // `message` is the data received. It can be a string or ArrayBuffer.
  //   console.log('Message received in webSocketMessage:', message);
  //   this.broadcast(ws, message);
  // }

  // async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
  //   console.log(`WebSocket closed: code ${code}, reason '${reason}', wasClean ${wasClean}`);
  //   this.removeSession(ws);
  // }

  // async webSocketError(ws: WebSocket, error: any) {
  //   console.error('WebSocket error:', error);
  //   this.removeSession(ws);
  // }

  // Helper methods (if not using addEventListener directly in fetch)
  // private broadcast(currentWs: WebSocket, message: any) {
  //   this.sessions.forEach(session => {
  //     if (session !== currentWs && session.readyState === WebSocket.OPEN) {
  //       try {
  //         session.send(message);
  //       } catch (e) {
  //         console.error("Failed to send message to session:", e);
  //       }
  //     }
  //   });
  // }

  // private removeSession(ws: WebSocket) {
  //   this.sessions = this.sessions.filter(session => session !== ws);
  // }
}
