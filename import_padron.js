const fs = require('fs');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://szurscobpuayftnhusif.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6dXJzY29icHVheWZ0bmh1c2lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0Njc2NDcsImV4cCI6MjA4MDA0MzY0N30.ZkJISItgnrLHOUiE_n8YhqscUJZw_QOR8qMf0gjvM5I'
);

const FILE = 'C:/Users/hilte/Downloads/APIS PERUNAS/TEXTO/padron_reducido_ruc.txt';
const CHUNK = 500;

async function main() {
  const rl = readline.createInterface({
    input: fs.createReadStream(FILE, { encoding: 'latin1' })
  });

  let batch = [];
  let total = 0;
  let first = true;

  for await (const line of rl) {
    if (first) { first = false; continue; }
    const parts = line.split('|');
    if (parts.length < 2) continue;
    const ruc = parts[0].trim();
    if (!ruc.startsWith('10')) continue;
    batch.push({ ruc, nombre: parts[1].trim() });

    if (batch.length >= CHUNK) {
      const { error } = await supabase
        .from('padron_sunat')
        .upsert(batch, { onConflict: 'ruc' });
      if (error) console.error('Error:', error.message);
      total += batch.length;
      console.log(`Insertados: ${total}`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await supabase.from('padron_sunat').upsert(batch, { onConflict: 'ruc' });
    total += batch.length;
  }

  console.log(`TOTAL: ${total}`);
}

main();