import { useState, ChangeEvent, useEffect, useRef } from 'react';
import pako from 'pako';
import './App.css';
import { P2PService } from './services/P2PService';
import { SignalData } from 'simple-peer';

interface FileMetadata { // For R2 stored files
  filename: string;
  uploadedAt: string;
  contentType: string;
  size: number; 
  isCompressed: boolean;
  originalSize?: number;
}

interface P2PLogMessage { 
  timestamp: number;
  data: string;
  sender?: 'me' | 'peer' | 'system';
}

interface P2PFileMeta { 
  name: string;
  size: number; 
  type: string; 
  isCompressed: boolean;
}

const shouldCompress = (file: File): boolean => {
  const alreadyCompressedTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'video/mp4',
    'application/zip', 'application/gzip', 'application/pdf',
  ];
  if (file.name.endsWith('.gz') || file.name.endsWith('.zip') || file.name.endsWith('.rar')) {
    return false;
  }
  return !alreadyCompressedTypes.includes(file.type);
};

const CHUNK_SIZE = 64 * 1024; 
const P2P_RECEIVE_TIMEOUT_MS = 30000; 
const P2P_CONNECT_TIMEOUT_MS = 15000;
const APP_MESSAGE_TIMEOUT_MS = 7000; // Default duration for auto-clearing messages

type UnifiedShareFlowStep = 
  | 'idle' 
  | 'awaiting_room_id'
  | 'p2p_connect_attempt'
  | 'p2p_connected_for_action'
  | 'p2p_direct_transfer'
  | 'p2p_r2_pointer_send'
  | 'p2p_direct_transfer_failed_offer_r2'
  | 'r2_fallback_upload'
  | 'share_complete_success' 
  | 'share_failed';      

type AppMessageType = 'info' | 'success' | 'error';

interface OverallAppMessage {
    text: string;
    type: AppMessageType;
}

function App() {
  const [overallAppMessage, setOverallAppMessage] = useState<OverallAppMessage | null>(null);
  const appMessageTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [selectedFileForR2, setSelectedFileForR2] = useState<File | null>(null);
  const [cloudFiles, setCloudFiles] = useState<FileMetadata[]>([]);
  // const [message, setMessage] = useState<string>(''); // Replaced
  const [initialCloudFilesLoading, setInitialCloudFilesLoading] = useState<string>('');
  const [r2UploadStepMessage, setR2UploadStepMessage] = useState<string>('');
  const [isUploadingToR2, setIsUploadingToR2] = useState<boolean>(false); 
  const [isDownloadingR2, setIsDownloadingR2] = useState<boolean>(false);
  const [isDeletingR2, setIsDeletingR2] = useState<string | null>(null);

  const [manualP2PService, setManualP2PService] = useState<P2PService | null>(null);
  const [manualP2PRoomIdInput, setManualP2PRoomIdInput] = useState<string>('');
  const [manualP2PCurrentRoomId, setManualP2PCurrentRoomId] = useState<string | null>(null);
  const [manualP2PConnectionStatus, setManualP2PConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'failed'>('disconnected');
  const [manualP2PReceivedMessages, setManualP2PReceivedMessages] = useState<P2PLogMessage[]>([]);
  const [fileForManualP2P, setFileForManualP2P] = useState<File | null>(null);
  const [manualP2PMessageInput, setManualP2PMessageInput] = useState<string>('');
  
  const [p2pFileTransferProgress, setP2PFileTransferProgress] = useState<{ type: 'send' | 'receive', filename: string, progress: number } | null>(null);
  const [p2pReceivingFileMeta, setP2PReceivingFileMeta] = useState<P2PFileMeta | null>(null);
  const [p2pReceivedFileChunks, setP2PReceivedFileChunks] = useState<ArrayBuffer[]>([]);
  const p2pReceiveTimeoutIdRef = useRef<NodeJS.Timeout | null>(null);

  const [itemToShare, setItemToShare] = useState<File | FileMetadata | null>(null);
  const [shareTargetRoomIdInput, setShareTargetRoomIdInput] = useState<string>('');
  const [shareFlowStep, setShareFlowStep] = useState<UnifiedShareFlowStep>('idle');
  const [shareP2PServiceInstance, setShareP2PServiceInstance] = useState<P2PService | null>(null);
  const shareP2PTimeoutIdRef = useRef<NodeJS.Timeout | null>(null);
  // const [shareFlowMessage, setShareFlowMessage] = useState<string>(''); // Replaced by overallAppMessage for primary feedback

  const manualP2PReceivedMessagesRef = useRef<HTMLDivElement>(null);
  const localFileShareInputRef = useRef<HTMLInputElement>(null);

  const setAppMessageFx = (text: string, type: AppMessageType, duration: number = APP_MESSAGE_TIMEOUT_MS) => {
    if (appMessageTimeoutRef.current) {
        clearTimeout(appMessageTimeoutRef.current);
    }
    setOverallAppMessage({ text, type });
    if (duration > 0 && type !== 'error') { // Errors persist until explicitly cleared or another message comes
        appMessageTimeoutRef.current = setTimeout(() => {
            setOverallAppMessage(prev => (prev?.text === text ? null : prev)); // Clear only if it's the same message
        }, duration);
    }
  };

  useEffect(() => { return () => { manualP2PService?.destroy(); }; }, [manualP2PService]);
  useEffect(() => { 
    return () => { 
      shareP2PServiceInstance?.destroy();
      if (shareP2PTimeoutIdRef.current) clearTimeout(shareP2PTimeoutIdRef.current);
      if (p2pReceiveTimeoutIdRef.current) clearTimeout(p2pReceiveTimeoutIdRef.current);
      if (appMessageTimeoutRef.current) clearTimeout(appMessageTimeoutRef.current);
    };
  }, [shareP2PServiceInstance]);

  useEffect(() => {
    if (manualP2PReceivedMessagesRef.current) {
      manualP2PReceivedMessagesRef.current.scrollTop = manualP2PReceivedMessagesRef.current.scrollHeight;
    }
  }, [manualP2PReceivedMessages]);

  const fetchR2Files = async () => {
    setInitialCloudFilesLoading('Loading Cloud Files...');
    try {
      const response = await fetch('/api/files');
      if (!response.ok) {
        const errorData = await response.json().catch(()=>({message: `HTTP error! status: ${response.status}`}));
        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      if (data.success) {
        setCloudFiles(data.files || []);
        if ((data.files || []).length === 0 && shareFlowStep === 'idle' && manualP2PConnectionStatus === 'disconnected') {
           // No initial message if list is empty, handled by render logic
        }
      } else {
        setAppMessageFx(data.message || 'Failed to load Cloud Files.', 'error', 0);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setAppMessageFx(`Error fetching Cloud Files: ${errorMsg}`, 'error', 0);
      console.error("Fetch R2 Files Error:", error);
    } finally {
      setInitialCloudFilesLoading('');
    }
  };
  
  useEffect(() => { fetchR2Files(); }, []); 

  const handleDirectR2FileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      setSelectedFileForR2(event.target.files[0]);
      setAppMessageFx('', 'info', 0); 
      setR2UploadStepMessage('');
    } else { setSelectedFileForR2(null); }
  };

  const performR2Upload = async (fileToUpload: File, progressCallback: (stepMsg: string, isError?: boolean) => void): Promise<FileMetadata> => {
    // ... (performR2Upload logic is largely the same, ensure progressCallback is called with isError flag)
    if (!fileToUpload) {
      const noFileError = 'Error: No file selected for upload.';
      progressCallback(noFileError, true);
      throw new Error(noFileError);
    }
    let currentStepMessage = 'Initiating Cloud upload...';
    progressCallback(currentStepMessage);
    try {
      const originalContentType = fileToUpload.type || 'application/octet-stream';
      const originalSize = fileToUpload.size;

      const initiateResponse = await fetch('/api/files/initiate-upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: fileToUpload.name, contentType: originalContentType }),
      });
      const initiateData = await initiateResponse.json();
      if (!initiateResponse.ok || !initiateData.success) {
        throw new Error(initiateData.message || `Failed to initiate Cloud upload (HTTP ${initiateResponse.status})`);
      }
      const serverFilenameFromInitiate = initiateData.filename; 
      const presignedPutUrl = initiateData.url;
      currentStepMessage = 'Cloud Upload initiated. Preparing file...'; progressCallback(currentStepMessage);
      
      let uploadData: Uint8Array | File; let isCompressedForR2 = false;
      try {
        if (shouldCompress(fileToUpload)) {
          currentStepMessage = 'Compressing file for Cloud...'; progressCallback(currentStepMessage);
          const fileBuffer = await fileToUpload.arrayBuffer();
          uploadData = pako.deflate(fileBuffer); isCompressedForR2 = true;
        } else {
          uploadData = fileToUpload; isCompressedForR2 = false;
        }
      } catch (compError) {
        throw new Error(`File processing/compression error: ${compError instanceof Error ? compError.message : String(compError)}`);
      }
      const uploadDataSize = isCompressedForR2 ? (uploadData as Uint8Array).byteLength : (uploadData as File).size;
      currentStepMessage = isCompressedForR2 ? 'File compressed. Uploading to Cloud...' : 'Uploading to Cloud...'; progressCallback(currentStepMessage);
      
      const r2Response = await fetch(presignedPutUrl, { method: 'PUT', body: uploadData });
      if (!r2Response.ok) {
        const r2ErrorText = await r2Response.text().catch(() => "Could not read R2 error response.");
        throw new Error(`Failed to upload to Cloud (HTTP ${r2Response.status}): ${r2Response.statusText}. ${r2ErrorText.substring(0,100)}`);
      }
      currentStepMessage = 'File uploaded to Cloud. Finalizing...'; progressCallback(currentStepMessage);

      const finalizeResponse = await fetch('/api/files/finalize-upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: serverFilenameFromInitiate, contentType: originalContentType,
          size: uploadDataSize, isCompressed: isCompressedForR2,
        }),
      });
      const finalizeData = await finalizeResponse.json();
      if (!finalizeResponse.ok || !finalizeData.success) {
        throw new Error(finalizeData.message || `Failed to finalize Cloud upload (HTTP ${finalizeResponse.status})`);
      }
      
      await fetchR2Files(); 
      progressCallback('Cloud upload finalized successfully!');
      return {
        filename: serverFilenameFromInitiate, uploadedAt: new Date().toISOString(), 
        contentType: originalContentType, size: uploadDataSize,
        isCompressed: isCompressedForR2, originalSize: isCompressedForR2 ? originalSize : undefined,
      };
    } catch (error) {
      const errText = error instanceof Error ? error.message : String(error);
      progressCallback(`Error: ${errText}`, true);
      console.error("performR2Upload Error:", error);
      throw error;
    }
  };

  const handleDirectR2Upload = async () => {
    if (!selectedFileForR2) { setAppMessageFx('Please select a file for Cloud upload first.', 'error'); return; }
    setIsUploadingToR2(true); setAppMessageFx('', 'info', 0); setR2UploadStepMessage('');
    try {
      const uploadedMetadata = await performR2Upload(selectedFileForR2, (msg, isError) => setR2UploadStepMessage(isError ? `Error: ${msg}` : msg));
      setAppMessageFx(`File '${uploadedMetadata.filename}' uploaded to Cloud successfully!`, 'success');
      setSelectedFileForR2(null);
      const fileInput = document.getElementById('direct-r2-file-input') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setAppMessageFx(`Cloud Upload process ultimately failed: ${errorMsg}`, 'error', 0); // Persistent error
    } finally {
      setIsUploadingToR2(false); 
      setTimeout(() => setR2UploadStepMessage(''), APP_MESSAGE_TIMEOUT_MS);
    }
  };

  const handleDownloadR2 = async (fileMeta: FileMetadata) => {
    setIsDownloadingR2(true); setAppMessageFx(`Requesting Cloud download for ${fileMeta.filename}...`, 'info', 0);
    try {
      // ... (rest of handleDownloadR2 logic, using setAppMessageFx)
      const requestUrlRes = await fetch(`/api/files/request-download/${fileMeta.filename}`);
      if (!requestUrlRes.ok) {
        const errorData = await requestUrlRes.json().catch(()=>({message: `HTTP error ${requestUrlRes.status}`}));
        throw new Error(errorData.message || `Failed to request Cloud download URL (HTTP ${requestUrlRes.status})`);
      }
      const requestUrlData = await requestUrlRes.json();
      if (!requestUrlData.success) throw new Error(requestUrlData.message || 'Failed to get download URL from API.');
      
      const presignedGetUrl = requestUrlData.url;
      const serverMetadata: FileMetadata = requestUrlData.metadata; 
      setAppMessageFx(`Downloading ${serverMetadata.filename} from Cloud...`, 'info', 0);

      const fileRes = await fetch(presignedGetUrl);
      if (!fileRes.ok) {
        throw new Error(`Failed to download file from Cloud (HTTP ${fileRes.status}): ${fileRes.statusText}`);
      }
      const fetchedBlob = await fileRes.blob();
      let finalBlob = fetchedBlob;

      if (serverMetadata.isCompressed) {
        setAppMessageFx(`Decompressing Cloud file ${serverMetadata.filename}...`, 'info', 0);
        try {
          const arrayBuffer = await finalBlob.arrayBuffer();
          const decompressedData = pako.inflate(new Uint8Array(arrayBuffer));
          finalBlob = new Blob([decompressedData], { type: serverMetadata.contentType });
        } catch (decompError) {
          throw new Error(`Failed to decompress file: ${decompError instanceof Error ? decompError.message : String(decompError)}`);
        }
      }
      setAppMessageFx(`Preparing ${serverMetadata.filename} for download...`, 'info', 0);
      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement('a'); a.href = url; a.download = serverMetadata.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      setAppMessageFx(`${serverMetadata.filename} Cloud download started.`, 'success');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setAppMessageFx(`Cloud Download failed: ${errorMsg}`, 'error', 0);
      console.error("Cloud Download Error:", error);
    } finally {
      setIsDownloadingR2(false);
    }
  };

  const handleDeleteR2File = async (filename: string) => {
    if (!window.confirm(`Are you sure you want to delete ${filename} from Cloud storage?`)) return;
    setIsDeletingR2(filename); setAppMessageFx(`Deleting ${filename} from Cloud...`, 'info', 0);
    try {
      // ... (rest of handleDeleteR2File logic, using setAppMessageFx)
      const response = await fetch(`/api/files/${filename}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || `Failed to delete ${filename} (HTTP ${response.status})`);
      }
      setCloudFiles(prevFiles => prevFiles.filter(file => file.filename !== filename));
      setAppMessageFx(data.message || `File ${filename} deleted successfully from Cloud.`, 'success');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setAppMessageFx(`Error deleting Cloud file ${filename}: ${errorMsg}`, 'error', 0);
      console.error(`Error deleting Cloud file ${filename}:`, error);
    } finally {
      setIsDeletingR2(null);
    }
  };
  
  const performP2PSendAndUpdateState = async (service: P2PService, file: File, onProgress: (progress: number, stepMessage?: string) => void, onComplete: () => void, onError: (errorMsg: string) => void) => {
    setP2PFileTransferProgress({ type: 'send' as const, filename: file.name, progress: 0 });
    try {
      onProgress(0, `Preparing to send ${file.name} via P2P...`);
      let fileDataForSending: ArrayBuffer;
      let isCompressedForP2P = false;
      const originalFileType = file.type || 'application/octet-stream';

      try {
        if (shouldCompress(file)) {
          onProgress(-1, `Compressing ${file.name}...`); 
          const fileBuffer = await file.arrayBuffer();
          fileDataForSending = pako.deflate(fileBuffer).buffer;
          isCompressedForP2P = true;
        } else {
          fileDataForSending = await file.arrayBuffer();
        }
      } catch (procError) {
        throw new Error(`File processing/compression error: ${procError instanceof Error ? procError.message : String(procError)}`);
      }
      const fileSizeForSending = fileDataForSending.byteLength;
      
      service.send(JSON.stringify({
        type: 'file-meta',
        payload: { name: file.name, size: fileSizeForSending, type: originalFileType, isCompressed: isCompressedForP2P }
      }));
      onProgress(0, `Sending metadata for ${file.name}...`); 

      let offset = 0;
      onProgress(0, `Sending ${file.name} in chunks...`);
      while (offset < fileSizeForSending) {
        const chunk = fileDataForSending.slice(offset, offset + CHUNK_SIZE);
        service.send(chunk);
        offset += chunk.byteLength;
        const progress = Math.round((offset / fileSizeForSending) * 100);
        onProgress(progress); 
        setP2PFileTransferProgress(prev => (prev?.filename === file.name && prev.type === 'send' ? {...prev, progress} : prev));
      }
      service.send(JSON.stringify({ type: 'file-end', payload: { name: file.name } }));
      onComplete();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      onError(`Error sending P2P file: ${errorMsg}`);
    }
  };

  const resetP2PReceiveStates = (errorMessage?: string, p2pContext?: 'manual' | 'share_flow_receiver') => {
    if (p2pReceiveTimeoutIdRef.current) { clearTimeout(p2pReceiveTimeoutIdRef.current); p2pReceiveTimeoutIdRef.current = null; }
    setP2PReceivingFileMeta(null); setP2PReceivedFileChunks([]); setP2PFileTransferProgress(null);
    if (errorMessage) {
        const systemMessageText = `System (${p2pContext || 'P2P'}): ${errorMessage}`;
        const systemMessage = { timestamp: Date.now(), data: systemMessageText, sender: 'system' as const };
        if (p2pContext === 'manual') {
            setManualP2PReceivedMessages(prev => [...prev, systemMessage]);
        }
        setAppMessageFx(errorMessage, 'error', 0);
    }
  };
  
  const commonP2POnDataHandler = async (data: any, p2pContext: 'manual' | 'share_flow_receiver') => {
    // ... (commonP2POnDataHandler logic, using setAppMessageFx for user-facing errors/success)
    const currentP2PService = p2pContext === 'manual' ? manualP2PService : shareP2PServiceInstance;
    if (!currentP2PService) return;

    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message.type === 'file-meta' && message.payload) {
          if (p2pReceiveTimeoutIdRef.current) clearTimeout(p2pReceiveTimeoutIdRef.current);
          setP2PReceivingFileMeta(message.payload as P2PFileMeta);
          setP2PReceivedFileChunks([]);
          setP2PFileTransferProgress({ type: 'receive', filename: message.payload.name, progress: 0 });
          setManualP2PReceivedMessages(prev => [...prev, { timestamp: Date.now(), data: `System (${p2pContext}): Receiving file ${message.payload.name} (${message.payload.size} bytes, Type: ${message.payload.type}, Compressed: ${message.payload.isCompressed})`, sender: 'system' }]);
          p2pReceiveTimeoutIdRef.current = setTimeout(() => resetP2PReceiveStates(`P2P file transfer for ${message.payload.name} timed out.`, p2pContext), P2P_RECEIVE_TIMEOUT_MS);
        } else if (message.type === 'file-end' && p2pReceivingFileMeta && message.payload && message.payload.name === p2pReceivingFileMeta.name) {
          if (p2pReceiveTimeoutIdRef.current) clearTimeout(p2pReceiveTimeoutIdRef.current);
          p2pReceiveTimeoutIdRef.current = null;
          
          const currentReceivingFile = p2pReceivingFileMeta; 
          setAppMessageFx(`P2P File ${currentReceivingFile.name} chunks received. Processing...`, 'info', 0);
          const fullFileBlob = new Blob(p2pReceivedFileChunks, { type: currentReceivingFile.type });
          let finalBlob = fullFileBlob;

          if (currentReceivingFile.isCompressed) {
            setAppMessageFx(`Decompressing P2P file ${currentReceivingFile.name}...`, 'info', 0);
            try {
                const arrayBuffer = await finalBlob.arrayBuffer();
                const decompressed = pako.inflate(new Uint8Array(arrayBuffer));
                finalBlob = new Blob([decompressed], { type: currentReceivingFile.type });
                setAppMessageFx(`P2P file ${currentReceivingFile.name} decompressed.`, 'success');
            } catch (e) {
                resetP2PReceiveStates(`Error decompressing file ${currentReceivingFile.name}: ${e instanceof Error ? e.message : String(e)}`, p2pContext);
                return;
            }
          }
          const url = URL.createObjectURL(finalBlob);
          const a = document.createElement('a'); a.href = url; a.download = currentReceivingFile.name;
          document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          setManualP2PReceivedMessages(prev => [...prev, { timestamp: Date.now(), data: `System (${p2pContext}): File ${currentReceivingFile.name} received & download started.`, sender: 'system' }]);
          setAppMessageFx(`P2P File ${currentReceivingFile.name} downloaded.`, 'success');
          resetP2PReceiveStates(undefined, p2pContext);
        } else if (message.type === 'text') { 
          setManualP2PReceivedMessages(prev => [...prev, { timestamp: Date.now(), data: message.payload, sender: 'peer' }]);
        } else if (message.type === 'r2-file-share' && message.payload) {
          const r2Metadata = message.payload as FileMetadata;
          setManualP2PReceivedMessages(prev => [...prev, {timestamp: Date.now(), data: `Peer is sharing a cloud file: ${r2Metadata.filename}. Starting download...`, sender: 'system'}]);
          await handleDownloadR2(r2Metadata);
        } else { 
          setManualP2PReceivedMessages(prev => [...prev, { timestamp: Date.now(), data: `Peer (${p2pContext}): ${JSON.stringify(message)}`, sender: 'peer' }]);
        }
      } catch (e) { 
        setManualP2PReceivedMessages(prev => [...prev, { timestamp: Date.now(), data: data, sender: 'peer' }]);
      }
    } else if (data instanceof ArrayBuffer) {
      if (p2pReceivingFileMeta) {
        if (p2pReceiveTimeoutIdRef.current) clearTimeout(p2pReceiveTimeoutIdRef.current);
        const currentChunks = [...p2pReceivedFileChunks, data];
        setP2PReceivedFileChunks(currentChunks);
        const currentSize = currentChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const progress = Math.round((currentSize / p2pReceivingFileMeta.size) * 100);
        setP2PFileTransferProgress({ type: 'receive', filename: p2pReceivingFileMeta.name, progress });
        if (currentSize < p2pReceivingFileMeta.size) {
             p2pReceiveTimeoutIdRef.current = setTimeout(() => resetP2PReceiveStates(`P2P file transfer for ${p2pReceivingFileMeta.name} timed out waiting for more chunks.`, p2pContext), P2P_RECEIVE_TIMEOUT_MS);
        } else { 
             p2pReceiveTimeoutIdRef.current = setTimeout(() => resetP2PReceiveStates(`P2P file transfer for ${p2pReceivingFileMeta.name} timed out waiting for file-end message.`, p2pContext), P2P_RECEIVE_TIMEOUT_MS / 2);
        }
      } else {
        console.warn(`P2P (${p2pContext}): Received ArrayBuffer chunk but no file metadata is set.`);
      }
    } else {
        console.log(`P2P (${p2pContext}): Received unknown data type:`, data);
    }
  };

  const startManualP2P = (isInitiator: boolean) => {
    // ... (startManualP2P logic using setAppMessageFx for feedback)
    if (!manualP2PRoomIdInput.trim()) { setAppMessageFx('Please enter a Room ID for manual P2P.', 'error'); return; }
    if (manualP2PService) { manualP2PService.destroy(); }
    setManualP2PService(null); 
    setManualP2PCurrentRoomId(manualP2PRoomIdInput);
    setManualP2PConnectionStatus('connecting'); setManualP2PReceivedMessages([]);
    setAppMessageFx(`Manual P2P: Attempting to ${isInitiator ? 'create' : 'join'} room '${manualP2PRoomIdInput}'...`, 'info', 0);
    resetP2PReceiveStates(undefined, 'manual');

    const service = new P2PService({
      roomId: manualP2PRoomIdInput, initiator: isInitiator,
      onSignal: () => {},
      onConnect: () => {
        setManualP2PConnectionStatus('connected');
        setManualP2PReceivedMessages(prev => [...prev, { timestamp: Date.now(), data: "Manual P2P Connected!", sender: 'system' }]);
        setAppMessageFx(`Manual P2P: Connected to room '${manualP2PCurrentRoomId || manualP2PRoomIdInput}'`, 'success');
      },
      onData: (data: any) => commonP2POnDataHandler(data, 'manual'),
      onError: (err: Error) => {
        console.error('Manual P2P Error:', err); setManualP2PConnectionStatus('failed');
        const errorText = `Manual P2P Error: ${err.message}.`;
        setManualP2PReceivedMessages(prev => [...prev, { timestamp: Date.now(), data: errorText, sender: 'system' }]);
        setAppMessageFx(errorText, 'error', 0);
        if (manualP2PService === service) setManualP2PService(null);
      },
      onClose: () => {
        setManualP2PConnectionStatus('disconnected');
        setManualP2PReceivedMessages(prev => [...prev, { timestamp: Date.now(), data: "Manual P2P Disconnected.", sender: 'system' }]);
        setAppMessageFx(`Manual P2P: Disconnected from room '${manualP2PCurrentRoomId || manualP2PRoomIdInput}'`, 'info');
        if (manualP2PService === service) setManualP2PService(null); 
        resetP2PReceiveStates(undefined, 'manual');
      },
    });
    setManualP2PService(service);
  };

  const handleManualP2PFileSelect = (event: ChangeEvent<HTMLInputElement>) => { setFileForManualP2P(event.target.files?.[0] || null); setAppMessageFx('', 'info', 0); };
  
  const handleNewLocalFileSelectedForShare = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      initiateShareProcess(event.target.files[0]);
    }
    if (event.target) event.target.value = ''; 
  };

  const initiateShareProcess = (item: File | FileMetadata) => {
    setItemToShare(item);
    setShareTargetRoomIdInput(''); 
    setShareFlowMessage('Enter a Room ID to share this item with.'); // Use shareFlowMessage for this context
    setShareFlowStep('awaiting_room_id');
    setP2PFileTransferProgress(null);
    setAppMessageFx('', 'info', 0);
  };

  const cancelShareProcess = () => {
    setItemToShare(null);
    setShareTargetRoomIdInput('');
    setShareFlowMessage('Share cancelled by user.');
    setShareFlowStep('idle');
    if (shareP2PServiceInstance) {
        shareP2PServiceInstance.destroy();
        setShareP2PServiceInstance(null);
    }
    if (shareP2PTimeoutIdRef.current) {
        clearTimeout(shareP2PTimeoutIdRef.current);
        shareP2PTimeoutIdRef.current = null;
    }
    setP2PFileTransferProgress(null);
    setTimeout(() => setShareFlowMessage(''), APP_MESSAGE_TIMEOUT_MS);
  };

  const handleSendManualP2PMessage = () => {
    if (manualP2PService && manualP2PMessageInput.trim() && manualP2PConnectionStatus === 'connected') {
      const messagePayload = { type: 'text', payload: manualP2PMessageInput };
      manualP2PService.send(JSON.stringify(messagePayload));
      setManualP2PReceivedMessages(prev => [...prev, { timestamp: Date.now(), data: manualP2PMessageInput, sender: 'me' }]);
      setManualP2PMessageInput('');
    } else {
      setAppMessageFx("Manual P2P not connected or message is empty.", 'error');
    }
  };
  
  const handleSendManualP2PFile = async () => {
    if (!manualP2PService || manualP2PConnectionStatus !== 'connected') { setAppMessageFx('Manual P2P not connected.', 'error'); return; }
    if (!fileForManualP2P) { setAppMessageFx('Please select a file for manual P2P transfer.', 'error'); return; }
    
    setShareFlowMessage(''); 
    setAppMessageFx(`Manual P2P: Preparing file ${fileForManualP2P.name}...`, 'info', 0);
    await performP2PSendAndUpdateState(manualP2PService, fileForManualP2P, 
      (progress, stepMsg) => {
        setP2PFileTransferProgress({ type: 'send', filename: fileForManualP2P!.name, progress });
        if(stepMsg) setAppMessageFx(`Manual P2P: ${stepMsg}`, 'info', 0);
        else if (progress >= 0) setAppMessageFx(`Manual P2P: Sending ${fileForManualP2P!.name} ${progress}%...`, 'info', 0);
      },
      () => {
        setAppMessageFx(`Manual P2P: File ${fileForManualP2P!.name} sent successfully.`, 'success');
        setP2PFileTransferProgress(null); 
        setFileForManualP2P(null);
        const p2pFileInp = document.getElementById('manual-p2p-file-input') as HTMLInputElement;
        if(p2pFileInp) p2pFileInp.value = '';
      },
      (errorMsg) => { 
        setAppMessageFx(`Manual P2P: ${errorMsg}`, 'error', 0); 
        setP2PFileTransferProgress(null);
      }
    );
  };

  const executeShareAttempt = async (item: File | FileMetadata | null, targetRoomId: string) => {
    // ... (executeShareAttempt using setShareFlowMessage for its specific feedback, and setAppMessageFx for major errors/success)
    if (!item) { setShareFlowMessage("Error: No item selected for sharing."); setAppMessageFx("Share Error: No item selected.", "error"); setShareFlowStep('idle'); return; }
    if (!targetRoomId.trim()) { setShareFlowMessage('Target Room ID is required for sharing.'); return; }

    if (shareP2PServiceInstance) shareP2PServiceInstance.destroy();
    if (shareP2PTimeoutIdRef.current) clearTimeout(shareP2PTimeoutIdRef.current);
    
    const isDirectFileShare = item instanceof File;
    const initialStep = isDirectFileShare ? 'p2p_attempt' : 'p2p_r2_pointer_attempt';
    setShareFlowStep(initialStep);
    setShareFlowMessage(`Share: Attempting P2P to room '${targetRoomId}'...`);
    resetP2PReceiveStates(undefined, 'share_flow_receiver');

    const service = new P2PService({
      roomId: targetRoomId, initiator: true,
      onSignal: () => {},
      onConnect: async () => {
        if (shareP2PTimeoutIdRef.current) clearTimeout(shareP2PTimeoutIdRef.current);
        shareP2PTimeoutIdRef.current = null;
        if (shareFlowStep !== 'p2p_attempt' && shareFlowStep !== 'p2p_r2_pointer_attempt') return;

        setShareFlowStep('p2p_connected_for_action');
        setShareFlowMessage(`Share: P2P connected to room '${targetRoomId}'. Preparing to send...`);
        
        if (isDirectFileShare) {
            setShareFlowStep('p2p_direct_transfer');
            try {
                await performP2PSendAndUpdateState(service, item as File, 
                    (progress, stepMsg) => {
                        setP2PFileTransferProgress({ type: 'send', filename: (item as File).name, progress });
                        if(stepMsg) setShareFlowMessage(`Share P2P: ${stepMsg}`); else setShareFlowMessage(`Share P2P: Sending ${progress}%...`);
                    },
                    () => { // onComplete
                        setShareFlowMessage(`Share: File '${(item as File).name}' sent successfully via P2P!`);
                        setAppMessageFx(`File '${(item as File).name}' shared successfully via P2P.`, "success");
                        setShareFlowStep('share_complete_success');
                        setShowShareTargetInputFor(null); setShareTargetRoomIdInput(''); 
                        service.destroy(); setShareP2PServiceInstance(null);
                        setP2PFileTransferProgress(null);
                    },
                    (errorMsg) => { // onError for performP2PSend
                        setShareFlowMessage(`Share: P2P file send failed. ${errorMsg}. Offering Cloud fallback.`);
                        setShareFlowStep('p2p_direct_transfer_failed_offer_r2');
                        service.destroy(); setShareP2PServiceInstance(null);
                        setP2PFileTransferProgress(null);
                    }
                );
            } catch (e) {
                setShareFlowMessage(`Share: P2P file send critical error. ${e instanceof Error ? e.message : String(e)}. Offering Cloud fallback.`);
                setShareFlowStep('p2p_direct_transfer_failed_offer_r2');
                service.destroy(); setShareP2PServiceInstance(null);
                setP2PFileTransferProgress(null);
            }
        } else { // R2 File Pointer Share
            service.send(JSON.stringify({ type: 'r2-file-share', payload: item }));
            setShareFlowStep('p2p_r2_pointer_sent');
            setShareFlowMessage(`Share: Pointer for '${(item as FileMetadata).filename}' sent to room '${targetRoomId}'.`);
            setAppMessageFx(`Pointer for Cloud file '${(item as FileMetadata).filename}' sent via P2P.`, "success");
            setTimeout(() => { 
                if(shareP2PServiceInstance === service) {
                    service.destroy(); 
                    if (shareFlowStep === 'p2p_r2_pointer_sent') setShareFlowStep('share_complete_success');
                }
            }, 3000); 
        }
      },
      onData: (data: any) => commonP2POnDataHandler(data, 'share_flow_receiver'),
      onError: (err: Error) => {
        if (shareP2PTimeoutIdRef.current) clearTimeout(shareP2PTimeoutIdRef.current);
        shareP2PTimeoutIdRef.current = null;
        const failureStep = isDirectFileShare ? 'p2p_direct_transfer_failed_offer_r2' : 'share_failed';
        const userMessage = `Share: P2P connection error: ${err.message}. ${isDirectFileShare ? 'Offering Cloud fallback.' : 'Pointer share failed.'}`;
        setShareFlowMessage(userMessage);
        setAppMessageFx(userMessage, 'error', 0);
        setShareFlowStep(failureStep);
        service.destroy(); 
        if(shareP2PServiceInstance === service) setShareP2PServiceInstance(null);
        setP2PFileTransferProgress(null);
      },
      onClose: () => {
        if (shareP2PTimeoutIdRef.current) clearTimeout(shareP2PTimeoutIdRef.current);
        shareP2PTimeoutIdRef.current = null;
        const failureStep = isDirectFileShare ? 'p2p_direct_transfer_failed_offer_r2' : 'share_failed';
        if (shareFlowStep === 'p2p_attempt' || shareFlowStep === 'p2p_connected_for_action' || shareFlowStep === 'p2p_direct_transfer' || shareFlowStep === 'p2p_r2_pointer_attempt' || shareFlowStep === 'p2p_r2_pointer_send') {
          const userMessage = `Share: P2P connection closed. ${isDirectFileShare ? 'Offering Cloud fallback.' : 'Pointer share failed.'}`;
          setShareFlowMessage(userMessage);
          setAppMessageFx(userMessage, 'error', 0);
          setShareFlowStep(failureStep);
        }
        if(shareP2PServiceInstance === service) setShareP2PServiceInstance(null);
        setP2PFileTransferProgress(null);
      },
    });
    setShareP2PServiceInstance(service);

    shareP2PTimeoutIdRef.current = setTimeout(() => {
      if (shareP2PServiceInstance === service && (shareFlowStep === 'p2p_attempt' || shareFlowStep === 'p2p_connected_for_action' || shareFlowStep === 'p2p_r2_pointer_attempt')) {
        const currentItemBeingShared = itemToShare; 
        const failureStep = (currentItemBeingShared instanceof File) ? 'p2p_direct_transfer_failed_offer_r2' : 'share_failed';
        const userMessage = `Share: P2P connection attempt timed out. ${failureStep === 'p2p_direct_transfer_failed_offer_r2' ? 'Offering Cloud fallback.' : 'Pointer share failed.'}`;
        setShareFlowMessage(userMessage);
        setAppMessageFx(userMessage, 'error', 0);
        service.destroy();
        setShareFlowStep(failureStep);
      }
      shareP2PTimeoutIdRef.current = null;
    }, P2P_CONNECT_TIMEOUT_MS);
  };

  const handleShareR2Fallback = async () => {
    if (!(itemToShare instanceof File)) {
      setAppMessageFx('Share Error: No local file was selected for Cloud fallback.', 'error', 0);
      setShareFlowStep('idle'); return;
    }
    const fileToUpload = itemToShare;
    setShareFlowStep('r2_fallback_upload');
    setShareFlowMessage(`Share: Uploading '${fileToUpload.name}' to Cloud as fallback...`);
    setP2PFileTransferProgress(null); 
    
    try {
      const uploadedMetadata = await performR2Upload(fileToUpload, (stepMsg, isError) => setShareFlowMessage(isError ? `Cloud Fallback Error: ${stepMsg}`: `Cloud Fallback: ${stepMsg}`));
      setShareFlowMessage(`Share: File '${uploadedMetadata.filename}' successfully uploaded to Cloud (fallback).`);
      setAppMessageFx(`File '${uploadedMetadata.filename}' shared via Cloud fallback.`, 'success');
      setShowShareTargetInputFor(null);
      setShareTargetRoomIdInput('');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      setShareFlowMessage(`Share: Cloud fallback upload failed: ${errorMsg}`); // This message might be redundant if performR2Upload sets it via callback
      setAppMessageFx(`Cloud fallback upload failed: ${errorMsg}`, 'error', 0);
    } finally {
      setShareFlowStep('idle'); 
    }
  };
  
  const cancelP2PFileReceive = () => {
    resetP2PReceiveStates("P2P file reception cancelled by user.", manualP2PConnectionStatus === 'connected' ? 'manual' : 'share_flow_receiver');
  };

  return (
    <div id="root-app-container">
      <h1>Cloud P2P Share</h1>
      
      {overallAppMessage && (
        <div className={`message-section app-message ${overallAppMessage.type}`}>
          <p><strong>{overallAppMessage.type.toUpperCase()}:</strong> {overallAppMessage.text}</p>
          {(overallAppMessage.type === 'error' || overallAppMessage.text.length > 100) && /* Show close for errors or long messages */
            <button onClick={() => setOverallAppMessage(null)} className="close-message-btn">X</button>
          }
        </div>
      )}

      <details open className="section-details">
        <summary><h2>My Cloud Files</h2></summary>
        <div className="section-container">
          <div className="file-input-section">
            <h3>Upload New File to Cloud</h3>
            <input type="file" id="direct-r2-file-input" onChange={handleDirectR2FileSelect} disabled={isUploadingToR2 || shareFlowStep === 'r2_fallback_upload'} />
            <button onClick={handleDirectR2Upload} disabled={!selectedFileForR2 || isUploadingToR2 || shareFlowStep === 'r2_fallback_upload'}>
              {isUploadingToR2 ? `Processing... ${r2UploadStepMessage || ''}` : 'Upload to Cloud'}
            </button>
            {isUploadingToR2 && r2UploadStepMessage && <p className="info">{r2UploadStepMessage}</p>}
          </div>
          <h3>Available Cloud Files</h3>
          {initialCloudFilesLoading && <p className="info">{initialCloudFilesLoading}</p>}
          {cloudFiles.length === 0 && !initialCloudFilesLoading ? ( <p>No Cloud files yet.</p> ) : (
            <ul className="file-list"> {cloudFiles.map((file) => ( <li key={file.filename} className="file-list-item">
                <div className="file-info">
                  {file.filename}
                  <span className="file-details">
                    (Type: {file.contentType}, Size: {file.size} bytes
                    {file.isCompressed && file.originalSize ? ` (Original: ${file.originalSize} bytes, Compressed)` : (file.isCompressed ? ' (Compressed)' : '')})
                    Uploaded: {new Date(file.uploadedAt).toLocaleString()}
                  </span>
                </div>
                <div className="file-actions">
                  <button onClick={() => handleDownloadR2(file)} disabled={isDownloadingR2 || !!isDeletingR2 || shareFlowStep !== 'idle'} style={{marginRight: '5px'}}>Download</button>
                  <button onClick={() => handleDeleteR2File(file.filename)} disabled={isDeletingR2 === file.filename || isDownloadingR2 || shareFlowStep !== 'idle'} style={{marginRight: '5px', backgroundColor: '#dc3545'}}>
                    {isDeletingR2 === file.filename ? 'Deleting...' : 'Delete'}
                  </button>
                  <button onClick={() => initiateShareProcess(file)} disabled={shareFlowStep !== 'idle'} style={{marginRight: '5px'}}>Share Cloud File</button>
                </div>
              </li> ))} </ul>
          )}
        </div>
      </details>

      <hr style={{margin: "20px 0"}}/>
      
      <details className="section-details" open={itemToShare !== null || (shareFlowStep !== 'idle' && shareFlowStep !== 'share_complete_success') }>
          <summary><h2>Share a File (Unified Flow)</h2></summary>
          <div className="section-container unified-share-section">
              {!itemToShare && shareFlowStep === 'idle' && (
                 <button onClick={() => localFileShareInputRef.current?.click()} style={{marginBottom: '10px'}}>
                    Select Local File to Share...
                </button>
              )}
              <input type="file" ref={localFileShareInputRef} style={{ display: 'none' }} onChange={handleNewLocalFileSelectedForShare} 
                     onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
              />

              {itemToShare && (shareFlowStep === 'awaiting_room_id' || shareFlowStep === 'idle' || shareFlowStep === 'p2p_direct_transfer_failed_offer_r2' || shareFlowStep === 'share_failed') && (
              <div className="share-target-input-section">
                  <h4>Sharing: {itemToShare instanceof File ? itemToShare.name : itemToShare.filename}</h4>
                  <input 
                      type="text" 
                      placeholder="Enter Room ID for Sharing" 
                      value={shareTargetRoomIdInput} 
                      onChange={(e) => setShareTargetRoomIdInput(e.target.value)} 
                      disabled={shareFlowStep === 'p2p_direct_transfer_failed_offer_r2'}
                  />
                  <button onClick={() => executeShareAttempt(itemToShare, shareTargetRoomIdInput)} disabled={!shareTargetRoomIdInput.trim() || (shareFlowStep !== 'awaiting_room_id' && shareFlowStep !== 'idle' && shareFlowStep !== 'p2p_direct_transfer_failed_offer_r2' && shareFlowStep !== 'share_failed')}>
                      Start Share
                  </button>
                  <button onClick={cancelShareProcess} disabled={shareFlowStep === 'p2p_direct_transfer' || shareFlowStep === 'r2_fallback_upload'}>
                      Cancel Current Share
                  </button>
              </div>
              )}

              {shareFlowMessage && <p className="info">Share Status: {shareFlowMessage}</p>}
          
              {(shareFlowStep === 'p2p_direct_transfer' || shareFlowStep === 'p2p_connect_attempt' || shareFlowStep === 'p2p_connected_for_action') && p2pFileTransferProgress && p2pFileTransferProgress.type === 'send' && (
              <div>
                  <p>P2P Direct Share Progress ({p2pFileTransferProgress.filename}): {p2pFileTransferProgress.progress === -1 ? "Compressing..." : `${p2pFileTransferProgress.progress}%`}</p>
                  {p2pFileTransferProgress.progress >= 0 && <progress value={p2pFileTransferProgress.progress} max="100"></progress> }
                  {p2pFileTransferProgress.progress >= 0 && <span> {p2pFileTransferProgress.progress}%</span>}
              </div>
              )}
              {shareFlowStep === 'r2_fallback_upload' && r2UploadStepMessage && (
                  <p className="info">Cloud Fallback Upload: {r2UploadStepMessage}</p>
              )}

              {shareFlowStep === 'p2p_direct_transfer_failed_offer_r2' && itemToShare instanceof File && (
              <div className="fallback-offer">
                  <p>P2P direct transfer failed. Upload to Cloud for link sharing instead?</p>
                  <button onClick={handleShareR2Fallback} style={{marginRight: '10px'}}>Yes, Upload to Cloud</button>
                  <button onClick={cancelShareProcess}>No, Cancel Share</button>
              </div>
              )}
               {shareFlowStep === 'share_failed' && (
                  <p className="error-message">Share operation failed. Please check the room ID or try again.</p>
              )}
              {shareFlowStep === 'share_complete_success' && !shareFlowMessage &&(
                  <p className="success-message">Share operation completed successfully!</p>
              )}
          </div>
      </details>
      
      <hr style={{margin: "20px 0"}}/>

      <details className="section-details">
        <summary><h2>Manual P2P Connection & Transfer</h2></summary>
        <div className="section-container">
          <div>
            <input type="text" placeholder="Enter Room ID" value={manualP2PRoomIdInput} onChange={(e) => setManualP2PRoomIdInput(e.target.value)} disabled={manualP2PConnectionStatus === 'connecting' || manualP2PConnectionStatus === 'connected'}/>
            <button onClick={() => startManualP2P(true)} disabled={!manualP2PRoomIdInput || manualP2PConnectionStatus === 'connecting' || manualP2PConnectionStatus === 'connected'}>Create & Start Manual P2P</button>
            <button onClick={() => startManualP2P(false)} disabled={!manualP2PRoomIdInput || manualP2PConnectionStatus === 'connecting' || manualP2PConnectionStatus === 'connected'}>Join & Start Manual P2P</button>
          </div>
          <p>Manual P2P Status: <span className={`status-${manualP2PConnectionStatus}`}>{manualP2PConnectionStatus}</span></p>
          {manualP2PCurrentRoomId && <p>Current Manual P2P Room: {manualP2PCurrentRoomId}</p>}
        </div>

        {manualP2PConnectionStatus === 'connected' && (
          <div className="section-container">
            <h3>Manual P2P Actions (Room: {manualP2PCurrentRoomId})</h3>
            <div className="p2p-actions-subsection">
              <h4>P2P File Transfer</h4>
              <input type="file" id="manual-p2p-file-input" onChange={handleManualP2PFileSelect} />
              <button onClick={handleSendManualP2PFile} disabled={!fileForManualP2P || (p2pFileTransferProgress?.type === 'send' && p2pFileTransferProgress?.filename === fileForManualP2P?.name) }>
                {(p2pFileTransferProgress?.type === 'send' && p2pFileTransferProgress.filename === fileForManualP2P?.name) ? `Sending (${p2pFileTransferProgress.progress === -1 ? "Compressing" : p2pFileTransferProgress.progress + "%"})` : 'Send File via Manual P2P'}
              </button>
              {fileForManualP2P && !(p2pFileTransferProgress?.type === 'send' && p2pFileTransferProgress.filename === fileForManualP2P?.name) && <p>Selected P2P file: {fileForManualP2P.name}</p>}
              
              {p2pFileTransferProgress && ( (p2pFileTransferProgress.type === 'receive' && p2pReceivingFileMeta) ) && (
                <div>
                  <p>Receiving file: {p2pFileTransferProgress.filename} {p2pFileTransferProgress.progress === -1 ? "(Preparing...)" : ""}</p>
                  {p2pFileTransferProgress.progress >=0 && <progress value={p2pFileTransferProgress.progress} max="100"></progress> }
                  {p2pFileTransferProgress.progress >=0 && <span> {p2pFileTransferProgress.progress}%</span> }
                   {p2pFileTransferProgress.type === 'receive' && <button onClick={cancelP2PFileReceive} style={{marginLeft: '10px'}}>Cancel Receive</button>}
                </div>
              )}
            </div>
            <div className="p2p-actions-subsection">
              <h4>P2P Text Messaging</h4>
              <input type="text" placeholder="Enter message" value={manualP2PMessageInput} onChange={(e) => setManualP2PMessageInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleSendManualP2PMessage()}/>
              <button onClick={handleSendManualP2PMessage} disabled={!manualP2PMessageInput.trim()}>Send Message</button>
              <div className="p2p-messages-display" ref={manualP2PReceivedMessagesRef}>
                <h5>Manual P2P Messages:</h5>
                {manualP2PReceivedMessages.length === 0 ? <p>No messages yet.</p> : 
                  manualP2PReceivedMessages.map((msg, index) => (
                    <p key={index} className={`message-${msg.sender || 'system'}`}>
                      <em><small>{new Date(msg.timestamp).toLocaleTimeString()}{msg.sender === 'me' ? ' (Me)' : msg.sender === 'peer' ? ' (Peer)' : ' (System)'}:</small></em> {msg.data}
                    </p>
                  ))
                }
              </div>
            </div>
          </div>
        )}
      </details>

    </div>
  );
}

export default App;
