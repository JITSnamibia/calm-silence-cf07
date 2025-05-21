import { Hono } from "hono";
// stream is not needed anymore as we are not streaming from the worker directly
// import { stream } from 'hono/streaming'; 

// The Env interface will be implicitly defined by worker-configuration.d.ts
// interface Env {
//   YOUR_R2_BUCKET: R2Bucket;
//   FILE_METADATA_KV: KVNamespace;
//   SIGNALING_ROOM_DO: DurableObjectNamespace; 
// }

const app = new Hono<{ Bindings: Env }>();

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));

// New endpoint to initiate a file upload and get a pre-signed URL
app.post('/api/files/initiate-upload', async (c) => {
  try {
    const { filename, contentType } = await c.req.json<{ filename: string, contentType: string }>();

    if (!filename) {
      return c.json({ success: false, message: 'Filename is required' }, 400);
    }
    if (!contentType) {
      return c.json({ success: false, message: 'ContentType is required' }, 400);
    }

    const presignedUrl = await c.env.YOUR_R2_BUCKET.createPresignedUrl(filename, {
      method: 'PUT',
      expires: 3600, // 1 hour
      httpMetadata: { contentType }, 
    });

    return c.json({ success: true, url: presignedUrl, filename });
  } catch (error) {
    console.error('Failed to create presigned URL for upload:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json({ success: false, message: 'Failed to initiate upload', error: errorMessage }, 500);
  }
});

// New endpoint to finalize file upload by saving metadata
app.post('/api/files/finalize-upload', async (c) => {
  try {
    const { filename, contentType, size, isCompressed } = await c.req.json<{ filename: string, contentType: string, size: number, isCompressed: boolean }>();

    if (!filename || !contentType || typeof size !== 'number' || typeof isCompressed !== 'boolean') {
      return c.json({ success: false, message: 'Missing or invalid parameters: filename, contentType, size, and isCompressed are required.' }, 400);
    }

    const metadata = {
      filename, // Storing filename in metadata for easier access if key is opaque
      uploadedAt: new Date().toISOString(),
      contentType,
      size,
      isCompressed,
    };

    await c.env.FILE_METADATA_KV.put(filename, JSON.stringify(metadata));

    return c.json({ success: true, message: "File metadata finalized successfully" }, 201);
  } catch (error) {
    console.error('Failed to finalize upload (KV put error):', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json({ success: false, message: 'Failed to save file metadata', error: errorMessage }, 500);
  }
});

// Endpoint to list all file metadata from KV
app.get("/api/files", async (c) => {
  try {
    const listResult = await c.env.FILE_METADATA_KV.list();
    const filesMetadata = [];

    for (const key of listResult.keys) {
      // Using key.name as the KV key where metadata is stored
      const metadata = await c.env.FILE_METADATA_KV.get<object>(key.name, "json");
      if (metadata) {
        filesMetadata.push(metadata);
      } else {
        console.warn(`Metadata for key '${key.name}' was null or not valid JSON.`);
      }
    }

    return c.json({ success: true, files: filesMetadata });
  } catch (error) {
    console.error("Failed to list files from KV:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json(
      { success: false, message: "Failed to retrieve file list from KV", error: errorMessage },
      500
    );
  }
});

// Modified endpoint to request a pre-signed URL for downloading a file
app.get("/api/files/request-download/:filename", async (c) => {
  try {
    const filename = c.req.param("filename");
    if (!filename) {
        return c.json({ success: false, message: "Filename parameter is required." }, 400);
    }

    const metadataString = await c.env.FILE_METADATA_KV.get(filename);
    if (metadataString === null) {
      return c.json({ success: false, message: "File metadata not found" }, 404);
    }

    let fileMetadataFromKV;
    try {
        fileMetadataFromKV = JSON.parse(metadataString);
    } catch (e) {
        console.error("Failed to parse metadata from KV for file:", filename, e);
        return c.json({ success: false, message: "Failed to parse file metadata." }, 500);
    }
    
    const presignedUrl = await c.env.YOUR_R2_BUCKET.createPresignedUrl(filename, {
      method: 'GET',
      expires: 3600, // 1 hour
    });

    return c.json({ success: true, url: presignedUrl, metadata: fileMetadataFromKV });

  } catch (error) {
    console.error("Download request error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json(
      { success: false, message: "Failed to request download URL", error: errorMessage },
      500
    );
  }
});

// New DELETE endpoint for files
app.delete('/api/files/:filename', async (c) => {
  const filename = c.req.param('filename');
  if (!filename) {
    return c.json({ success: false, message: 'Filename is required' }, 400);
  }

  try {
    await c.env.YOUR_R2_BUCKET.delete(filename);
    await c.env.FILE_METADATA_KV.delete(filename);
    return c.json({ success: true, message: `File '${filename}' and its metadata marked for deletion.` });
  } catch (error) {
    console.error(`Failed to delete file '${filename}':`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return c.json({ success: false, message: `Failed to delete file '${filename}'.`, error: errorMessage }, 500);
  }
});


// New WebSocket signaling route
app.get('/ws/signaling/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  if (!roomId) {
    return c.text('Missing roomId parameter', 400); 
  }

  if (!c.env.SIGNALING_ROOM_DO) {
    console.error("SIGNALING_ROOM_DO binding is not available on c.env");
    return c.text('Signaling service not configured.', 500);
  }

  try {
    const id = c.env.SIGNALING_ROOM_DO.idFromName(roomId);
    const stub = c.env.SIGNALING_ROOM_DO.get(id);
    const response = await stub.fetch(c.req.raw);
    return response;
  } catch (error) {
    const err = error as Error;
    console.error(`Error in /ws/signaling/${roomId} route: ${err.message}`, err.stack);
    return c.text('Error connecting to signaling room.', 500);
  }
});

// Define an interface for the expected structure of file metadata stored in KV
interface FileMetadataForTTL {
    filename: string;
    uploadedAt: string; // ISO 8601 date string
    contentType: string;
    size: number;
    isCompressed: boolean;
}

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Cron job '${event.cron}' triggered at ${new Date(event.scheduledTime).toISOString()}`);
    
    const TTL_PERIOD_DAYS = 7; 
    const TTL_PERIOD_MS = TTL_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    let deletedCount = 0;
    let checkedCount = 0;
    let errorCount = 0;

    try {
      const listResult = await env.FILE_METADATA_KV.list();
      checkedCount = listResult.keys.length;
      console.log(`Found ${checkedCount} keys in KV to check for TTL.`);

      for (const key of listResult.keys) {
        try {
          const metadataString = await env.FILE_METADATA_KV.get(key.name);
          if (!metadataString) {
            console.warn(`No metadata string found for key: ${key.name}, skipping TTL check. This might be an orphaned KV key.`);
            // Optionally, try to delete from R2 if we assume the key name is the R2 object key
            // await env.YOUR_R2_BUCKET.delete(key.name);
            // await env.FILE_METADATA_KV.delete(key.name); // Clean up orphan KV key
            continue;
          }

          let metadata: Partial<FileMetadataForTTL>; // Use Partial as not all fields are strictly needed for TTL check
          try {
              metadata = JSON.parse(metadataString);
          } catch (e) {
              console.error(`Failed to parse metadata for KV key ${key.name}: ${e instanceof Error ? e.message : String(e)}. Value: "${metadataString.substring(0, 100)}..."`);
              // Potentially delete malformed metadata and associated R2 object if desired
              // await env.YOUR_R2_BUCKET.delete(key.name);
              // await env.FILE_METADATA_KV.delete(key.name);
              errorCount++;
              continue;
          }

          if (metadata && metadata.uploadedAt && typeof metadata.uploadedAt === 'string') {
            const uploadedDate = new Date(metadata.uploadedAt);
            // Check if uploadedDate is valid. Invalid dates result in NaN from getTime().
            if (isNaN(uploadedDate.getTime())) {
                console.warn(`Metadata for KV key '${key.name}' has an invalid 'uploadedAt' date: ${metadata.uploadedAt}. Skipping TTL check.`);
                errorCount++;
                continue;
            }

            const ageMs = Date.now() - uploadedDate.getTime();

            if (ageMs > TTL_PERIOD_MS) {
              const fileToDelete = metadata.filename || key.name; // Prefer filename from metadata if available
              console.log(`File '${fileToDelete}' (uploaded at ${metadata.uploadedAt}) is older than ${TTL_PERIOD_DAYS} days. Deleting.`);
              
              // Perform deletions and ensure they are awaited
              await env.YOUR_R2_BUCKET.delete(fileToDelete);
              await env.FILE_METADATA_KV.delete(key.name); // Use key.name for KV as that's the iterator's key
              
              deletedCount++;
            }
          } else {
            console.warn(`Metadata for KV key '${key.name}' is missing 'uploadedAt' or it's not a string. Metadata: ${JSON.stringify(metadata)}. Skipping TTL check.`);
            errorCount++;
          }
        } catch (innerError) {
            console.error(`Error processing key ${key.name} during TTL check: ${innerError instanceof Error ? innerError.message : String(innerError)}`);
            errorCount++;
        }
      }
      console.log(`Cron job finished. Checked ${checkedCount} files. Deleted ${deletedCount} expired files. Encountered ${errorCount} errors/warnings during processing.`);
    } catch (error) {
      console.error(`Fatal error during scheduled TTL deletion: ${error instanceof Error ? error.message : String(error)}`, error);
      // Depending on the error, you might want to rethrow or handle specifically
    }
  }
};
