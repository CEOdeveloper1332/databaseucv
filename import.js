const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(
  'https://szurscobpuayftnhusif.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6dXJzY29icHVheWZ0bmh1c2lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0Njc2NDcsImV4cCI6MjA4MDA0MzY0N30.ZkJISItgnrLHOUiE_n8YhqscUJZw_QOR8qMf0gjvM5I'
);

async function importCollection(file, table, mapper) {
  if (!fs.existsSync(file)) { console.log(`⚠️  ${file} no existe, saltando`); return; }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  let count = 0;
  for (const line of lines) {
    const d = JSON.parse(line);
    const { error } = await supabase.from(table).upsert(mapper(d));
    if (error) console.error(`Error ${table}:`, error.message);
    else count++;
  }
  console.log(`✅ ${table}: ${count} registros`);
}

async function importProfiles() {
  console.log('Importando profiles...');
  const lines = fs.readFileSync('C:/Users/hilte/Desktop/profiles.json', 'utf8')
    .split('\n').filter(l => l.trim());
  let batch = [], count = 0;
  for (const line of lines) {
    const d = JSON.parse(line);
    batch.push({
      id: d._id.$oid, first_name: d.firstName, last_name: d.lastName,
      dni: d.dni, photo: d.photo, email: d.email, phone: d.phone,
      location: d.location, country: d.country, department: d.department,
      province: d.province, locality: d.locality, city: d.city,
      address: d.address, birthday: d.birthday, lat: d.lat, lng: d.lng,
      stats: d.stats, author: d.author,
      created_at: d.createdAt?.$date, updated_at: d.updatedAt?.$date
    });
    if (batch.length === 100) {
      const { error } = await supabase.from('profiles').upsert(batch);
      if (error) console.error('Error batch:', error.message);
      count += batch.length;
      console.log(`Importados: ${count}/${lines.length}`);
      batch = [];
    }
  }
  if (batch.length > 0) {
    const { error } = await supabase.from('profiles').upsert(batch);
    if (error) console.error('Error batch final:', error.message);
    count += batch.length;
  }
  console.log(`✅ profiles completado: ${count} registros`);
}

async function importPdfChunks() {
  console.log('Importando pdf_chunks...');
  const lines = fs.readFileSync('C:/Users/hilte/Desktop/pdf_chunks.json', 'utf8')
    .split('\n').filter(l => l.trim());
  for (const line of lines) {
    const d = JSON.parse(line);
    const { error } = await supabase.from('pdf_chunks').upsert({
      id: d._id.$oid, pdf_id: d.pdfId?.$oid, filename: d.filename,
      chunk_index: d.chunkIndex, content: d.content,
      embedding: d.embedding, ocr: d.ocr, uploaded_at: d.uploadedAt?.$date
    });
    if (error) console.error('Error chunk:', error.message);
  }
  console.log('✅ pdf_chunks completado');
}

(async () => {
  await importProfiles();
  await importPdfChunks();

  await importCollection('C:/Users/hilte/Desktop/users.json', 'users', d => ({
    id: d._id.$oid, email: d.email, name: d.name,
    role: d.role || 'user', approved: d.approved || false,
    created_at: d.createdAt?.$date, updated_at: d.updatedAt?.$date
  }));

  await importCollection('C:/Users/hilte/Desktop/events.json', 'events', d => ({
    id: d._id.$oid, date: d.date, time: d.time,
    created_at: d.createdAt?.$date, updated_at: d.updatedAt?.$date, data: d
  }));

  await importCollection('C:/Users/hilte/Desktop/networks.json', 'networks', d => ({
    id: d._id.$oid, created_at: d.createdAt?.$date, updated_at: d.updatedAt?.$date, data: d
  }));

  await importCollection('C:/Users/hilte/Desktop/nexus_cases.json', 'nexus_cases', d => ({
    id: d._id.$oid, created_by: d.createdBy, updated_by: d.updatedBy,
    created_at: d.createdAt?.$date, updated_at: d.updatedAt?.$date, data: d
  }));

  await importCollection('C:/Users/hilte/Desktop/publications.json', 'publications', d => ({
    id: d._id.$oid, title: d.title, subtitle: d.subtitle,
    keywords: d.keywords, content: d.content, author: d.author,
    role: d.role, cover_url: d.coverUrl,
    published_at: d.publishedAt?.$date,
    created_at: d.createdAt?.$date, updated_at: d.updatedAt?.$date
  }));

  await importCollection('C:/Users/hilte/Desktop/publicationsadmin.json', 'publicationsadmin', d => ({
    id: d._id.$oid, title: d.title, subtitle: d.subtitle,
    keywords: d.keywords, content: d.content, author: d.author,
    role: d.role, cover_url: d.coverUrl,
    published_at: d.publishedAt?.$date,
    created_at: d.createdAt?.$date, updated_at: d.updatedAt?.$date
  }));

  console.log('🎉 Todo importado');
})();