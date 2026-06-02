require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

let pdfParseFunc = null;
try {
	pdfParseFunc = require('pdf-parse');
	if (typeof pdfParseFunc !== 'function') pdfParseFunc = pdfParseFunc.default || null;
	if (pdfParseFunc) console.log('pdf-parse cargado correctamente ✓');
	else console.error('pdf-parse no pudo cargarse');
} catch (err) {
	console.error('Error cargando pdf-parse:', err.message);
}

const { pipeline } = require('@xenova/transformers');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
	console.error('FATAL: GOOGLE_CLIENT_ID no configurado en variables de entorno');
	process.exit(1);
}
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_BUCKET = 'images';

if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error('FATAL: SUPABASE_URL o SUPABASE_ANON_KEY no configurados');
	process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
console.log('Supabase conectado ✓');

// ── Auth helpers ──
async function verifyGoogleToken(idToken) {
	try {
		const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
		const payload = ticket.getPayload();
		return { email: payload.email, name: payload.name };
	} catch (err) {
		console.error('Token de Google inválido:', err.message);
		return null;
	}
}

async function getUserRole(email) {
	if (!email) return null;
	try {
		const { data } = await supabase
			.from('users')
			.select('role')
			.eq('email', String(email).toLowerCase())
			.single();
		return data ? (data.role || 'user') : null;
	} catch (err) {
		console.error('getUserRole error:', err);
		return null;
	}
}

const app = express();

// ── CORS ──
const DEFAULT_ALLOWED_ORIGINS = ['https://databaseucv.onrender.com'];
const ALLOWED_ORIGINS = [
	...DEFAULT_ALLOWED_ORIGINS,
	...(process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
];
const LOCALHOST_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(cors({
	origin: function (origin, callback) {
		if (!origin) return callback(null, true);
		if (LOCALHOST_REGEX.test(origin)) return callback(null, true);
		if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
		console.warn(`[CORS] Origin rechazado: ${origin}`);
		return callback(new Error('CORS: origen no permitido'), false);
	},
	credentials: true
}));

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ── Rate limiting ──
const globalRateMap = new Map();
const GLOBAL_RATE_WINDOW = 15 * 60 * 1000;
const GLOBAL_RATE_MAX = 300;
const pdfRateMap = new Map();
const PDF_RATE_WINDOW = 60 * 60 * 1000;
const PDF_RATE_MAX = 10;

function getClientIp(req) {
	return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || req.connection?.remoteAddress || 'unknown';
}

function checkRateLimit(map, ip, windowMs, max) {
	const now = Date.now();
	const arr = map.get(ip) || [];
	const active = arr.filter(ts => now - ts < windowMs);
	if (active.length >= max) { map.set(ip, active); return false; }
	active.push(now);
	map.set(ip, active);
	return true;
}

app.use((req, res, next) => {
	if (!checkRateLimit(globalRateMap, getClientIp(req), GLOBAL_RATE_WINDOW, GLOBAL_RATE_MAX))
		return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta más tarde.' });
	next();
});

// ── Auth middleware ──
async function requireAuth(req, res, next) {
	const authHeader = req.headers['authorization'] || '';
	const id_token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
	if (!id_token) return res.status(401).json({ error: 'Token de autenticación requerido' });
	const googleUser = await verifyGoogleToken(id_token);
	if (!googleUser) return res.status(401).json({ error: 'Token inválido o expirado. Vuelve a iniciar sesión.' });
	req.verifiedEmail = googleUser.email.toLowerCase();
	req.verifiedName = googleUser.name;
	next();
}

async function requireAdmin(req, res, next) {
	const role = await getUserRole(req.verifiedEmail);
	if (role !== 'admin') return res.status(403).json({ error: 'Se requiere rol de administrador' });
	next();
}

// ── Security headers ──
app.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'SAMEORIGIN');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	res.setHeader('Content-Security-Policy', [
		"default-src 'self'",
		"img-src * data: blob:",
		"script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com",
		"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
		"font-src 'self' https://fonts.gstatic.com",
		"connect-src 'self' https://nominatim.openstreetmap.org https://overpass.openstreetmap.fr https://accounts.google.com https://szurscobpuayftnhusif.supabase.co",
		"frame-src https://accounts.google.com",
		"object-src 'none'",
		"base-uri 'self'"
	].join('; '));
	next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──
function cleanText(text) { return text.replace(/\s+/g, ' ').trim(); }

function splitIntoChunks(text, maxWords = 300) {
	const words = text.split(/\s+/);
	const chunks = [];
	for (let i = 0; i < words.length; i += maxWords) {
		const chunk = words.slice(i, i + maxWords).join(' ');
		if (chunk.trim()) chunks.push(chunk);
	}
	return chunks;
}

function normalizeProfileValue(value) { return String(value || '').trim(); }

function makeExtractedEmail(firstName, lastName) {
	const base = `${firstName} ${lastName}`.toLowerCase()
		.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
	return `${base || 'perfilextraido'}@gmail.com`;
}

const ALLOWED_IMAGE_MAGIC = [
	{ mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
	{ mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47] },
	{ mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
	{ mime: 'image/gif',  bytes: [0x47, 0x49, 0x46] },
];

function validateImageMagicBytes(buffer) {
	for (const sig of ALLOWED_IMAGE_MAGIC) {
		if (sig.bytes.every((b, i) => buffer[i] === b)) return sig.mime;
	}
	return null;
}

function sanitizeFilename(original) {
	return path.basename(original).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function extractProfilesFromText(text) {
	const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	const profiles = [];
	const seen = new Set();
	const dniRegex = /\b(\d{7,9})\b/;
	const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
	const nameLineRegex = /([A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+(?:\s+[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+)+)/g;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const dniMatch = line.match(dniRegex);
		const emailMatch = line.match(emailRegex);
		const email = emailMatch ? emailMatch[0].toLowerCase() : '';
		let nameCandidate = '';
		const cleaned = line.replace(dniMatch ? dniMatch[0] : '', '').replace(email, '').trim();
		const nameMatch = cleaned.match(nameLineRegex);
		if (nameMatch && nameMatch.length) {
			nameCandidate = nameMatch[0];
		} else if (cleaned && !/\d/.test(cleaned) && cleaned.split(/\s+/).length >= 2) {
			nameCandidate = cleaned;
		} else {
			for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
				const next = lines[j].trim();
				if (!next) continue;
				const nextMatch = next.match(nameLineRegex);
				if (nextMatch && nextMatch.length) { nameCandidate = nextMatch[0]; break; }
				if (!/\d/.test(next) && next.split(/\s+/).length >= 2) { nameCandidate = next; break; }
			}
		}
		if (!nameCandidate) continue;
		const words = nameCandidate.split(/\s+/).filter(Boolean);
		let firstName = '', lastName = '';
		if (words.length === 2) { [firstName, lastName] = words; }
		else if (words.length > 2) {
			firstName = words.slice(0, Math.ceil(words.length / 2)).join(' ');
			lastName = words.slice(Math.ceil(words.length / 2)).join(' ');
		} else { firstName = words[0]; }
		const profileKey = `${firstName}|${lastName}|${dniMatch ? dniMatch[1] : ''}|${email}`;
		if (seen.has(profileKey)) continue;
		seen.add(profileKey);
		profiles.push({
			firstName: normalizeProfileValue(firstName), lastName: normalizeProfileValue(lastName),
			dni: normalizeProfileValue(dniMatch ? dniMatch[1] : ''),
			email: normalizeProfileValue(email) || makeExtractedEmail(firstName, lastName),
			phone: '', locality: '', province: '', department: '', country: 'Perú',
			location: '', parents: '', siblings: '', birthday: '', photo: '',
			stats: { skill: 0, intelligence: 0, performance: 0, jobs: 0, occupation: 0 }
		});
	}
	return profiles;
}

async function generateEmbedding(text) {
	const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
	const output = await extractor(text, { pooling: 'mean', normalize: true });
	return Array.from(output.data);
}

function cosineSimilarity(a, b) {
	const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
	const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
	const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
	return dot / (magA * magB);
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening ${PORT}`));

// ── FRONT ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── /api/upload ──
app.post('/api/upload', requireAuth, upload.single('photoFile'), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: 'no file' });
		const detectedMime = validateImageMagicBytes(req.file.buffer);
		if (!detectedMime) return res.status(400).json({ error: 'Tipo de archivo no permitido.' });
		const filename = `avatar_${Date.now()}_${sanitizeFilename(req.file.originalname)}`;
		const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).upload(filename, req.file.buffer, { contentType: detectedMime, upsert: false });
		if (error) { console.error('supabase upload error', error); return res.status(500).json({ error: 'upload error' }); }
		const { data: publicUrlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(data.path);
		return res.json({ url: publicUrlData?.publicUrl });
	} catch (err) { console.error('upload error', err); return res.status(500).json({ error: 'server error' }); }
});

// ── /api/upload-cover ──
app.post('/api/upload-cover', requireAuth, upload.single('coverFile'), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: 'no file provided' });
		const detectedMime = validateImageMagicBytes(req.file.buffer);
		if (!detectedMime) return res.status(400).json({ error: 'Tipo de archivo no permitido.' });
		const filename = `cover_${Date.now()}_${sanitizeFilename(req.file.originalname)}`;
		const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).upload(filename, req.file.buffer, { contentType: detectedMime, upsert: false });
		if (error) return res.status(500).json({ error: `Supabase upload failed: ${error.message}` });
		const { data: publicUrlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(data.path);
		return res.json({ url: publicUrlData?.publicUrl });
	} catch (err) { return res.status(500).json({ error: 'Server error' }); }
});

// ── /api/profiles ──
app.get('/api/profiles', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
		if (error) throw error;
		res.json(data.map(d => ({ id: d.id, ...d })));
	} catch (err) { console.error(err); res.status(500).json({ error: 'db error' }); }
});

app.post('/api/profiles', requireAuth, async (req, res) => {
	try {
		if (req.body.id) {
			const { id, ...update } = req.body;
			update.updated_at = new Date().toISOString();
			const { data, error } = await supabase.from('profiles').update(update).eq('id', id).select().single();
			if (error) throw error;
			return res.json({ id: data.id, ...data });
		}
		const doc = {
			id: uuidv4(),
			first_name: req.body.firstName, last_name: req.body.lastName,
			dni: req.body.dni, photo: req.body.photo, email: req.body.email,
			phone: req.body.phone, location: req.body.location, country: req.body.country,
			department: req.body.department, province: req.body.province,
			locality: req.body.locality, city: req.body.city, address: req.body.address,
			birthday: req.body.birthday, lat: req.body.lat, lng: req.body.lng,
			stats: req.body.stats, author: req.body.author,
			created_at: new Date().toISOString()
		};
		const { data, error } = await supabase.from('profiles').insert(doc).select().single();
		if (error) throw error;
		res.json({ id: data.id, ...data });
	} catch (err) { console.error(err); res.status(500).json({ error: 'db error' }); }
});

app.put('/api/profiles/:id', requireAuth, async (req, res) => {
	try {
		const { id, _id, ...dataToSet } = req.body;
		const update = {
			first_name: dataToSet.firstName, last_name: dataToSet.lastName,
			dni: dataToSet.dni, photo: dataToSet.photo, email: dataToSet.email,
			phone: dataToSet.phone, location: dataToSet.location, country: dataToSet.country,
			department: dataToSet.department, province: dataToSet.province,
			locality: dataToSet.locality, city: dataToSet.city, address: dataToSet.address,
			birthday: dataToSet.birthday, lat: dataToSet.lat, lng: dataToSet.lng,
			stats: dataToSet.stats, author: dataToSet.author,
			updated_at: new Date().toISOString()
		};
		const { data, error } = await supabase.from('profiles').update(update).eq('id', req.params.id).select().single();
		if (error) throw error;
		res.json({ id: data.id, ...data });
	} catch (err) { console.error(err); res.status(500).json({ error: 'db error' }); }
});

app.delete('/api/profiles/:id', requireAuth, async (req, res) => {
	try {
		const { error } = await supabase.from('profiles').delete().eq('id', req.params.id);
		if (error) throw error;
		res.json({ success: true, message: 'Perfil eliminado' });
	} catch (err) { console.error(err); res.status(500).json({ error: 'Error al eliminar' }); }
});

// ── /api/networks ──
app.get('/api/networks', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('networks').select('*').order('created_at', { ascending: false });
		if (error) throw error;
		res.json(data.map(d => ({ id: d.id, ...d.data, created_at: d.created_at })));
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/networks', requireAuth, async (req, res) => {
	try {
		const id = uuidv4();
		const { data, error } = await supabase.from('networks').insert({ id, data: req.body, created_at: new Date().toISOString() }).select().single();
		if (error) throw error;
		res.json({ id: data.id, ...data.data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.put('/api/networks/:id', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('networks').update({ data: req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
		if (error) throw error;
		res.json({ id: data.id, ...data.data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

// ── /api/cycles ──
app.get('/api/cycles', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('cycles').select('*').order('created_at', { ascending: false });
		if (error) throw error;
		res.json(data.map(d => ({ id: d.id, ...d.data })));
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/cycles', requireAuth, async (req, res) => {
	try {
		const id = uuidv4();
		const { data, error } = await supabase.from('cycles').insert({ id, data: req.body, created_at: new Date().toISOString() }).select().single();
		if (error) throw error;
		res.json({ id: data.id, ...data.data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.put('/api/cycles/:id', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('cycles').update({ data: req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
		if (error) throw error;
		res.json({ id: data.id, ...data.data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.delete('/api/cycles/:id', requireAuth, async (req, res) => {
	try {
		const { error } = await supabase.from('cycles').delete().eq('id', req.params.id);
		if (error) throw error;
		res.json({ success: true });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

// ── /api/events ──
app.get('/api/events', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('events').select('*').order('date', { ascending: true });
		if (error) throw error;
		res.json(data.map(d => ({ id: d.id, ...d.data, date: d.date, time: d.time })));
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/events', requireAuth, async (req, res) => {
	try {
		const id = uuidv4();
		const { data, error } = await supabase.from('events').insert({ id, date: req.body.date, time: req.body.time, data: req.body, created_at: new Date().toISOString() }).select().single();
		if (error) throw error;
		res.json({ id: data.id, ...data.data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.put('/api/events/:id', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('events').update({ date: req.body.date, time: req.body.time, data: req.body, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
		if (error) throw error;
		res.json({ id: data.id, ...data.data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
	try {
		const { error } = await supabase.from('events').delete().eq('id', req.params.id);
		if (error) throw error;
		res.json({ success: true });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

// ── /api/nexus-cases ──
app.get('/api/nexus-cases', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('nexus_cases').select('*').order('updated_at', { ascending: false });
		if (error) throw error;
		res.json(data.map(d => ({ id: d.id, ...d.data, created_by: d.created_by, updated_by: d.updated_by })));
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/nexus-cases', requireAuth, async (req, res) => {
	try {
		const id = uuidv4();
		const now = new Date().toISOString();
		const { data, error } = await supabase.from('nexus_cases').insert({ id, created_by: req.verifiedEmail, data: req.body, created_at: now, updated_at: now }).select().single();
		if (error) throw error;
		res.json({ id: data.id, ...data.data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.put('/api/nexus-cases/:id', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('nexus_cases').update({ data: req.body, updated_by: req.verifiedEmail, updated_at: new Date().toISOString() }).eq('id', req.params.id).select().single();
		if (error) throw error;
		if (!data) return res.status(404).json({ error: 'Caso no encontrado' });
		res.json({ id: data.id, ...data.data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.delete('/api/nexus-cases/:id', requireAuth, async (req, res) => {
	try {
		const { error } = await supabase.from('nexus_cases').delete().eq('id', req.params.id);
		if (error) throw error;
		res.json({ success: true });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

// ── /api/overpass proxy ──
const overpassCache = new Map();
const OVERPASS_CACHE_TTL = 60 * 1000;
const rateMap = new Map();
const RATE_WINDOW = 5 * 60 * 1000;
const RATE_MAX = 300;

function pruneRate(ip) {
	const now = Date.now();
	const arr = rateMap.get(ip) || [];
	while (arr.length && (now - arr[0]) > RATE_WINDOW) arr.shift();
	rateMap.set(ip, arr);
	return arr;
}
function getCache(key) {
	const e = overpassCache.get(key);
	if (!e) return null;
	if (Date.now() > e.expires) { overpassCache.delete(key); return null; }
	return e.body;
}
function setCache(key, body) {
	overpassCache.set(key, { expires: Date.now() + OVERPASS_CACHE_TTL, body });
}

app.post('/api/overpass', express.text({ type: '*/*' }), async (req, res) => {
	try {
		const query = req.body;
		if (!query || !query.trim()) return res.status(400).json({ error: 'empty query' });
		const ip = getClientIp(req);
		const arr = pruneRate(ip);
		if (arr.length >= RATE_MAX) return res.status(429).json({ error: 'rate limit exceeded' });
		arr.push(Date.now());
		rateMap.set(ip, arr);
		const key = String(query).slice(0, 5000);
		const cached = getCache(key);
		if (cached) { res.setHeader('X-Overpass-Cache', 'HIT'); return res.status(200).type('application/json').send(cached); }
		const overpassRes = await fetch('https://overpass.openstreetmap.fr/api/interpreter', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain', 'Accept-Language': 'es', 'User-Agent': 'profile-server/1.0' },
			body: query,
		});
		const text = await overpassRes.text();
		if (overpassRes.ok) setCache(key, text);
		res.status(overpassRes.status).type('application/json').send(text);
	} catch (err) { console.error('Overpass proxy error', err); res.status(502).json({ error: 'overpass proxy error' }); }
});

// ── Auth endpoints ──
app.post('/request-approval', async (req, res) => {
	try {
		const { id_token } = req.body || {};
		if (!id_token) return res.status(400).json({ error: 'id_token requerido' });
		const googleUser = await verifyGoogleToken(id_token);
		if (!googleUser) return res.status(401).json({ error: 'Token de Google inválido o expirado' });
		const email = googleUser.email.toLowerCase();
		const name = googleUser.name || email.split('@')[0];
		const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
		if (existing) {
			await supabase.from('users').update({ name, updated_at: new Date().toISOString() }).eq('email', email);
		} else {
			await supabase.from('users').insert({ id: uuidv4(), email, name, role: 'user', approved: false, created_at: new Date().toISOString() });
		}
		res.json({ success: true, email, name });
	} catch (err) { console.error('request-approval error', err); res.status(500).json({ error: 'server error' }); }
});

app.get('/status', requireAuth, async (req, res) => {
	try {
		const { data } = await supabase.from('users').select('approved, role').eq('email', req.verifiedEmail).single();
		if (!data) return res.json({ approved: false, role: 'user' });
		res.json({ approved: data.approved || false, role: data.role || 'user' });
	} catch (err) { console.error('status error', err); res.status(500).json({ error: 'server error' }); }
});

app.post('/verify-token', async (req, res) => {
	try {
		const { id_token } = req.body || {};
		if (!id_token) return res.status(400).json({ error: 'id_token requerido' });
		const googleUser = await verifyGoogleToken(id_token);
		if (!googleUser) return res.status(401).json({ error: 'Token inválido' });
		const email = googleUser.email.toLowerCase();
		const { data: user } = await supabase.from('users').select('approved, role').eq('email', email).single();
		res.json({ email, name: googleUser.name, approved: user ? (user.approved || false) : false, role: user ? (user.role || 'user') : 'user' });
	} catch (err) { console.error('verify-token error', err); res.status(500).json({ error: 'server error' }); }
});

// ── /api/publications ──
app.get('/api/publications', async (req, res) => {
	try {
		const { data, error } = await supabase.from('publications').select('*').order('title', { ascending: true });
		if (error) throw error;
		res.json(data.map(p => ({ _id: p.id, ...p })));
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.get('/api/publications-admin', requireAuth, async (req, res) => {
	try {
		const { data, error } = await supabase.from('publicationsadmin').select('*').order('title', { ascending: true });
		if (error) throw error;
		res.json(data.map(p => ({ _id: p.id, ...p })));
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/publications', requireAuth, async (req, res) => {
	try {
		const author = req.verifiedEmail;
		const { title, subtitle, keywords, content, role, coverUrl } = req.body;
		if (!title || !title.trim()) return res.status(400).json({ error: 'El título es requerido' });
		if (!content || !content.trim()) return res.status(400).json({ error: 'El contenido es requerido' });
		const realRole = await getUserRole(author);
		if (!realRole || (realRole !== 'user' && realRole !== 'admin')) return res.status(403).json({ error: 'No tienes permiso para publicar' });
		const now = new Date().toISOString();
		const { data, error } = await supabase.from('publications').insert({
			id: uuidv4(), title: title.trim(), subtitle: subtitle?.trim() || '',
			keywords: Array.isArray(keywords) ? keywords : [], content: content.trim(),
			author, role, cover_url: coverUrl || null, published_at: now, created_at: now, updated_at: now
		}).select().single();
		if (error) throw error;
		res.json({ _id: data.id, ...data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/publications-admin', requireAuth, async (req, res) => {
	try {
		const author = req.verifiedEmail;
		const { title, subtitle, keywords, content, role, coverUrl } = req.body;
		if (!title || !title.trim()) return res.status(400).json({ error: 'El título es requerido' });
		if (!content || !content.trim()) return res.status(400).json({ error: 'El contenido es requerido' });
		const now = new Date().toISOString();
		const { data, error } = await supabase.from('publicationsadmin').insert({
			id: uuidv4(), title: title.trim(), subtitle: subtitle?.trim() || '',
			keywords: Array.isArray(keywords) ? keywords : [], content: content.trim(),
			author, role, cover_url: coverUrl || null, published_at: now, created_at: now, updated_at: now
		}).select().single();
		if (error) throw error;
		res.json({ _id: data.id, ...data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.put('/api/publications/:id', requireAuth, async (req, res) => {
	try {
		const { title, subtitle, keywords, content, coverUrl } = req.body || {};
		if (!title || !title.trim()) return res.status(400).json({ error: 'El título es requerido' });
		if (!content || !content.trim()) return res.status(400).json({ error: 'El contenido es requerido' });
		const { data: pub } = await supabase.from('publications').select('author').eq('id', req.params.id).single();
		if (!pub) return res.status(404).json({ error: 'Publicación no encontrada' });
		if (pub.author !== req.verifiedEmail) return res.status(403).json({ error: 'Solo puedes editar tus propias publicaciones' });
		const { data, error } = await supabase.from('publications').update({
			title: title.trim(), subtitle: subtitle?.trim() || '',
			keywords: Array.isArray(keywords) ? keywords : [], content: content.trim(),
			cover_url: coverUrl || null, updated_at: new Date().toISOString()
		}).eq('id', req.params.id).select().single();
		if (error) throw error;
		res.json({ _id: data.id, ...data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.delete('/api/publications/:id', requireAuth, async (req, res) => {
	try {
		const realRole = await getUserRole(req.verifiedEmail);
		const { data: pub } = await supabase.from('publications').select('author').eq('id', req.params.id).single();
		if (!pub) return res.status(404).json({ error: 'Publicación no encontrada' });
		if (realRole !== 'admin' && pub.author !== req.verifiedEmail) return res.status(403).json({ error: 'Sin permiso' });
		const { error } = await supabase.from('publications').delete().eq('id', req.params.id);
		if (error) throw error;
		res.json({ success: true });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.put('/api/publications-admin/:id', requireAuth, async (req, res) => {
	try {
		const { title, subtitle, keywords, content, coverUrl } = req.body || {};
		if (!title || !title.trim()) return res.status(400).json({ error: 'El título es requerido' });
		if (!content || !content.trim()) return res.status(400).json({ error: 'El contenido es requerido' });
		const { data: pub } = await supabase.from('publicationsadmin').select('author').eq('id', req.params.id).single();
		if (!pub) return res.status(404).json({ error: 'Publicación no encontrada' });
		if (pub.author !== req.verifiedEmail) return res.status(403).json({ error: 'Solo puedes editar tus propias publicaciones' });
		const { data, error } = await supabase.from('publicationsadmin').update({
			title: title.trim(), subtitle: subtitle?.trim() || '',
			keywords: Array.isArray(keywords) ? keywords : [], content: content.trim(),
			cover_url: coverUrl || null, updated_at: new Date().toISOString()
		}).eq('id', req.params.id).select().single();
		if (error) throw error;
		res.json({ _id: data.id, ...data });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.delete('/api/publications-admin/:id', requireAuth, async (req, res) => {
	try {
		const realRole = await getUserRole(req.verifiedEmail);
		const { data: pub } = await supabase.from('publicationsadmin').select('author').eq('id', req.params.id).single();
		if (!pub) return res.status(404).json({ error: 'Publicación no encontrada' });
		if (realRole !== 'admin' && pub.author !== req.verifiedEmail) return res.status(403).json({ error: 'Sin permiso' });
		const { error } = await supabase.from('publicationsadmin').delete().eq('id', req.params.id);
		if (error) throw error;
		res.json({ success: true });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/publications/search', async (req, res) => {
	try {
		const { title, keywords, dateFrom, dateTo } = req.body || {};
		let query = supabase.from('publications').select('*');
		if (title && title.trim()) query = query.ilike('title', `%${title.trim()}%`);
		if (keywords && Array.isArray(keywords) && keywords.length > 0) query = query.overlaps('keywords', keywords);
		if (dateFrom) query = query.gte('published_at', dateFrom);
		if (dateTo) query = query.lte('published_at', dateTo);
		const { data, error } = await query.order('title', { ascending: true });
		if (error) throw error;
		res.json(data.map(p => ({ _id: p.id, ...p })));
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.post('/api/publications-admin/search', requireAuth, async (req, res) => {
	try {
		const { title, keywords, dateFrom, dateTo } = req.body || {};
		let query = supabase.from('publicationsadmin').select('*');
		if (title && title.trim()) query = query.ilike('title', `%${title.trim()}%`);
		if (keywords && Array.isArray(keywords) && keywords.length > 0) query = query.overlaps('keywords', keywords);
		if (dateFrom) query = query.gte('published_at', dateFrom);
		if (dateTo) query = query.lte('published_at', dateTo);
		const { data, error } = await query.order('title', { ascending: true });
		if (error) throw error;
		res.json(data.map(p => ({ _id: p.id, ...p })));
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

// ── /api/upload-pdf ──
app.post('/api/upload-pdf', requireAuth, upload.single('pdfFile'), async (req, res) => {
	try {
		const ip = getClientIp(req);
		if (!checkRateLimit(pdfRateMap, ip, PDF_RATE_WINDOW, PDF_RATE_MAX))
			return res.status(429).json({ error: 'Límite de uploads de PDF alcanzado.' });
		if (!req.file) return res.status(400).json({ error: 'No file provided' });
		const pdfMagic = [0x25, 0x50, 0x44, 0x46, 0x2D];
		if (!pdfMagic.every((b, i) => req.file.buffer[i] === b))
			return res.status(400).json({ error: 'El archivo no es un PDF válido.' });

		const userEmail = req.verifiedEmail;
		await supabase.from('pdf_chunks').delete().eq('uploaded_by', userEmail);

		if (!pdfParseFunc || typeof pdfParseFunc !== 'function')
			return res.status(500).json({ error: 'pdfParse no disponible.' });

		const parsedData = await pdfParseFunc(req.file.buffer);
		let text = cleanText(parsedData.text || '');
		let ocrText = '';
		let usedOcr = false;
		const chunks = splitIntoChunks(text, 300);
		const pdfId = uuidv4();
		const chunkDocs = [];
		const safeFilename = sanitizeFilename(req.file.originalname);

		const buildChunks = async (chunkList, isOcr = false) => {
			for (const chunk of chunkList) {
				const c = chunk.trim();
				if (c) {
					const embedding = await generateEmbedding(c);
					chunkDocs.push({ id: uuidv4(), pdf_id: pdfId, filename: safeFilename, chunk_index: chunkDocs.length, content: c, embedding, uploaded_at: new Date().toISOString(), uploaded_by: userEmail, ocr: isOcr });
				}
			}
		};

		await buildChunks(chunks, false);

		if (chunkDocs.length === 0) {
			let Tesseract = null;
			try { Tesseract = require('tesseract.js'); } catch (e) {}
			if (!Tesseract) return res.status(400).json({ error: 'PDF escaneado sin texto extraíble.', scanned: true });
			try {
				const { data: { text: rawOcrText } } = await Tesseract.recognize(req.file.buffer, 'spa+eng', {});
				ocrText = cleanText(rawOcrText);
				if (!ocrText) return res.status(400).json({ error: 'OCR no pudo extraer texto.' });
				await buildChunks(splitIntoChunks(ocrText, 300), true);
				usedOcr = true;
				if (chunkDocs.length === 0) return res.status(400).json({ error: 'OCR sin texto legible.' });
			} catch (ocrErr) { return res.status(500).json({ error: 'Error en OCR.' }); }
		}

		const { error: insertError } = await supabase.from('pdf_chunks').insert(chunkDocs);
		if (insertError) throw insertError;

		const profiles = extractProfilesFromText(usedOcr ? ocrText : text);
		if (!profiles.length) return res.status(400).json({ error: 'No se pudieron generar perfiles.' });

		res.setHeader('Content-Type', 'application/x-ndjson');
		res.setHeader('Cache-Control', 'no-store');
		res.flushHeaders();
		for (const profile of profiles) res.write(JSON.stringify(profile) + '\n');
		return res.end();
	} catch (err) { console.error('Error processing PDF:', err); res.status(500).json({ error: 'Error processing PDF' }); }
});

// ── /api/search-pdf ──
app.post('/api/search-pdf', requireAuth, async (req, res) => {
	try {
		const { query } = req.body;
		if (!query || !query.trim()) return res.status(400).json({ error: 'Query is required' });
		const { data, error } = await supabase.from('pdf_chunks').select('filename, content').ilike('content', `%${query}%`);
		if (error) throw error;
		res.json({ results: data.map(r => ({ filename: r.filename, content: r.content })) });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

app.get('/api/status', (req, res) => {
	res.json({ status: 'ok', pdfParseAvailable: !!pdfParseFunc });
});

// ── /api/search-semantic ──
app.post('/api/search-semantic', requireAuth, async (req, res) => {
	try {
		const { query } = req.body;
		if (!query || !query.trim()) return res.status(400).json({ error: 'Query is required' });
		const { data: chunks, error } = await supabase.from('pdf_chunks').select('filename, content, embedding, chunk_index').order('chunk_index', { ascending: true });
		if (error) throw error;
		const queryEmbedding = await generateEmbedding(cleanText(query));
		const similarities = chunks
			.map(chunk => ({ ...chunk, similarity: cosineSimilarity(queryEmbedding, chunk.embedding) }))
			.filter(item => item.similarity > 0.5)
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, 10)
			.map(item => {
				const prev = chunks.find(c => c.chunk_index === item.chunk_index - 1);
				const next = chunks.find(c => c.chunk_index === item.chunk_index + 1);
				return { filename: item.filename, content: item.content, context: { previous: prev?.content || null, current: item.content, next: next?.content || null }, similarity: item.similarity };
			});
		res.json({ results: similarities });
	} catch (err) { res.status(500).json({ error: 'db error' }); }
});

// ════════════════════════════════════════════════════════════════
// ── PADRÓN SUNAT — Consulta DNI / Nombre ────────────────────────
// ════════════════════════════════════════════════════════════════

// GET /api/lookup-dni/:dni
// Busca persona natural por DNI (8 dígitos) en el padrón SUNAT
// Requiere auth. Devuelve ruc + nombre.
app.get('/api/lookup-dni/:dni', requireAuth, async (req, res) => {
	try {
		const { dni } = req.params;

		if (!/^\d{8}$/.test(dni))
			return res.status(400).json({ error: 'DNI debe tener exactamente 8 dígitos' });

		// Buscar por RUC con prefijo 10 + DNI (dígito verificador desconocido → LIKE)
		const { data, error } = await supabase
			.from('padron_sunat')
			.select('ruc, nombre')
			.like('ruc', `10${dni}%`)
			.limit(1)
			.single();

		if (error || !data)
			return res.status(404).json({ error: 'DNI no encontrado en padrón SUNAT', dni });

		return res.json({
			success: true,
			fuente: 'SUNAT padrón reducido',
			data: {
				dni,
				ruc: data.ruc,
				nombre: data.nombre
			}
		});
	} catch (err) {
		console.error('lookup-dni error:', err);
		res.status(500).json({ error: 'Error interno del servidor' });
	}
});

// GET /api/lookup-nombre?q=GARCIA+JUAN&tipo=persona|empresa
// Búsqueda por nombre en el padrón SUNAT. Máx 20 resultados.
// tipo=persona (default) filtra RUC que empieza en 10.
// tipo=empresa filtra RUC que empieza en 20.
app.get('/api/lookup-nombre', requireAuth, async (req, res) => {
	try {
		const q = (req.query.q || '').trim().toUpperCase();
		const tipo = req.query.tipo === 'empresa' ? 'empresa' : 'persona';

		if (q.length < 3)
			return res.status(400).json({ error: 'Mínimo 3 caracteres para buscar' });

		let query = supabase
			.from('padron_sunat')
			.select('ruc, nombre')
			.ilike('nombre', `%${q}%`)
			.limit(20);

		// Filtrar por tipo de contribuyente via prefijo RUC
		if (tipo === 'persona') query = query.like('ruc', '10%');
		if (tipo === 'empresa') query = query.like('ruc', '20%');

		const { data, error } = await query;
		if (error) throw error;

		const results = (data || []).map(row => ({
			ruc: row.ruc,
			dni: row.ruc.startsWith('10') ? row.ruc.slice(2, 10) : null,
			nombre: row.nombre
		}));

		res.json({
			success: true,
			fuente: 'SUNAT padrón reducido',
			total: results.length,
			data: results
		});
	} catch (err) {
		console.error('lookup-nombre error:', err);
		res.status(500).json({ error: 'Error interno del servidor' });
	}
});
