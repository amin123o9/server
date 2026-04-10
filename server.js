require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs/promises');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const http = require('http');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'my-app-files';
const CLOUDINARY_TAG = process.env.CLOUDINARY_TAG || 'my_app_files';
const CLOUDINARY_RESOURCE_TYPES = ['image', 'video', 'raw'];
const MONGODB_URI = process.env.MONGODB_URI;
const LOCAL_DATA_STORE_PATH = path.join(__dirname, 'local-data-store.json');

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ storage: multer.memoryStorage() });
const databaseState = {
  configured: true,
  connected: false,
  lastError: '',
  mode: 'local',
};
const localStoreState = {
  ready: false,
};

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(
  cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: false,
  })
);
app.use(express.json());

mongoose.set('bufferCommands', false);
mongoose.connection.on('connected', () => {
  databaseState.connected = true;
  databaseState.lastError = '';
  databaseState.mode = 'mongo';
  console.log('Connected to MongoDB');
});
mongoose.connection.on('disconnected', () => {
  databaseState.connected = localStoreState.ready;
  databaseState.mode = localStoreState.ready ? 'local' : 'offline';
});
mongoose.connection.on('error', (error) => {
  databaseState.connected = localStoreState.ready;
  databaseState.lastError = error.message;
  databaseState.mode = localStoreState.ready ? 'local' : 'offline';
  console.warn('Remote database unavailable. Using local storage.');
});

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI).catch(() => {});
} else {
  databaseState.lastError = 'Remote database is not configured.';
}

const dataSchema = new mongoose.Schema(
  {
    title: String,
    text: String,
  },
  { timestamps: true }
);

const Data = mongoose.model('Data', dataSchema);

const createEntryId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const ensureLocalStore = async () => {
  if (localStoreState.ready) {
    return;
  }

  try {
    await fs.access(LOCAL_DATA_STORE_PATH);
  } catch (error) {
    await fs.writeFile(LOCAL_DATA_STORE_PATH, '[]', 'utf8');
  }

  localStoreState.ready = true;

  if (databaseState.mode !== 'mongo') {
    databaseState.connected = true;
    databaseState.mode = 'local';
  }
};

const readLocalEntries = async () => {
  await ensureLocalStore();
  const rawData = await fs.readFile(LOCAL_DATA_STORE_PATH, 'utf8');
  const parsedData = JSON.parse(rawData || '[]');
  return Array.isArray(parsedData) ? parsedData : [];
};

const writeLocalEntries = async (entries) => {
  await ensureLocalStore();
  await fs.writeFile(LOCAL_DATA_STORE_PATH, JSON.stringify(entries, null, 2), 'utf8');
};

const listDataEntries = async () => {
  if (databaseState.mode === 'mongo' && databaseState.connected) {
    return Data.find().sort({ createdAt: -1 }).lean();
  }

  const entries = await readLocalEntries();
  return entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

const createDataEntry = async (title, text) => {
  if (databaseState.mode === 'mongo' && databaseState.connected) {
    const newData = new Data({ title, text });
    await newData.save();
    return newData.toObject();
  }

  const entries = await readLocalEntries();
  const timestamp = new Date().toISOString();
  const entry = {
    _id: createEntryId(),
    title,
    text,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  entries.unshift(entry);
  await writeLocalEntries(entries);
  return entry;
};

const deleteDataEntry = async (id) => {
  if (databaseState.mode === 'mongo' && databaseState.connected) {
    return Data.findByIdAndDelete(id).lean();
  }

  const entries = await readLocalEntries();
  const entryIndex = entries.findIndex((entry) => entry._id === id);

  if (entryIndex === -1) {
    return null;
  }

  const [deletedEntry] = entries.splice(entryIndex, 1);
  await writeLocalEntries(entries);
  return deletedEntry;
};

const VIEWABLE_FILE_TYPES = new Set(['jpg', 'jpeg', 'png', 'gif', 'txt', 'mp4', 'pdf']);

const sanitizeBaseName = (fileName) =>
  fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);

const escapeContextValue = (value = '') =>
  value.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\|/g, '\\|');

const mapCloudinaryResource = (resource) => {
  const originalFileName = resource.context?.custom?.original_filename;
  const baseName =
    originalFileName ||
    resource.original_filename ||
    resource.filename ||
    resource.display_name ||
    resource.public_id?.split('/').pop() ||
    'file';

  const name =
    resource.format && !baseName.toLowerCase().endsWith(`.${resource.format.toLowerCase()}`)
      ? `${baseName}.${resource.format}`
      : baseName;

  return {
    id: resource.asset_id || `${resource.resource_type}-${resource.public_id}`,
    name,
    url: resource.secure_url || resource.url,
    uploadDate: resource.created_at || new Date().toISOString(),
    format: resource.format || '',
    publicId: resource.public_id,
    resourceType: resource.resource_type,
  };
};

const getFileExtension = (fileName = '') => fileName.split('.').pop().toLowerCase();

const mergeFiles = (files) => {
  const seen = new Set();

  return files.filter((file) => {
    if (seen.has(file.id)) {
      return false;
    }

    seen.add(file.id);
    return true;
  });
};

const uploadBufferToCloudinary = (file) =>
  new Promise((resolve, reject) => {
    const publicId = `${Date.now()}-${sanitizeBaseName(file.originalname || 'file')}`;

    const stream = cloudinary.uploader.upload_stream(
      {
        context: `original_filename=${escapeContextValue(file.originalname || 'file')}`,
        folder: CLOUDINARY_FOLDER,
        tags: [CLOUDINARY_TAG],
        public_id: publicId,
        resource_type: 'auto',
        use_filename: true,
        unique_filename: false,
        overwrite: false,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(
          mapCloudinaryResource({
            ...result,
            context: {
              custom: {
                original_filename: file.originalname,
              },
            },
          })
        );
      }
    );

    stream.end(file.buffer);
  });

const broadcast = (message) => {
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
};

const hasCloudinaryConfig = () =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );

const sendCloudinaryUnavailable = (res) => {
  res.status(503).json({
    error: 'File service is currently unavailable.',
  });
};

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (message) => {
    console.log('Received:', message.toString());
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    ok: true,
    cloudinaryConfigured: hasCloudinaryConfig(),
    cloudinaryFolder: CLOUDINARY_FOLDER,
    cloudinaryTag: CLOUDINARY_TAG,
    databaseConfigured: databaseState.configured,
    databaseConnected: databaseState.connected,
    databaseMode: databaseState.mode,
    databaseError: databaseState.lastError || null,
  });
});

app.post('/api/files/upload', upload.array('files'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    res.status(400).json({ error: 'No files were uploaded.' });
    return;
  }

  if (
    !hasCloudinaryConfig()
  ) {
    sendCloudinaryUnavailable(res);
    return;
  }

  try {
    const uploadedFiles = await Promise.all(req.files.map(uploadBufferToCloudinary));
    res.status(201).json({ files: uploadedFiles });
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    res.status(500).json({ error: 'Failed to upload files.' });
  }
});

app.get('/api/files', async (req, res) => {
  if (!hasCloudinaryConfig()) {
    sendCloudinaryUnavailable(res);
    return;
  }

  try {
    const responses = await Promise.all(
      CLOUDINARY_RESOURCE_TYPES.map((resourceType) =>
        cloudinary.api.resources({
          context: true,
          max_results: 100,
          prefix: `${CLOUDINARY_FOLDER}/`,
          resource_type: resourceType,
          type: 'upload',
        })
      )
    );

    const files = responses
      .flatMap((result) => result.resources || [])
      .map(mapCloudinaryResource)
      .filter((file) => file.publicId)
      .filter((file) => file.name)
      .filter((file) => file.url)
      .filter((file) => file.uploadDate)
      .filter((file) => file.resourceType)
      .filter((file) => file.id)
      .filter((file) => file.format !== 'tmp')
      .filter((file) => !file.name.startsWith('.'))
      .filter((file) => !file.publicId.endsWith('/'))
      .filter((file) => !file.name.endsWith('.'))
      .filter((file) => !file.url.includes('/delete/'))
      .filter((file) => !file.url.includes('/destroy/'))
      .filter((file) => !file.publicId.includes('spacer'))
      .filter((file) => !file.publicId.includes('sample'))
      .filter((file) => !file.name.includes('sample'))
      .filter((file) => !file.publicId.includes('blank'))
      .filter((file) => !file.name.includes('blank'));

    const sortedFiles = mergeFiles(files)
      .sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate));

    res.status(200).json({
      files: sortedFiles,
    });
  } catch (error) {
    console.error('Cloudinary list error:', error);
    res.status(500).json({ error: 'Failed to fetch files.' });
  }
});

app.get('/api/files/content', async (req, res) => {
  const { publicId, resourceType = 'image', mode = 'open', fileName = '', format = '' } = req.query;

  if (!publicId) {
    res.status(400).json({ error: 'publicId is required.' });
    return;
  }

  if (!hasCloudinaryConfig()) {
    sendCloudinaryUnavailable(res);
    return;
  }

  try {
    const resolvedName = fileName || publicId.split('/').pop();
    const extension = getFileExtension(resolvedName);
    const shouldOpen = mode === 'open' && VIEWABLE_FILE_TYPES.has(extension);
    const resolvedFormat = format || extension || undefined;
    const signedUrl = cloudinary.utils.private_download_url(publicId, resolvedFormat, {
      attachment: !shouldOpen,
      expires_at: Math.floor(Date.now() / 1000) + 60,
      resource_type: resourceType,
      type: 'upload',
    });

    res.redirect(signedUrl);
  } catch (error) {
    console.error('Cloudinary content error:', error);
    res.status(500).json({ error: 'Failed to open the file.' });
  }
});

app.delete('/api/files', async (req, res) => {
  const { publicId, resourceType = 'image' } = req.body || {};

  if (!publicId) {
    res.status(400).json({ error: 'publicId is required.' });
    return;
  }

  if (!hasCloudinaryConfig()) {
    sendCloudinaryUnavailable(res);
    return;
  }

  try {
    await cloudinary.uploader.destroy(publicId, {
      invalidate: true,
      resource_type: resourceType,
      type: 'upload',
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Cloudinary delete error:', error);
    res.status(500).json({ error: 'Failed to delete file.' });
  }
});

app.post('/api/data', async (req, res) => {
  try {
    const { title = '', text = '' } = req.body || {};
    const normalizedTitle = typeof title === 'string' ? title.trim() : '';
    const normalizedText = typeof text === 'string' ? text.trim() : '';

    if (!normalizedText) {
      res.status(400).json({ error: 'Text is required.' });
      return;
    }

    const newData = await createDataEntry(normalizedTitle, normalizedText);

    broadcast({ type: 'new-data', data: newData });

    res.status(201).json({ data: newData, message: 'Data saved successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/data', async (req, res) => {
  try {
    const allData = await listDataEntries();
    res.status(200).json(allData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/data/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deletedItem = await deleteDataEntry(id);

    if (!deletedItem) {
      res.status(404).json({ error: 'Data item not found.' });
      return;
    }

    broadcast({ type: 'delete-data', data: id });

    res.status(200).json({ message: 'Data item deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

ensureLocalStore().catch((error) => {
  databaseState.connected = false;
  databaseState.mode = 'offline';
  databaseState.lastError = error.message;
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
