require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { MongoClient, ObjectId } = require('mongodb');
let pdfParseFunc = null;

// pdf-parse v1.1.1 — exporta directamente como función
try {
	pdfParseFunc = require('pdf-parse');
	if (typeof pdfParseFunc !== 'function') {
		pdfParseFunc = pdfParseFunc.default || null;
	}
	if (pdfParseFunc) console.log('pdf-parse cargado correctamente ✓');
	else console.error('pdf-parse no pudo cargarse');
} catch (err) {
	console.error('Error cargando pdf-parse:', err.message);
}

const { pipeline } = require('@xenova/transformers');
const { OAuth2Client } = require('google-auth-library');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '903625348841-j9ed7i8hb3me77lvhp7gai175c4rr68i.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// Verificar id_token de Google — nunca confiar en email del cliente
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

// Obtener rol real desde MongoDB — nunca del cliente
async function getUserRole(email) {
	if (!email) return null;
	try {
		const col = dbClient.db(DB_NAME).collection('users');
		const user = await col.findOne({ email: String(email).toLowerCase() });
		return user ? (user.role || 'user') : null;
	} catch (err) {
		console.error('getUserRole error:', err);
		return null;
	}
}

const app = express();
// CORS dinámico
app.use(cors({
	origin: function(origin, callback) {
		if (!origin) return callback(null, true);
		if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
		callback(null, true);
	},
	credentials: true
}));
app.use(express.json());

// ── MIDDLEWARE DE AUTENTICACIÓN ──
async function requireAuth(req, res, next) {
	const authHeader = req.headers['authorization'] || '';
	const id_token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

	if (!id_token) {
		return res.status(401).json({ error: 'Token de autenticación requerido' });
	}

	const googleUser = await verifyGoogleToken(id_token);
	if (!googleUser) {
		return res.status(401).json({ error: 'Token inválido o expirado. Vuelve a iniciar sesión.' });
	}

	req.verifiedEmail = googleUser.email.toLowerCase();
	req.verifiedName  = googleUser.name;
	next();
}

// Cabeceras de seguridad básicas
app.use((req, res, next) => {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('X-Frame-Options', 'SAMEORIGIN');
	res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	next();
});

// Función para limpiar texto
function cleanText(text) {
    return text.replace(/\s+/g, ' ').trim();
}

// Función para dividir texto en chunks de ~300 palabras
function splitIntoChunks(text, maxWords = 300) {
	const words = text.split(/\s+/);
	const chunks = [];
	for (let i = 0; i < words.length; i += maxWords) {
		const chunk = words.slice(i, i + maxWords).join(' ');
		if (chunk.trim()) chunks.push(chunk);
	}
	return chunks;
}

// Función para generar embedding
async function generateEmbedding(text) {
	const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
	const output = await extractor(text, { pooling: 'mean', normalize: true });
	return Array.from(output.data);
}

// Función de similitud coseno
function cosineSimilarity(a, b) {
	const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
	const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
	const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
	return dot / (magA * magB);
}

// ===== SERVIR FRONT (ARCHIVOS SUELTOS) =====
app.use(express.static(__dirname));

// ENV
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'test';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

const SUPABASE_BUCKET = 'images';

if (!MONGODB_URI) {
	console.error('MONGODB_URI no configurado');
	process.exit(1);
}

// Supabase (opcional: solo para storage de imágenes)
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
	supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
	console.log('Supabase conectado (Storage habilitado)');
} else {
	console.warn('Supabase no configurado. Storage de imágenes deshabilitado.');
}

// Multer
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 10 * 1024 * 1024 }
});

// Mongo
let dbClient;

async function connectDb(){
	dbClient = new MongoClient(MONGODB_URI);
	await dbClient.connect();
	console.log('MongoDB conectado');
}

// Crear colecciones necesarias si no existen
async function ensureCollections(){
	try {
		const db = dbClient.db(DB_NAME);
		const collections = [
			'publications', 'publicationsadmin', 'profiles',
			'networks', 'cycles', 'events', 'users', 'pdf_chunks',
			'nexus_cases'   // ← NEXUS
		];

		for (const collName of collections) {
			const exists = await db.listCollections({ name: collName }).hasNext();
			if (!exists) {
				await db.collection(collName).insertOne({ _init: true, createdAt: new Date() });
				await db.collection(collName).deleteOne({ _init: true });
				console.log(`✓ Colección '${collName}' creada`);
			} else {
				console.log(`✓ Colección '${collName}' ya existe`);
			}
		}
	} catch (err) {
		console.warn('Advertencia al crear colecciones:', err.message);
	}
}

// Crear índices necesarios
async function ensureIndexes(){
	try {
		const db = dbClient.db(DB_NAME);
		const col = db.collection('pdf_chunks');
		await col.createIndex({ content: "text" });
		console.log('✓ Índice de texto creado en pdf_chunks');
	} catch (err) {
		console.warn('Advertencia al crear índices:', err.message);
	}
}

// --- Iniciar servidor ---
(async function startServer(){
	try {
		await connectDb();
		await ensureCollections();
		await ensureIndexes();
		const PORT = process.env.PORT || 3000;
		app.listen(PORT, () => console.log(`API listening ${PORT}`));
	} catch (err) {
		console.error('Error iniciando servidor:', err);
		process.exit(1);
	}
})();

// ===== FRONT =====
app.get('/', (req, res) => {
	res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== API =====

app.post('/api/upload', upload.single('photoFile'), async (req, res) => {
	try {
		if (!supabase) {
			return res.status(503).json({ error: 'Supabase no configurado en el servidor. Subida deshabilitada.' });
		}

		if (!req.file) return res.status(400).json({ error: 'no file' });
		const file = req.file;
		const filename = `avatar_${Date.now()}_${file.originalname.replace(/\s+/g,'_')}`;
		const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).upload(filename, file.buffer, {
			contentType: file.mimetype,
			upsert: false,
		});
		if (error) {
			console.error('supabase upload error', error);
			return res.status(500).json({ error: 'upload error' });
		}
		const { data: publicUrlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(data.path);
		const publicUrl = publicUrlData?.publicUrl || `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${data.path}`;
		console.info('Upload exitoso:', publicUrl);
		return res.json({ url: publicUrl });
	} catch (err) {
		console.error('upload error', err);
		return res.status(500).json({ error: 'server error' });
	}
});

// POST /api/upload-cover - Subir carátula de publicación
app.post('/api/upload-cover', upload.single('coverFile'), async (req, res) => {
	try {
		if (!supabase) {
			console.warn('Supabase no configurado');
			return res.status(503).json({ error: 'Supabase no configurado en el servidor. Subida deshabilitada.' });
		}

		if (!req.file) {
			console.warn('No file provided in upload request');
			return res.status(400).json({ error: 'no file provided' });
		}

		if (!SUPABASE_BUCKET) {
			console.error('SUPABASE_BUCKET no configurado');
			return res.status(500).json({ error: 'Server configuration error: bucket not set' });
		}

		const file = req.file;
		console.log(`Uploading file: ${file.originalname} (${file.size} bytes, mimetype: ${file.mimetype})`);

		const filename = `cover_${Date.now()}_${file.originalname.replace(/\s+/g,'_')}`;

		const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).upload(filename, file.buffer, {
			contentType: file.mimetype,
			upsert: false,
		});

		if (error) {
			console.error('Supabase upload error:', error);
			return res.status(500).json({ error: `Supabase upload failed: ${error.message || JSON.stringify(error)}` });
		}

		if (!data || !data.path) {
			console.error('Supabase returned no path:', data);
			return res.status(500).json({ error: 'Supabase upload returned no path' });
		}

		const { data: publicUrlData } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(data.path);
		const publicUrl = publicUrlData?.publicUrl || `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${data.path}`;
		console.info('Cover upload exitoso:', publicUrl);
		return res.json({ url: publicUrl });
	} catch (err) {
		console.error('Cover upload exception:', err.message, err);
		return res.status(500).json({ error: `Server error: ${err.message}` });
	}
});

app.get('/api/profiles', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('profiles');
		const docs = await col.find().sort({ _id: -1 }).toArray();
		const mapped = docs.map(d => ({ id: d._id.toString(), ...d }));
		res.json(mapped);
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'db error' });
	}
});

app.post('/api/profiles', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('profiles');

		if (req.body.id) {
			const _id = new ObjectId(req.body.id);
			const update = { ...req.body };
			delete update.id;

			await col.updateOne({ _id }, { $set: update });

			const updated = await col.findOne({ _id });
			updated.id = updated._id.toString();
			return res.json(updated);
		}

		const doc = { ...req.body, createdAt: new Date() };

		const r = await col.insertOne(doc);
		doc.id = r.insertedId.toString();

		res.json(doc);
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'db error' });
	}
});

app.put('/api/profiles/:id', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('profiles');
		const _id = new ObjectId(req.params.id);

		const { id, _id: ignoredId, ...dataToSet } = req.body;
		dataToSet.updatedAt = new Date();

		await col.updateOne({ _id }, { $set: dataToSet });

		const updated = await col.findOne({ _id });
		if (updated) updated.id = updated._id.toString();

		res.json(updated);
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'db error' });
	}
});

app.delete('/api/profiles/:id', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('profiles');
		const _id = new ObjectId(req.params.id);

		const result = await col.deleteOne({ _id });
		if (result.deletedCount === 0) {
			return res.status(404).json({ error: 'Perfil no encontrado' });
		}

		res.json({ success: true, message: 'Perfil eliminado' });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'Error al eliminar' });
	}
});

// NUEVAS RUTAS: redes / networks
app.get('/api/networks', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('networks');
		const docs = await col.find().sort({ _id: -1 }).toArray();
		const mapped = docs.map(d => ({ id: d._id.toString(), ...d }));
		res.json(mapped);
	} catch (err) {
		console.error('networks GET error', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.post('/api/networks', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('networks');
		const doc = { ...req.body, createdAt: new Date() };
		const r = await col.insertOne(doc);
		doc.id = r.insertedId.toString();
		res.json(doc);
	} catch (err) {
		console.error('networks POST error', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.put('/api/networks/:id', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('networks');
		const _id = new ObjectId(req.params.id);

		const { _id: _, ...dataToUpdate } = req.body;

		await col.updateOne({ _id }, { $set: dataToUpdate });

		const updated = await col.findOne({ _id });
		updated.id = updated._id.toString();
		res.json(updated);
	} catch (err) {
		console.error('networks PUT error', err);
		res.status(500).json({ error: 'db error' });
	}
});

// NUEVAS RUTAS: ciclos / groups
app.get('/api/cycles', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('cycles');
		const docs = await col.find().sort({ _id: -1 }).toArray();
		const mapped = docs.map(d => ({ id: d._id.toString(), ...d }));
		res.json(mapped);
	} catch (err) {
		console.error('cycles GET error', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.post('/api/cycles', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('cycles');
		const doc = { ...req.body, createdAt: new Date() };
		const r = await col.insertOne(doc);
		doc.id = r.insertedId.toString();
		res.json(doc);
	} catch (err) {
		console.error('cycles POST error', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.put('/api/cycles/:id', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('cycles');
		const _id = new ObjectId(req.params.id);
		const { _id: _, ...dataToUpdate } = req.body;
		dataToUpdate.updatedAt = new Date();
		await col.updateOne({ _id }, { $set: dataToUpdate });
		const updated = await col.findOne({ _id });
		updated.id = updated._id.toString();
		res.json(updated);
	} catch (err) {
		console.error('cycles PUT error', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.delete('/api/cycles/:id', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('cycles');
		const _id = new ObjectId(req.params.id);
		const result = await col.deleteOne({ _id });
		if (result.deletedCount === 0) {
			return res.status(404).json({ error: 'Ciclo no encontrado' });
		}
		res.json({ success: true });
	} catch (err) {
		console.error('cycles DELETE error', err);
		res.status(500).json({ error: 'db error' });
	}
});

// NUEVAS RUTAS: eventos / calendar events
app.get('/api/events', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('events');
		const docs = await col.find().sort({ date: 1, time: 1 }).toArray();
		const mapped = docs.map(d => ({ id: d._id.toString(), ...d }));
		res.json(mapped);
	} catch (err) {
		console.error('events GET error', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.post('/api/events', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('events');
		const doc = { ...req.body, createdAt: new Date() };
		const r = await col.insertOne(doc);
		doc.id = r.insertedId.toString();
		res.json(doc);
	} catch (err) {
		console.error('events POST error', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.put('/api/events/:id', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('events');
		const _id = new ObjectId(req.params.id);
		const { _id: _, ...dataToUpdate } = req.body;
		dataToUpdate.updatedAt = new Date();
		await col.updateOne({ _id }, { $set: dataToUpdate });
		const updated = await col.findOne({ _id });
		updated.id = updated._id.toString();
		res.json(updated);
	} catch (err) {
		console.error('events PUT error', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.delete('/api/events/:id', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('events');
		const _id = new ObjectId(req.params.id);
		const result = await col.deleteOne({ _id });
		if (result.deletedCount === 0) {
			return res.status(404).json({ error: 'Evento no encontrado' });
		}
		res.json({ success: true });
	} catch (err) {
		console.error('events DELETE error', err);
		res.status(500).json({ error: 'db error' });
	}
});

// ===== NEXUS — CASOS DE INVESTIGACIÓN =====

// GET /api/nexus-cases — listar todos los casos
app.get('/api/nexus-cases', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('nexus_cases');
		const docs = await col.find().sort({ updatedAt: -1 }).toArray();
		const mapped = docs.map(d => ({ id: d._id.toString(), ...d }));
		res.json(mapped);
	} catch (err) {
		console.error('nexus-cases GET error', err);
		res.status(500).json({ error: 'db error' });
	}
});

// POST /api/nexus-cases — crear nuevo caso
app.post('/api/nexus-cases', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('nexus_cases');
		const doc = {
			...req.body,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		const r = await col.insertOne(doc);
		doc.id = r.insertedId.toString();
		res.json(doc);
	} catch (err) {
		console.error('nexus-cases POST error', err);
		res.status(500).json({ error: 'db error' });
	}
});

// PUT /api/nexus-cases/:id — actualizar caso existente
app.put('/api/nexus-cases/:id', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('nexus_cases');
		const _id = new ObjectId(req.params.id);
		const { _id: _, id: __, ...dataToUpdate } = req.body;
		dataToUpdate.updatedAt = new Date();
		await col.updateOne({ _id }, { $set: dataToUpdate });
		const updated = await col.findOne({ _id });
		if (!updated) return res.status(404).json({ error: 'Caso no encontrado' });
		updated.id = updated._id.toString();
		res.json(updated);
	} catch (err) {
		console.error('nexus-cases PUT error', err);
		res.status(500).json({ error: 'db error' });
	}
});

// DELETE /api/nexus-cases/:id — eliminar caso
app.delete('/api/nexus-cases/:id', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('nexus_cases');
		const _id = new ObjectId(req.params.id);
		const result = await col.deleteOne({ _id });
		if (result.deletedCount === 0) {
			return res.status(404).json({ error: 'Caso no encontrado' });
		}
		res.json({ success: true });
	} catch (err) {
		console.error('nexus-cases DELETE error', err);
		res.status(500).json({ error: 'db error' });
	}
});

// ===== FIN NEXUS =====

// agregar cache simple y rate-limit en memoria para Overpass
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

		const ip = (req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown').toString();
		const arr = pruneRate(ip);
		if (arr.length >= RATE_MAX) {
			return res.status(429).json({ error: 'rate limit exceeded' });
		}
		arr.push(Date.now());
		rateMap.set(ip, arr);

		const key = String(query).slice(0, 5000);
		const cached = getCache(key);
		if (cached) {
			res.setHeader('X-Overpass-Cache', 'HIT');
			return res.status(200).type('application/json').send(cached);
		}

		const overpassUrl = 'https://overpass.openstreetmap.fr/api/interpreter';

		const overpassRes = await fetch(overpassUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Accept-Language': 'es',
				'User-Agent': 'profile-server/1.0 (+https://example.org)'
			},
			body: query,
		});

		const text = await overpassRes.text();

		if (overpassRes.ok) setCache(key, text);

		res.status(overpassRes.status).type('application/json').send(text);
	} catch (err) {
		console.error('Overpass proxy error', err);
		res.status(502).json({ error: 'overpass proxy error' });
	}
});

// ---------- User approval endpoints ----------

app.post('/request-approval', async (req, res) => {
	try {
		const { id_token } = req.body || {};
		if (!id_token) return res.status(400).json({ error: 'id_token requerido' });

		const googleUser = await verifyGoogleToken(id_token);
		if (!googleUser) return res.status(401).json({ error: 'Token de Google inválido o expirado' });

		const email = googleUser.email.toLowerCase();
		const name  = googleUser.name || email.split('@')[0];

		const col = dbClient.db(DB_NAME).collection('users');
		await col.updateOne(
			{ email },
			{ $set: { email, name, updatedAt: new Date() }, $setOnInsert: { role: 'user', approved: false, createdAt: new Date() } },
			{ upsert: true }
		);

		console.info('Usuario registrado/actualizado:', email);
		res.json({ success: true, email, name });
	} catch (err) {
		console.error('request-approval error', err);
		res.status(500).json({ error: 'server error' });
	}
});

app.get('/status', async (req, res) => {
	try {
		const { email } = req.query;
		if (!email) return res.status(400).json({ error: 'No email' });
		const col = dbClient.db(DB_NAME).collection('users');
		const user = await col.findOne({ email: String(email).toLowerCase() });
		if (!user) return res.json({ approved: false, role: 'user' });
		res.json({ approved: user.approved || false, role: user.role || 'user' });
	} catch (err) {
		console.error('status error', err);
		res.status(500).json({ error: 'server error' });
	}
});

app.post('/verify-token', async (req, res) => {
	try {
		const { id_token } = req.body || {};
		if (!id_token) return res.status(400).json({ error: 'id_token requerido' });

		const googleUser = await verifyGoogleToken(id_token);
		if (!googleUser) return res.status(401).json({ error: 'Token inválido' });

		const email = googleUser.email.toLowerCase();
		const col = dbClient.db(DB_NAME).collection('users');
		const user = await col.findOne({ email });

		res.json({
			email,
			name: googleUser.name,
			approved: user ? (user.approved || false) : false,
			role: user ? (user.role || 'user') : 'user'
		});
	} catch (err) {
		console.error('verify-token error', err);
		res.status(500).json({ error: 'server error' });
	}
});

// ===== BIBLIOTECA DIGITAL - PUBLICACIONES =====

app.get('/api/publications', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('publications');
		const publications = await col.find({}).sort({ title: 1 }).toArray();
		const mapped = publications.map(p => ({ _id: p._id.toString(), ...p }));
		res.json(mapped);
	} catch (err) {
		console.error('Error obteniendo publicaciones:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.get('/api/publications-admin', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		const publications = await col.find({}).sort({ title: 1 }).toArray();
		const mapped = publications.map(p => ({ _id: p._id.toString(), ...p }));
		res.json(mapped);
	} catch (err) {
		console.error('Error obteniendo publicaciones admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.post('/api/publications', requireAuth, async (req, res) => {
	try {
		const author = req.verifiedEmail;
		const { title, subtitle, keywords, content, role, coverUrl } = req.body;

		if (!title || !title.trim()) return res.status(400).json({ error: 'El título es requerido' });
		if (!content || !content.trim()) return res.status(400).json({ error: 'El contenido es requerido' });
		if (!author) return res.status(400).json({ error: 'Usuario no autenticado' });

		const realRole = await getUserRole(author);
		if (!realRole || (realRole !== 'user' && realRole !== 'admin')) {
			return res.status(403).json({ error: 'No tienes permiso para publicar' });
		}

		const col = dbClient.db(DB_NAME).collection('publications');
		const publication = {
			title: title.trim(), subtitle: subtitle ? subtitle.trim() : '',
			keywords: Array.isArray(keywords) ? keywords : [],
			content: content.trim(), author, role, coverUrl: coverUrl || null,
			publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date()
		};

		const result = await col.insertOne(publication);
		publication._id = result.insertedId.toString();
		res.json(publication);
	} catch (err) {
		console.error('Error creando publicación:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.post('/api/publications-admin', requireAuth, async (req, res) => {
	try {
		const author = req.verifiedEmail;
		const { title, subtitle, keywords, content, role, coverUrl } = req.body;

		if (!title || !title.trim()) return res.status(400).json({ error: 'El título es requerido' });
		if (!content || !content.trim()) return res.status(400).json({ error: 'El contenido es requerido' });
		if (!author) return res.status(400).json({ error: 'Usuario no autenticado' });

		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		const publication = {
			title: title.trim(), subtitle: subtitle ? subtitle.trim() : '',
			keywords: Array.isArray(keywords) ? keywords : [],
			content: content.trim(), author, role, coverUrl: coverUrl || null,
			publishedAt: new Date(), createdAt: new Date(), updatedAt: new Date()
		};

		const result = await col.insertOne(publication);
		publication._id = result.insertedId.toString();
		res.json(publication);
	} catch (err) {
		console.error('Error creando publicación en admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.put('/api/publications/:id', requireAuth, async (req, res) => {
	try {
		const userEmail = req.verifiedEmail;
		const { title, subtitle, keywords, content, coverUrl } = req.body || {};
		const publicationId = req.params.id;

		if (!userEmail) return res.status(401).json({ error: 'Usuario no autenticado' });
		if (!title || !title.trim()) return res.status(400).json({ error: 'El título es requerido' });
		if (!content || !content.trim()) return res.status(400).json({ error: 'El contenido es requerido' });
		if (!publicationId || publicationId.length !== 24) return res.status(400).json({ error: 'ID de publicación inválido' });

		const col = dbClient.db(DB_NAME).collection('publications');
		const publication = await col.findOne({ _id: new ObjectId(publicationId) });

		if (!publication) return res.status(404).json({ error: 'Publicación no encontrada' });
		if (publication.author !== userEmail) return res.status(403).json({ error: 'Solo puedes editar tus propias publicaciones' });

		const updateResult = await col.updateOne(
			{ _id: new ObjectId(publicationId) },
			{ $set: { title: title.trim(), subtitle: subtitle ? subtitle.trim() : '', keywords: Array.isArray(keywords) ? keywords : [], content: content.trim(), coverUrl: coverUrl || null, updatedAt: new Date() } }
		);

		if (updateResult.modifiedCount === 0) return res.status(500).json({ error: 'No se pudo actualizar la publicación' });

		const updatedPublication = await col.findOne({ _id: new ObjectId(publicationId) });
		res.json(updatedPublication);
	} catch (err) {
		console.error('Error editando publicación:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.delete('/api/publications/:id', requireAuth, async (req, res) => {
	try {
		const userEmail = req.verifiedEmail;
		const publicationId = req.params.id;
		if (!publicationId || publicationId.length !== 24) return res.status(400).json({ error: 'ID inválido' });

		const realRole = await getUserRole(userEmail);
		const col = dbClient.db(DB_NAME).collection('publications');
		const publication = await col.findOne({ _id: new ObjectId(publicationId) });
		if (!publication) return res.status(404).json({ error: 'Publicación no encontrada' });

		if (realRole !== 'admin' && publication.author !== userEmail) {
			return res.status(403).json({ error: 'No tienes permiso para eliminar esta publicación' });
		}

		await col.deleteOne({ _id: new ObjectId(publicationId) });
		res.json({ success: true, message: 'Publicación eliminada correctamente' });
	} catch (err) {
		console.error('Error eliminando publicación:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.put('/api/publications-admin/:id', requireAuth, async (req, res) => {
	try {
		const userEmail = req.verifiedEmail;
		const { title, subtitle, keywords, content, coverUrl } = req.body || {};
		const publicationId = req.params.id;

		if (!userEmail) return res.status(401).json({ error: 'Usuario no autenticado' });
		if (!title || !title.trim()) return res.status(400).json({ error: 'El título es requerido' });
		if (!content || !content.trim()) return res.status(400).json({ error: 'El contenido es requerido' });
		if (!publicationId || publicationId.length !== 24) return res.status(400).json({ error: 'ID de publicación inválido' });

		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		const publication = await col.findOne({ _id: new ObjectId(publicationId) });

		if (!publication) return res.status(404).json({ error: 'Publicación no encontrada' });
		if (publication.author !== userEmail) return res.status(403).json({ error: 'Solo puedes editar tus propias publicaciones' });

		const updateResult = await col.updateOne(
			{ _id: new ObjectId(publicationId) },
			{ $set: { title: title.trim(), subtitle: subtitle ? subtitle.trim() : '', keywords: Array.isArray(keywords) ? keywords : [], content: content.trim(), coverUrl: coverUrl || null, updatedAt: new Date() } }
		);

		if (updateResult.modifiedCount === 0) return res.status(500).json({ error: 'No se pudo actualizar la publicación' });

		const updatedPublication = await col.findOne({ _id: new ObjectId(publicationId) });
		res.json(updatedPublication);
	} catch (err) {
		console.error('Error editando publicación admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.delete('/api/publications-admin/:id', requireAuth, async (req, res) => {
	try {
		const userEmail = req.verifiedEmail;
		const publicationId = req.params.id;
		if (!publicationId || publicationId.length !== 24) return res.status(400).json({ error: 'ID inválido' });

		const realRole = await getUserRole(userEmail);
		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		const publication = await col.findOne({ _id: new ObjectId(publicationId) });
		if (!publication) return res.status(404).json({ error: 'Publicación no encontrada' });

		if (realRole !== 'admin' && publication.author !== userEmail) {
			return res.status(403).json({ error: 'No tienes permiso para eliminar esta publicación' });
		}

		await col.deleteOne({ _id: new ObjectId(publicationId) });
		res.json({ success: true, message: 'Publicación eliminada correctamente' });
	} catch (err) {
		console.error('Error eliminando publicación admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.post('/api/publications/search', async (req, res) => {
	try {
		const { title, keywords, dateFrom, dateTo } = req.body || {};
		const col = dbClient.db(DB_NAME).collection('publications');
		const query = {};

		if (title && title.trim()) query.title = { $regex: title.trim(), $options: 'i' };
		if (keywords && Array.isArray(keywords) && keywords.length > 0) query.keywords = { $in: keywords };
		if (dateFrom || dateTo) {
			query.publishedAt = {};
			if (dateFrom) query.publishedAt.$gte = new Date(dateFrom);
			if (dateTo) { const date = new Date(dateTo); date.setHours(23,59,59,999); query.publishedAt.$lte = date; }
		}

		const publications = await col.find(query).sort({ title: 1 }).toArray();
		res.json(publications.map(p => ({ _id: p._id.toString(), ...p })));
	} catch (err) {
		console.error('Error en búsqueda avanzada:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.post('/api/publications-admin/search', async (req, res) => {
	try {
		const { title, keywords, dateFrom, dateTo } = req.body || {};
		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		const query = {};

		if (title && title.trim()) query.title = { $regex: title.trim(), $options: 'i' };
		if (keywords && Array.isArray(keywords) && keywords.length > 0) query.keywords = { $in: keywords };
		if (dateFrom || dateTo) {
			query.publishedAt = {};
			if (dateFrom) query.publishedAt.$gte = new Date(dateFrom);
			if (dateTo) { const date = new Date(dateTo); date.setHours(23,59,59,999); query.publishedAt.$lte = date; }
		}

		const publications = await col.find(query).sort({ title: 1 }).toArray();
		res.json(publications.map(p => ({ _id: p._id.toString(), ...p })));
	} catch (err) {
		console.error('Error en búsqueda avanzada admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// POST /api/upload-pdf - Subir y procesar PDF
app.post('/api/upload-pdf', upload.single('pdfFile'), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: 'No file provided' });

		const file = req.file;
		if (file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files are allowed' });

		const col = dbClient.db(DB_NAME).collection('pdf_chunks');
		await col.deleteMany({});

		if (!pdfParseFunc || typeof pdfParseFunc !== 'function') {
			console.error('pdfParseFunc no está disponible');
			return res.status(500).json({ error: 'pdfParse no está disponible. Reinstala pdf-parse.' });
		}

		const data = await pdfParseFunc(file.buffer);
		let text = data.text;
		text = cleanText(text);
		const chunks = splitIntoChunks(text, 300);

		const pdfId = new ObjectId();
		const chunkDocs = [];

		const buildChunks = async (chunkList, isOcr = false) => {
			for (let i = 0; i < chunkList.length; i++) {
				const chunk = chunkList[i].trim();
				if (chunk) {
					const embedding = await generateEmbedding(chunk);
					chunkDocs.push({
						pdfId, filename: file.originalname,
						chunkIndex: chunkDocs.length,
						content: chunk, embedding,
						uploadedAt: new Date(), ocr: isOcr
					});
				}
			}
		};

		await buildChunks(chunks, false);

		if (chunkDocs.length === 0) {
			let Tesseract = null;
			try { Tesseract = require('tesseract.js'); } catch(e) {}
			if (!Tesseract) {
				return res.status(400).json({
					error: 'Este PDF es una imagen escaneada y no contiene texto extraible. Solo funcionan PDFs con texto real.',
					scanned: true
				});
			}
			console.log('PDF sin texto, iniciando OCR...');
			try {
				const { data: { text: ocrText } } = await Tesseract.recognize(
					file.buffer, 'spa+eng',
					{ logger: m => { if (m.status === 'recognizing text') process.stdout.write('\rOCR: ' + Math.round(m.progress*100) + '%'); } }
				);
				console.log('\nOCR completado.');
				if (!ocrText || !ocrText.trim()) return res.status(400).json({ error: 'OCR no pudo extraer texto.' });
				await buildChunks(splitIntoChunks(cleanText(ocrText), 300), true);
				if (chunkDocs.length === 0) return res.status(400).json({ error: 'OCR sin texto legible.' });
				await col.insertMany(chunkDocs);
				return res.json({ success: true, ocr: true, message: `PDF escaneado procesado con OCR en ${chunkDocs.length} fragmentos.` });
			} catch (ocrErr) {
				return res.status(500).json({ error: 'Error en OCR: ' + ocrErr.message });
			}
		}

		await col.insertMany(chunkDocs);
		res.json({ success: true, message: `PDF processed into ${chunks.length} chunks with embeddings. Previous data cleared.` });
	} catch (err) {
		console.error('Error processing PDF:', err);
		res.status(500).json({ error: `Error processing PDF: ${err.message}` });
	}
});

// POST /api/search-pdf - Buscar en PDFs
app.post('/api/search-pdf', async (req, res) => {
	try {
		const { query } = req.body;
		if (!query || !query.trim()) return res.status(400).json({ error: 'Query is required' });

		const col = dbClient.db(DB_NAME).collection('pdf_chunks');
		const results = await col.find(
			{ $text: { $search: query } },
			{ score: { $meta: "textScore" } }
		).sort({ score: { $meta: "textScore" } }).toArray();

		res.json({ results: results.map(r => ({ filename: r.filename, content: r.content, score: r.score })) });
	} catch (err) {
		console.error('Error searching PDFs:', err);
		res.status(500).json({ error: 'db error' });
	}
});

app.get('/api/status', (req, res) => {
	res.json({ status: 'ok', pdfParseAvailable: !!pdfParseFunc });
});

// POST /api/search-semantic - Búsqueda semántica en PDFs
app.post('/api/search-semantic', async (req, res) => {
	try {
		const { query } = req.body;
		if (!query || !query.trim()) return res.status(400).json({ error: 'Query is required' });

		const col = dbClient.db(DB_NAME).collection('pdf_chunks');
		const chunks = await col.find({}, { projection: { filename: 1, content: 1, embedding: 1, chunkIndex: 1 } }).sort({ chunkIndex: 1 }).toArray();

		const queryEmbedding = await generateEmbedding(cleanText(query));

		const similarities = chunks.map(chunk => ({
			...chunk,
			similarity: cosineSimilarity(queryEmbedding, chunk.embedding)
		})).filter(item => item.similarity > 0.5);

		similarities.sort((a, b) => b.similarity - a.similarity);

		const results = similarities.slice(0, 10).map(item => {
			const prev = chunks.find(c => c.chunkIndex === item.chunkIndex - 1);
			const next = chunks.find(c => c.chunkIndex === item.chunkIndex + 1);
			return {
				filename: item.filename,
				content: item.content,
				context: {
					previous: prev ? prev.content : null,
					current: item.content,
					next: next ? next.content : null
				},
				similarity: item.similarity
			};
		});

		res.json({ results });
	} catch (err) {
		console.error('Error in semantic search:', err);
		res.status(500).json({ error: 'db error' });
	}
});
