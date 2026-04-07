import express from 'express';
import cors from 'cors';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { computeCheck } from 'telegram/Password.js';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

// Serve static UI
app.use(express.static('./'));

// Load or Setup Telegram Client
const apiId = parseInt(process.env.API_ID || '0');
const apiHash = process.env.API_HASH || '';
let stringSession = new StringSession(process.env.TG_SESSION || '');
let client = null;

let authState = { phone: '', phoneCodeHash: '' };

app.post('/api/auth/sendCode', async (req, res) => {
  const { phone } = req.body;
  
  if (!apiId || !apiHash) {
    return res.status(400).json({ error: 'Please set API_ID and API_HASH in your .env file.' });
  }

  try {
    if (!client) {
      client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
      await client.connect();
    }

    const authorized = await client.isUserAuthorized();
    if (authorized) {
      const me = await client.getMe();
      return res.json({ success: true, alreadyLoggedIn: true, user: me.username || me.phone });
    }

    const { phoneCodeHash } = await client.sendCode({ apiId, apiHash }, phone);
    authState = { phone, phoneCodeHash };
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  const { code, password } = req.body;
  try {
    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber: authState.phone,
        phoneCodeHash: authState.phoneCodeHash,
        phoneCode: code,
      }));
    } catch (e) {
      if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        if (!password) {
          return res.status(401).json({ error: 'SESSION_PASSWORD_NEEDED' });
        }
        const srpResult = await client.invoke(new Api.account.GetPassword());
        await client.invoke(new Api.auth.CheckPassword({
          password: await computeCheck(srpResult, password),
        }));
      } else {
        throw e;
      }
    }

    // Save session continuously to prevent relogin
    const sessionStr = client.session.save();
    
    // Save to env conceptually (quick replace for simple env files)
    if (fs.existsSync('.env')) {
      let envText = fs.readFileSync('.env', 'utf-8');
      if (envText.includes('TG_SESSION=')) envText = envText.replace(/TG_SESSION=.*/, `TG_SESSION=${sessionStr}`);
      else envText += `\nTG_SESSION=${sessionStr}`;
      fs.writeFileSync('.env', envText);
    }
    
    const me = await client.getMe();
    res.json({ success: true, user: me.username || me.phone });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  if (client) {
    try { await client.invoke(new Api.auth.LogOut()); } catch (e) {}
    await client.disconnect();
    client = null;
  }
  
  if (fs.existsSync('.env')) {
    let envText = fs.readFileSync('.env', 'utf-8');
    fs.writeFileSync('.env', envText.replace(/TG_SESSION=.*/, 'TG_SESSION='));
  }
  stringSession = new StringSession('');
  res.json({ success: true });
});

app.post('/api/channel/files', async (req, res) => {
  const { channel } = req.body;
  try {
    if (!client || !(await client.isUserAuthorized())) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const m = channel.match(/(?:t\.me\/|@)([A-Za-z0-9_]+)/);
    const username = m ? m[1] : channel;
    const entity = await client.getEntity(username);
    
    const files = [];
    for await (const msg of client.iterMessages(entity, { limit: 100 })) {
      if (msg.media) {
        const info = extractFileInfo(msg);
        if (info) files.push(info);
      }
    }
    
    if (files.length === 0) return res.json({ files: [] });
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// THE CORE STREAMING ENDPOINT 
// Streams directly from Telegram API to the Browser's HTTP Response chunk by chunk
app.get('/api/channel/download/:channelId/:msgId', async (req, res) => {
  if (!client || !(await client.isUserAuthorized())) {
    return res.status(401).send('Not authenticated');
  }

  const { channelId, msgId } = req.params;

  try {
    const entity = await client.getEntity(channelId);
    let targetMsg = null;
    
    for await (const msg of client.iterMessages(entity, { ids: [parseInt(msgId)] })) {
      if (msg && msg.id === parseInt(msgId)) { targetMsg = msg; break; }
    }

    if (!targetMsg || !targetMsg.media) {
      return res.status(404).send('Message or media not found');
    }

    const info = extractFileInfo(targetMsg);
    
    res.setHeader('Content-Disposition', `attachment; filename="${info.name}"`);
    res.setHeader('Content-Type', info.mime || 'application/octet-stream');
    if (info.size) {
      res.setHeader('Content-Length', info.size);
    }

    // Direct Browser Stream using Iterable Download
    // Telegram -> Node.js -> Browser immediately
    // Uses minimal RAM, and uses ZERO server disk space
    let requestSize = 1048576; // 1 MB chunk fetches
    
    const asyncStream = client.iterDownload({
      file: targetMsg.media,
      requestSize: requestSize,
    });

    for await (const chunk of asyncStream) {
      // Send chunk directly to browser
      // Write returns false if backpressure exists (browser downloading too slow)
      const canWrite = res.write(chunk);
      if (!canWrite) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    
    res.end(); // Download complete

  } catch (error) {
    console.error('Download stream error:', error);
    if (!res.headersSent) res.status(500).send(error.message);
    else res.end();
  }
});

app.get('/api/me', async (req, res) => {
  try {
    if (!client) {
      client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
      await client.connect();
    }
    const isAuth = await client.isUserAuthorized();
    if (isAuth) {
      const me = await client.getMe();
      return res.json({ authed: true, user: me.username || me.phone });
    }
    res.json({ authed: false });
  } catch(e) {
    res.json({ authed: false });
  }
});

function extractFileInfo(msg) {
  const m = msg.media;
  if (!m) return null;
  let name, size = 0, type = 'file', mime = '';

  if (m.className === 'MessageMediaDocument' && m.document) {
    size = Number(m.document.size || 0);
    mime = m.document.mimeType || '';
    const fn = (m.document.attributes || []).find(a => a.className === 'DocumentAttributeFilename');
    const au = (m.document.attributes || []).find(a => a.className === 'DocumentAttributeAudio');
    const vi = (m.document.attributes || []).find(a => a.className === 'DocumentAttributeVideo');

    if (fn) name = fn.fileName;
    else if (au) name = (au.title || 'audio') + '.' + (mime.split('/')[1] || 'mp3');
    else if (vi) name = `video_${msg.id}.` + (mime.split('/')[1] || 'mp4');
    else name = `file_${msg.id}.` + (mime.split('/')[1] || 'bin');

    type = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : mime.startsWith('image') ? 'image' : 'file';
  } else if (m.className === 'MessageMediaPhoto') {
    name = `photo_${msg.id}.jpg`; type = 'image'; mime = 'image/jpeg';
  } else return null;

  return { id: msg.id, name, size, type, mime };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server streaming ready at http://localhost:${PORT}`);
});
