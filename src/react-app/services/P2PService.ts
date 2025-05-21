// src/react-app/services/P2PService.ts
import Peer, { Instance as SimplePeerInstance, SignalData } from 'simple-peer';

interface P2PServiceOptions {
  roomId: string;
  initiator: boolean;
  onSignal: (data: SignalData) => void; // For sending signal data via WebSocket
  onConnect: () => void;
  onData: (data: any) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

export class P2PService {
  private peer: SimplePeerInstance | null = null;
  private ws: WebSocket | null = null;
  private options: P2PServiceOptions;
  private roomId: string;

  constructor(options: P2PServiceOptions) {
    this.options = options;
    this.roomId = options.roomId;
    this.connectWebSocket();
  }

  private connectWebSocket(): void {
    // Construct WebSocket URL (ensure protocol is ws or wss)
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws/signaling/${this.roomId}`;
    
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('P2PService: WebSocket connection established');
      // Once WebSocket is open, initialize the peer connection
      this.initializePeer();
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        if (message.type === 'signal' && message.payload && this.peer) {
          this.peer.signal(message.payload);
        } else if (message.type === 'user-joined' && !this.options.initiator) {
          // If another user joined and this client is not the initiator,
          // it might be a cue to re-initiate or confirm connection.
          // For simple two-peer rooms, this might not be strictly needed if initiator handles it.
          console.log('P2PService: User joined signal received', message);
        }
      } catch (error) {
        console.error('P2PService: Error parsing WebSocket message or signaling peer', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('P2PService: WebSocket error:', error);
      this.options.onError(new Error('WebSocket connection error'));
    };

    this.ws.onclose = () => {
      console.log('P2PService: WebSocket connection closed');
      // this.options.onClose(); // May lead to premature P2P close if peer is still active
    };
  }

  private initializePeer(): void {
    if (this.peer) {
        this.peer.destroy();
    }

    this.peer = new Peer({
      initiator: this.options.initiator,
      trickle: true, // Enable trickle ICE
      config: { 
        iceServers: [ // Example STUN servers
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478?transport=udp' }
        ]
      },
      // objectMode: true, // If you want to send JS objects directly (less efficient for files)
    });

    this.peer.on('signal', (data) => {
      // Send this signal data to the other peer via WebSocket
      // Structure it as per your signaling server's expectation
      const message = { type: 'signal', payload: data };
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      }
      // Also invoke the onSignal callback if provided (though direct sending is typical)
      this.options.onSignal(data); 
    });

    this.peer.on('connect', () => {
      console.log('P2PService: Peer connection established');
      this.options.onConnect();
      // Optional: Send a confirmation or user-joined message via WebSocket if needed
      // if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      //   this.ws.send(JSON.stringify({ type: 'user-joined', userId: 'some-id' }));
      // }
    });

    this.peer.on('data', (data) => {
      // console.log('P2PService: Data received', data);
      this.options.onData(data);
    });

    this.peer.on('error', (err) => {
      console.error('P2PService: Peer error:', err);
      this.options.onError(err);
    });

    this.peer.on('close', () => {
      console.log('P2PService: Peer connection closed');
      this.options.onClose();
      // Optionally try to reconnect or clean up WebSocket
      // if (this.ws) {
      //   this.ws.close();
      // }
    });
  }
  
  public send(data: string | ArrayBuffer | Blob): void {
    if (this.peer && this.peer.connected) {
      this.peer.send(data);
    } else {
      console.warn('P2PService: Cannot send data, peer not connected.');
      // this.options.onError(new Error('Cannot send data, peer not connected.'));
    }
  }
  
  // Method to manually signal the peer, e.g., when an offer/answer is received via alternative channel
  public signal(data: string | SignalData): void {
    if (this.peer) {
      this.peer.signal(data);
    }
  }

  public destroy(): void {
    console.log('P2PService: Destroying...');
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
