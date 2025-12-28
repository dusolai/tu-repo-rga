const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const upload = multer({ dest: os.tmpdir() });
const STORES = new Map();

// MIDDLEWARES
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
});

const getApiKey = () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Falta GEMINI_API_KEY");
  return key;
};

// GEMINI REST API
function callGeminiREST(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    });

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      port: 443,
      path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`❌ Gemini HTTP ${res.statusCode}:`, data.substring(0, 200));
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          if (parsed.candidates?.[0]?.content?.parts?.[0]?.text) {
            return resolve(parsed.candidates[0].content.parts[0].text);
          }
          reject(new Error('Sin respuesta'));
        } catch (e) {
          reject(new Error('Parse error'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ENDPOINTS

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '8.0.0',
    modelo: 'gemini-1.5-flash v1beta'
  });
});

app.post('/create-store', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Se requiere name' });

    const storeId = `fileSearchStores/${name}${Date.now()}-${Math.random().toString(36).slice(2)}`;
    STORES.set(storeId, { name, files: [], texts: [] });

    console.log(`✅ Store: ${storeId}`);
    res.json({ storeId });
  } catch (error) {
    console.error('❌ Error store:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file' });
    }

    const { originalname, path: localPath, mimetype } = req.file;
    console.log(`📤 Upload: ${originalname} (${req.file.size}b)`);
    
    const apiKey = getApiKey();
    const fileContent = fs.readFileSync(localPath);
    
    // Tipo MIME
    let contentType = mimetype || 'text/plain';
    if (originalname.endsWith('.pdf')) contentType = 'application/pdf';
    else if (originalname.endsWith('.md')) contentType = 'text/markdown';
    
    // === MULTIPART FORM-DATA CORRECTO ===
    const boundary = `----FormBoundary${Date.now()}`;
    
    const metadataPart = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="metadata"`,
      `Content-Type: application/json; charset=UTF-8`,
      ``,
      JSON.stringify({ file: { display_name: originalname } }),
      ``
    ].join('\r\n');
    
    const filePart = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${originalname}"`,
      `Content-Type: ${contentType}`,
      ``,
      ``
    ].join('\r\n');
    
    const ending = `\r\n--${boundary}--\r\n`;
    
    const body = Buffer.concat([
      Buffer.from(metadataPart, 'utf8'),
      Buffer.from(filePart, 'utf8'),
      fileContent,
      Buffer.from(ending, 'utf8')
    ]);

    console.log(`   Multipart size: ${body.length}b`);

    // UPLOAD A GEMINI
    const uploadResult = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/upload/v1beta/files?key=${apiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'X-Goog-Upload-Protocol': 'multipart'
        }
      };

      const uploadReq = https.request(opts, (uploadRes) => {
        let data = '';
        uploadRes.on('data', c => data += c);
        uploadRes.on('end', () => {
          console.log(`   HTTP ${uploadRes.statusCode}`);
          if (uploadRes.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              console.error(`   Parse fail:`, data.substring(0, 200));
              reject(new Error('Parse error'));
            }
          } else {
            console.error(`   Fail:`, data.substring(0, 300));
            reject(new Error(`HTTP ${uploadRes.statusCode}`));
          }
        });
      });
      uploadReq.on('error', reject);
      uploadReq.write(body);
      uploadReq.end();
    });

    // EXTRAER TEXTO
    let extractedText = '';
    if (originalname.endsWith('.txt') || originalname.endsWith('.md')) {
      extractedText = fileContent.toString('utf-8');
    } else if (originalname.endsWith('.pdf')) {
      extractedText = `[PDF: ${originalname}]`;
    } else {
      try {
        extractedText = fileContent.toString('utf-8');
      } catch {
        extractedText = `[Binary: ${originalname}]`;
      }
    }

    console.log(`✅ OK: ${uploadResult.file.name} (${extractedText.length}c)`);
    fs.unlinkSync(localPath);

    res.json({
      file: {
        name: uploadResult.file.name,
        uri: uploadResult.file.uri,
        mimeType: uploadResult.file.mimeType,
        extractedText
      }
    });
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/link-file', (req, res) => {
  try {
    const { storeId, fileUri, fileName, extractedText } = req.body;
    
    if (!STORES.has(storeId)) {
      return res.status(404).json({ error: 'Store no encontrado' });
    }

    const store = STORES.get(storeId);
    store.files.push({ fileUri, fileName });
    
    if (extractedText) {
      store.texts.push({ fileName, text: extractedText });
    }

    console.log(`🔗 Linked: ${fileName} (${store.files.length} total)`);
    res.json({ success: true, fileCount: store.files.length });
  } catch (error) {
    console.error('❌ Link error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { storeId, query } = req.body;
    const apiKey = getApiKey();

    console.log(`💬 "${query}" @ ${storeId}`);

    if (!STORES.has(storeId)) {
      return res.status(404).json({ error: 'Store no encontrado' });
    }

    const store = STORES.get(storeId);
    console.log(`🔍 ${store.texts.length} docs`);

    let context = '';
    for (const { fileName, text } of store.texts) {
      context += `\n\n--- ${fileName} ---\n${text}`;
    }

    const prompt = `Documentos:\n${context}\n\nPregunta: ${query}\n\nResponde SOLO con información de los documentos.`;

    const response = await callGeminiREST(prompt, apiKey);

    console.log(`✅ Respuesta: ${response.length}c`);
    res.json({ response });
  } catch (error) {
    console.error('❌ Chat error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/debug/stores', (req, res) => {
  const stores = Array.from(STORES.entries()).map(([id, data]) => ({
    id,
    name: data.name,
    fileCount: data.files.length,
    textCount: data.texts.length
  }));
  res.json({ stores });
});

app.listen(PORT, () => {
  console.log(`🚀 Backend v8.0.0 @ ${PORT}`);
  console.log(`   gemini-1.5-flash REST v1beta`);
});
