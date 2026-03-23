require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { MongoClient, ObjectId } = require('mongodb');
let pdfParseFunc = null;

try {
	const pdfParseModule = require('pdf-parse');
	console.log('pdf-parse module initial type:', typeof pdfParseModule);
	console.log('pdf-parse module keys:', Object.keys(pdfParseModule));
	console.log('pdf-parse module value:', pdfParseModule);
	if (typeof pdfParseModule === 'function') {
		pdfParseFunc = pdfParseModule;
	} else if (pdfParseModule && typeof pdfParseModule.default === 'function') {
		pdfParseFunc = pdfParseModule.default;
		console.log('pdf-parse using default export');
	} else if (pdfParseModule && pdfParseModule.PDFParse) {
		pdfParseFunc = pdfParseModule.PDFParse;
		console.log('pdf-parse using PDFParse class');
	} else {
		console.warn('pdf-parse loaded but not a function:', typeof pdfParseModule, 'default=', typeof (pdfParseModule && pdfParseModule.default));
	}
} catch (err) {
	console.error('Error requiring pdf-parse:', err);
}

const { pipeline } = require('@xenova/transformers');

const app = express();
app.use(cors({
	origin: function(origin, callback) {
		if (!origin) return callback(null, true);
		if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
		callback(null, true);
	},
	credentials: true
}));
app.use(express.json());

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
		const collections = ['publications', 'publicationsadmin', 'profiles', 'networks', 'cycles', 'events', 'users', 'pdf_chunks'];
		
		for (const collName of collections) {
			const exists = await db.listCollections({ name: collName }).hasNext();
			if (!exists) {
				// Insertar documento inicial para crear la colección
				await db.collection(collName).insertOne({ _init: true, createdAt: new Date() });
				// Eliminar el documento inicial
				await db.collection(collName).deleteOne({ _init: true });
				console.log(`✓ Colección '${collName}' creada`);
			} else {
				console.log(`✓ Colección '${collName}' ya existe`);
			}
		}
	} catch (err) {
		console.warn('Advertencia al crear colecciones:', err.message);
		// No detener el servidor si falla esto
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

// --- Reemplazado: iniciar servidor solo después de connectDb() exitoso ---
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
		// si supabase no está configurado, devolver 503
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
		// construir URL pública correctamente
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
		// si supabase no está configurado, devolver 503
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

		// construir URL pública correctamente
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

		// Do not allow changing _id; remove id/_id from payload
		const { id, _id: ignoredId, ...dataToSet } = req.body;
		// set updatedAt
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
		// body: { name, nodes: [{profileId, stats}], links: [{source,target}] }
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
		
		// eliminar _id del payload antes de actualizar (es inmutable en MongoDB)
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

// agregar cache simple y rate-limit en memoria para Overpass
const overpassCache = new Map(); // key -> { expires: ts, body: string }
const OVERPASS_CACHE_TTL = 60 * 1000; // 60s cache
const rateMap = new Map(); // ip -> [timestamps]
const RATE_WINDOW = 5 * 60 * 1000; // 5 minutos
const RATE_MAX = 300; // max requests por IP en ventana

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

// agregar ruta proxy para Overpass (evita CORS en el cliente)
// versión mejorada: cache + User-Agent + rate-limit
app.post('/api/overpass', express.text({ type: '*/*' }), async (req, res) => {
	try {
		const query = req.body;
		if (!query || !query.trim()) return res.status(400).json({ error: 'empty query' });

		// rate-limit simple por IP
		const ip = (req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown').toString();
		const arr = pruneRate(ip);
		if (arr.length >= RATE_MAX) {
			return res.status(429).json({ error: 'rate limit exceeded' });
		}
		arr.push(Date.now());
		rateMap.set(ip, arr);

		// cache key (truncate long queries)
		const key = String(query).slice(0, 5000);
		const cached = getCache(key);
		if (cached) {
			res.setHeader('X-Overpass-Cache', 'HIT');
			return res.status(200).type('application/json').send(cached);
		}

		const overpassUrl = 'https://overpass.openstreetmap.fr/api/interpreter';

		// reenviar con headers de cortesía para evitar bloqueos por User-Agent y mejorar compatibilidad
		const overpassRes = await fetch(overpassUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/plain',
				'Accept-Language': 'es',
				'User-Agent': 'profile-server/1.0 (+https://example.org)'
			},
			body: query,
			// timeout/redirects: confiar en defaults
		});

		const text = await overpassRes.text();

		// cachear solo respuestas 200
		if (overpassRes.ok) setCache(key, text);

		res.status(overpassRes.status).type('application/json').send(text);
	} catch (err) {
		console.error('Overpass proxy error', err);
		res.status(502).json({ error: 'overpass proxy error' });
	}
});

// ---------- User approval endpoints (MongoDB users collection) ----------

// POST /request-approval
// body: { email, name }
app.post('/request-approval', async (req, res) => {
	try {
		const body = req.body || {};
		let { email, name } = body;

		if (!email || typeof email !== 'string') return res.status(400).json({ error: 'No email' });
		email = String(email).trim().toLowerCase();

		// basic email validation
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

		if (name && typeof name === 'string') {
			name = String(name).trim().slice(0, 120);
		} else {
			name = email.split('@')[0];
		}

		// Upsert user into MongoDB 'users' collection with defaults (approved=false, role='user')
		const col = dbClient.db(DB_NAME).collection('users');
		
		const upsertResult = await col.updateOne(
			{ email },
			{ $set: { email, name, updatedAt: new Date() }, $setOnInsert: { role: 'user', approved: false, createdAt: new Date() } },
			{ upsert: true }
		);

		console.info('Approval requested for user (stored in MongoDB):', email);
		res.json({ success: true });
	} catch (err) {
		console.error('request-approval error', err);
		res.status(500).json({ error: 'server error' });
	}
});

// GET /status?email=...  -> returns { approved, role }
app.get('/status', async (req, res) => {
	try {
		const { email } = req.query;
		if (!email) return res.status(400).json({ error: 'No email' });

		const col = dbClient.db(DB_NAME).collection('users');
		const user = await col.findOne({ email: String(email).toLowerCase() });

		if (!user) {
			return res.json({ approved: false, role: 'user' });
		}

		res.json({ approved: user.approved || false, role: user.role || 'user' });
	} catch (err) {
		console.error('status error', err);
		res.status(500).json({ error: 'server error' });
	}
});

// ===== BIBLIOTECA DIGITAL - PUBLICACIONES =====

// GET /api/publications - Obtener publicaciones de BIBLIOTECA NORMAL (admin y user)
app.get('/api/publications', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('publications');
		const publications = await col.find({}).sort({ title: 1 }).toArray();
		
		const mapped = publications.map(p => ({
			_id: p._id.toString(),
			...p
		}));
		
		res.json(mapped);
	} catch (err) {
		console.error('Error obteniendo publicaciones:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// GET /api/publications-admin - Obtener publicaciones de BIBLIOTECA ADMIN (independiente)
app.get('/api/publications-admin', async (req, res) => {
	try {
		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		const publications = await col.find({}).sort({ title: 1 }).toArray();
		
		const mapped = publications.map(p => ({
			_id: p._id.toString(),
			...p
		}));
		
		res.json(mapped);
	} catch (err) {
		console.error('Error obteniendo publicaciones admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// POST /api/publications - Crear nueva publicación en BIBLIOTECA NORMAL
app.post('/api/publications', async (req, res) => {
	try {
		const { title, subtitle, keywords, content, author, role, coverUrl } = req.body;

		// Validaciones
		if (!title || !title.trim()) {
			return res.status(400).json({ error: 'El título es requerido' });
		}

		if (!content || !content.trim()) {
			return res.status(400).json({ error: 'El contenido es requerido' });
		}

		if (!author) {
			return res.status(400).json({ error: 'Usuario no autenticado' });
		}

		// Solo usuarios y administradores pueden publicar
		if (role !== 'user' && role !== 'admin') {
			return res.status(403).json({ error: 'Rol no autorizado para publicar' });
		}

		const col = dbClient.db(DB_NAME).collection('publications');
		
		const publication = {
			title: title.trim(),
			subtitle: subtitle ? subtitle.trim() : '',
			keywords: Array.isArray(keywords) ? keywords : [],
			content: content.trim(),
			author: author,
			role: role,
			coverUrl: coverUrl || null,

			publishedAt: new Date(),
			createdAt: new Date(),
			updatedAt: new Date()
		};

		const result = await col.insertOne(publication);
		publication._id = result.insertedId.toString();

		res.json(publication);
	} catch (err) {
		console.error('Error creando publicación:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// POST /api/publications-admin - Crear nueva publicación en BIBLIOTECA ADMIN (independiente)
app.post('/api/publications-admin', async (req, res) => {
	try {
		const { title, subtitle, keywords, content, author, role, coverUrl } = req.body;

		// Validaciones
		if (!title || !title.trim()) {
			return res.status(400).json({ error: 'El título es requerido' });
		}

		if (!content || !content.trim()) {
			return res.status(400).json({ error: 'El contenido es requerido' });
		}

		if (!author) {
			return res.status(400).json({ error: 'Usuario no autenticado' });
		}

		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		
		const publication = {
			title: title.trim(),
			subtitle: subtitle ? subtitle.trim() : '',
			keywords: Array.isArray(keywords) ? keywords : [],
			content: content.trim(),
			author: author,
			role: role,
			coverUrl: coverUrl || null,
			publishedAt: new Date(),
			createdAt: new Date(),
			updatedAt: new Date()
		};

		const result = await col.insertOne(publication);
		publication._id = result.insertedId.toString();

		res.json(publication);
	} catch (err) {
		console.error('Error creando publicación en admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// PUT /api/publications/:id - Editar publicación (SOLO AUTOR)
app.put('/api/publications/:id', async (req, res) => {
	try {
		const { userEmail, title, subtitle, keywords, content, coverUrl } = req.body || {};
		const publicationId = req.params.id;

		if (!userEmail) {
			return res.status(401).json({ error: 'Usuario no autenticado' });
		}

		if (!title || !title.trim()) {
			return res.status(400).json({ error: 'El título es requerido' });
		}

		if (!content || !content.trim()) {
			return res.status(400).json({ error: 'El contenido es requerido' });
		}

		// Validar que el ID es un ObjectId válido
		if (!publicationId || publicationId.length !== 24) {
			return res.status(400).json({ error: 'ID de publicación inválido' });
		}

		const col = dbClient.db(DB_NAME).collection('publications');
		const publication = await col.findOne({ _id: new ObjectId(publicationId) });

		if (!publication) {
			return res.status(404).json({ error: 'Publicación no encontrada' });
		}

		// SOLO el autor puede editar (NO ADMIN)
		if (publication.author !== userEmail) {
			return res.status(403).json({ error: 'Solo puedes editar tus propias publicaciones' });
		}

		const updateResult = await col.updateOne(
			{ _id: new ObjectId(publicationId) },
			{
				$set: {
					title: title.trim(),
					subtitle: subtitle ? subtitle.trim() : '',
					keywords: Array.isArray(keywords) ? keywords : [],
					content: content.trim(),
					coverUrl: coverUrl || null,
					updatedAt: new Date()
				}
			}
		);

		if (updateResult.modifiedCount === 0) {
			return res.status(500).json({ error: 'No se pudo actualizar la publicación' });
		}

		const updatedPublication = await col.findOne({ _id: new ObjectId(publicationId) });
		res.json(updatedPublication);
	} catch (err) {
		console.error('Error editando publicación:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// DELETE /api/publications/:id - Eliminar publicación
app.delete('/api/publications/:id', async (req, res) => {
	try {
		const { userEmail, userRole } = req.body || {};
		const publicationId = req.params.id;

		if (!userEmail) {
			return res.status(401).json({ error: 'Usuario no autenticado' });
		}

		// Validar que el ID es un ObjectId válido
		if (!publicationId || publicationId.length !== 24) {
			return res.status(400).json({ error: 'ID de publicación inválido' });
		}

		const col = dbClient.db(DB_NAME).collection('publications');
		const publication = await col.findOne({ _id: new ObjectId(publicationId) });

		if (!publication) {
			return res.status(404).json({ error: 'Publicación no encontrada' });
		}

		// Los admins pueden eliminar cualquier publicación
		// Los usuarios solo pueden eliminar las suyas
		const isAdmin = userRole === 'admin';
		const isAuthor = publication.author === userEmail;

		if (!isAdmin && !isAuthor) {
			return res.status(403).json({ error: 'No tienes permiso para eliminar esta publicación' });
		}

		await col.deleteOne({ _id: new ObjectId(publicationId) });

		res.json({ success: true, message: 'Publicación eliminada correctamente' });
	} catch (err) {
		console.error('Error eliminando publicación:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// PUT /api/publications-admin/:id - Editar publicación en BIBLIOTECA ADMIN
app.put('/api/publications-admin/:id', async (req, res) => {
	try {
		const { userEmail, title, subtitle, keywords, content, coverUrl } = req.body || {};
		const publicationId = req.params.id;

		if (!userEmail) {
			return res.status(401).json({ error: 'Usuario no autenticado' });
		}

		if (!title || !title.trim()) {
			return res.status(400).json({ error: 'El título es requerido' });
		}

		if (!content || !content.trim()) {
			return res.status(400).json({ error: 'El contenido es requerido' });
		}

		if (!publicationId || publicationId.length !== 24) {
			return res.status(400).json({ error: 'ID de publicación inválido' });
		}

		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		const publication = await col.findOne({ _id: new ObjectId(publicationId) });

		if (!publication) {
			return res.status(404).json({ error: 'Publicación no encontrada' });
		}

		// SOLO el autor puede editar
		if (publication.author !== userEmail) {
			return res.status(403).json({ error: 'Solo puedes editar tus propias publicaciones' });
		}

		const updateResult = await col.updateOne(
			{ _id: new ObjectId(publicationId) },
			{
				$set: {
					title: title.trim(),
					subtitle: subtitle ? subtitle.trim() : '',
					keywords: Array.isArray(keywords) ? keywords : [],
					content: content.trim(),
					coverUrl: coverUrl || null,
					updatedAt: new Date()
				}
			}
		);

		if (updateResult.modifiedCount === 0) {
			return res.status(500).json({ error: 'No se pudo actualizar la publicación' });
		}

		const updatedPublication = await col.findOne({ _id: new ObjectId(publicationId) });
		res.json(updatedPublication);
	} catch (err) {
		console.error('Error editando publicación admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// DELETE /api/publications-admin/:id - Eliminar publicación en BIBLIOTECA ADMIN
app.delete('/api/publications-admin/:id', async (req, res) => {
	try {
		const { userEmail, userRole } = req.body || {};
		const publicationId = req.params.id;

		if (!userEmail) {
			return res.status(401).json({ error: 'Usuario no autenticado' });
		}

		if (!publicationId || publicationId.length !== 24) {
			return res.status(400).json({ error: 'ID de publicación inválido' });
		}

		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		const publication = await col.findOne({ _id: new ObjectId(publicationId) });

		if (!publication) {
			return res.status(404).json({ error: 'Publicación no encontrada' });
		}

		const isAdmin = userRole === 'admin';
		const isAuthor = publication.author === userEmail;

		if (!isAdmin && !isAuthor) {
			return res.status(403).json({ error: 'No tienes permiso para eliminar esta publicación' });
		}

		await col.deleteOne({ _id: new ObjectId(publicationId) });

		res.json({ success: true, message: 'Publicación eliminada correctamente' });
	} catch (err) {
		console.error('Error eliminando publicación admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// GET /api/publications/search - Búsqueda avanzada (BIBLIOTECA NORMAL)
app.post('/api/publications/search', async (req, res) => {
	try {
		const { title, keywords, dateFrom, dateTo } = req.body || {};
		
		const col = dbClient.db(DB_NAME).collection('publications');
		const query = {};

		// Búsqueda por título
		if (title && title.trim()) {
			query.title = { $regex: title.trim(), $options: 'i' };
		}

		// Búsqueda por palabras clave
		if (keywords && Array.isArray(keywords) && keywords.length > 0) {
			query.keywords = { $in: keywords };
		}

		// Búsqueda por rango de fechas
		if (dateFrom || dateTo) {
			query.publishedAt = {};
			if (dateFrom) {
				query.publishedAt.$gte = new Date(dateFrom);
			}
			if (dateTo) {
				const date = new Date(dateTo);
				date.setHours(23, 59, 59, 999);
				query.publishedAt.$lte = date;
			}
		}

		const publications = await col.find(query).sort({ title: 1 }).toArray();
		
		const mapped = publications.map(p => ({
			_id: p._id.toString(),
			...p
		}));
		
		res.json(mapped);
	} catch (err) {
		console.error('Error en búsqueda avanzada:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// POST /api/publications-admin/search - Búsqueda avanzada (BIBLIOTECA ADMIN)
app.post('/api/publications-admin/search', async (req, res) => {
	try {
		const { title, keywords, dateFrom, dateTo } = req.body || {};
		
		const col = dbClient.db(DB_NAME).collection('publicationsadmin');
		const query = {};

		// Búsqueda por título
		if (title && title.trim()) {
			query.title = { $regex: title.trim(), $options: 'i' };
		}

		// Búsqueda por palabras clave
		if (keywords && Array.isArray(keywords) && keywords.length > 0) {
			query.keywords = { $in: keywords };
		}

		// Búsqueda por rango de fechas
		if (dateFrom || dateTo) {
			query.publishedAt = {};
			if (dateFrom) {
				query.publishedAt.$gte = new Date(dateFrom);
			}
			if (dateTo) {
				const date = new Date(dateTo);
				date.setHours(23, 59, 59, 999);
				query.publishedAt.$lte = date;
			}
		}

		const publications = await col.find(query).sort({ title: 1 }).toArray();
		
		const mapped = publications.map(p => ({
			_id: p._id.toString(),
			...p
		}));
		
		res.json(mapped);
	} catch (err) {
		console.error('Error en búsqueda avanzada admin:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// POST /api/upload-pdf - Subir y procesar PDF
app.post('/api/upload-pdf', upload.single('pdfFile'), async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).json({ error: 'No file provided' });
		}

		const file = req.file;
		if (file.mimetype !== 'application/pdf') {
			return res.status(400).json({ error: 'Only PDF files are allowed' });
		}

		// Eliminar datos previos completamente
		const col = dbClient.db(DB_NAME).collection('pdf_chunks');
		await col.deleteMany({});

		// Validación adicional pdf-parse
		if (!pdfParseFunc || typeof pdfParseFunc !== 'function') {
			console.error('pdfParseFunc no está disponible');
			return res.status(500).json({ error: 'pdfParse no está disponible. Reinstala pdf-parse.' });
		}

		// Extraer texto del PDF
		const data = await pdfParseFunc(file.buffer);
		let text = data.text;

		// Limpiar texto
		text = cleanText(text);

		// Dividir en chunks (~300 palabras)
		const chunks = splitIntoChunks(text, 300);

		// Generar embeddings y guardar chunks
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

		// Si no hay texto, intentar OCR con tesseract.js
		if (chunkDocs.length === 0) {
			let Tesseract = null;
			try { Tesseract = require('tesseract.js'); } catch(e) {}

			if (!Tesseract) {
				return res.status(400).json({
					error: 'Este PDF es una imagen escaneada y no contiene texto extraible. Instala tesseract.js para habilitar OCR.'
				});
			}

			console.log('PDF sin texto, iniciando OCR con tesseract.js...');
			try {
				const { data: { text: ocrText } } = await Tesseract.recognize(
					file.buffer, 'spa+eng',
					{ logger: m => { if (m.status === 'recognizing text') process.stdout.write('\rOCR: ' + Math.round(m.progress*100) + '%'); } }
				);
				console.log('\nOCR completado.');

				if (!ocrText || !ocrText.trim()) {
					return res.status(400).json({ error: 'OCR no pudo extraer texto legible del PDF.' });
				}

				const ocrChunks = splitIntoChunks(cleanText(ocrText), 300);
				await buildChunks(ocrChunks, true);

				if (chunkDocs.length === 0) {
					return res.status(400).json({ error: 'OCR completado pero no se encontró texto legible.' });
				}

				await col.insertMany(chunkDocs);
				text = null;
				return res.json({
					success: true, ocr: true,
					message: `PDF escaneado procesado con OCR en ${chunkDocs.length} fragmentos. Puede tardar más de lo normal.`
				});
			} catch (ocrErr) {
				return res.status(500).json({ error: 'Error en OCR: ' + ocrErr.message });
			}
		}

		await col.insertMany(chunkDocs);
		text = null;
		res.json({ success: true, message: `PDF procesado en ${chunkDocs.length} fragmentos correctamente.` });
	} catch (err) {
		console.error('Error processing PDF:', err);
		res.status(500).json({ error: `Error processing PDF: ${err.message}` });
	}
});

// POST /api/search-pdf - Buscar en PDFs
app.post('/api/search-pdf', async (req, res) => {
	try {
		const { query } = req.body;
		if (!query || !query.trim()) {
			return res.status(400).json({ error: 'Query is required' });
		}

		const col = dbClient.db(DB_NAME).collection('pdf_chunks');
		const results = await col.find(
			{ $text: { $search: query } },
			{ score: { $meta: "textScore" } }
		).sort({ score: { $meta: "textScore" } }).toArray();

		const formattedResults = results.map(r => ({
			filename: r.filename,
			content: r.content,
			score: r.score
		}));

		res.json({ results: formattedResults });
	} catch (err) {
		console.error('Error searching PDFs:', err);
		res.status(500).json({ error: 'db error' });
	}
});

// POST /api/search-semantic - Búsqueda semántica en PDFs
app.get('/api/status', (req, res) => {
	res.json({ status: 'ok', pdfParseAvailable: !!pdfParseFunc });
});

app.post('/api/search-semantic', async (req, res) => {
	try {
		const { query } = req.body;
		if (!query || !query.trim()) {
			return res.status(400).json({ error: 'Query is required' });
		}

		const col = dbClient.db(DB_NAME).collection('pdf_chunks');
		const chunks = await col.find({}, { projection: { filename: 1, content: 1, embedding: 1, chunkIndex: 1 } }).sort({ chunkIndex: 1 }).toArray();

		const queryEmbedding = await generateEmbedding(cleanText(query));

		const similarities = chunks.map(chunk => ({
			...chunk,
			similarity: cosineSimilarity(queryEmbedding, chunk.embedding)
		})).filter(item => item.similarity > 0.5); // Threshold

		similarities.sort((a, b) => b.similarity - a.similarity);

		// Incluir contexto: chunk + anterior + siguiente
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
