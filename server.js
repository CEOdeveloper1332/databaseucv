const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

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

if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error('Supabase no configurado');
	process.exit(1);
}

// Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Multer
const upload = multer();

// Mongo
let dbClient;

async function connectDb(){
	dbClient = new MongoClient(MONGODB_URI);
	await dbClient.connect();
	console.log('MongoDB conectado');
}

connectDb().catch(err => {
	console.error(err);
	process.exit(1);
});

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

// ===== SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening ${PORT}`));