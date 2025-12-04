document.addEventListener('DOMContentLoaded', () => {
	// DOM
	const searchInput = document.getElementById('searchInput');
	const searchBtn = document.getElementById('searchBtn');
	const createForm = document.getElementById('createForm');
	const clearBtn = document.getElementById('clearBtn');
	const profilesList = document.getElementById('profilesList');

	// Estado
	let profiles = [];
	let editingId = null;

	// Buscar
	function doSearch() {
		const q = (searchInput.value || '').trim().toLowerCase();
		if (!q) {
			renderAllProfiles();
			return;
		}
		const filtered = profiles.filter(p => {
			const text = `${p.firstName || ''} ${p.lastName || ''} ${p.dni || ''} ${p.email || ''}`.toLowerCase();
			return text.includes(q);
		});
		renderProfiles(filtered);
	}
	searchBtn.addEventListener('click', doSearch);
	searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') doSearch(); });

	// Fetch
	async function fetchProfilesFromServer() {
		try {
			const res = await fetch('/api/profiles');
			if (!res.ok) return [];
			return await res.json();
		} catch (err) {
			console.error('fetchProfilesFromServer error', err);
			return [];
		}
	}

	// Upload
	async function uploadPhotoFile(file) {
		if (!file) return null;
		const form = new FormData();
		form.append('photoFile', file);
		try {
			const res = await fetch('/api/upload', { method: 'POST', body: form });
			if (!res.ok) throw new Error('upload failed');
			const json = await res.json();
			return json.url || null;
		} catch (err) {
			console.error('uploadPhotoFile error', err);
			return null;
		}
	}

	// Escape
	function escapeHtml(s) {
		return String(s || '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
	}

	// Render perfil
	function renderProfile(profile) {
		const div = document.createElement('div');
		div.className = 'profile-item';
		div.dataset.id = profile.id || '';

		// Foto
		const photoContainer = document.createElement('div');
		photoContainer.className = 'profile-photo-container';
		const img = document.createElement('img');
		img.className = 'profile-photo';
		img.src = profile.photo || '';
		img.alt = escapeHtml(profile.firstName || '');
		img.onerror = () => {
			img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 140"%3E%3Crect fill="%23e5e7eb" width="120" height="140"/%3E%3Ctext x="50%" y="50%" text-anchor="middle" dy=".3em" fill="%236b7280" font-size="12" font-family="Arial" text-anchor="middle"%3ESin foto%3C/text%3E%3C/svg%3E';
		};
		photoContainer.appendChild(img);

		// Contenido
		const content = document.createElement('div');
		content.className = 'profile-content';

		const header = document.createElement('div');
		header.className = 'profile-header';
		header.innerHTML = `
			<div>
				<div class="profile-name">${escapeHtml(profile.firstName)} ${escapeHtml(profile.lastName)}</div>
				<div class="profile-meta">Creado: ${new Date(profile.createdAt || Date.now()).toLocaleDateString()}</div>
			</div>
		`;

		const fields = document.createElement('div');
		fields.innerHTML = `
			<div class="profile-field">
				<span class="profile-field-label">DNI:</span>
				<span class="profile-field-value">${escapeHtml(profile.dni || 'N/A')}</span>
			</div>
			<div class="profile-field">
				<span class="profile-field-label">Email:</span>
				<span class="profile-field-value">${escapeHtml(profile.email || '')}</span>
			</div>
			<div class="profile-field">
				<span class="profile-field-label">Teléfono:</span>
				<span class="profile-field-value">${escapeHtml(profile.phone || 'N/A')}</span>
			</div>
			<div class="profile-field">
				<span class="profile-field-label">Ubicación:</span>
				<span class="profile-field-value">${escapeHtml(profile.location || 'N/A')}</span>
			</div>
		`;

		const stats = document.createElement('div');
		stats.className = 'profile-stats';
		const statDefs = [
			{ label: 'Habilidad', key: 'skill' },
			{ label: 'Inteligencia', key: 'intelligence' },
			{ label: 'Desempeño', key: 'performance' },
			{ label: 'Trabajos', key: 'jobs' },
			{ label: 'Ocupación', key: 'occupation' }
		];
		statDefs.forEach(st => {
			const val = profile.stats?.[st.key] || 0;
			const bar = document.createElement('div');
			bar.className = 'stat-bar';
			bar.innerHTML = `
				<div class="stat-label">${st.label}</div>
				<div class="stat-progress">
					<div class="stat-progress-fill" style="width: ${val}%"></div>
				</div>
				<div style="font-size: 10px; margin-top: 2px; color: var(--muted);">${val}%</div>
			`;
			stats.appendChild(bar);
		});

		const actions = document.createElement('div');
		actions.className = 'profile-actions';
		
		const editBtn = document.createElement('button');
		editBtn.className = 'btn-small';
		editBtn.textContent = 'Editar';
		editBtn.addEventListener('click', () => openEdit(profile.id));
		actions.appendChild(editBtn);

		const delBtn = document.createElement('button');
		delBtn.className = 'btn-small btn-small-danger';
		delBtn.textContent = 'Eliminar';
		delBtn.addEventListener('click', () => {
			if (confirm('¿Eliminar este perfil?')) deleteProfile(profile.id);
		});
		actions.appendChild(delBtn);

		content.appendChild(header);
		content.appendChild(fields);
		content.appendChild(stats);
		content.appendChild(actions);

		div.appendChild(photoContainer);
		div.appendChild(content);

		return div;
	}

	function renderAllProfiles() {
		fetchProfilesFromServer().then(list => {
			profiles = Array.isArray(list) ? list : [];
			renderProfiles(profiles);
		});
	}

	function renderProfiles(data) {
		profilesList.innerHTML = '';
		if (data.length === 0) {
			profilesList.innerHTML = '<div class="empty-state"><p>No hay perfiles que mostrar.</p></div>';
			return;
		}
		data.forEach(p => {
			profilesList.appendChild(renderProfile(p));
		});
	}

	// Editar
	function openEdit(id) {
		const p = profiles.find(x => (x.id || x._id || '') === id);
		if (!p) return alert('Perfil no encontrado');
		editingId = id;
		createForm.firstName.value = p.firstName || '';
		createForm.lastName.value = p.lastName || '';
		createForm.dni.value = p.dni || '';
		createForm.photo.value = p.photo || '';
		createForm.email.value = p.email || '';
		createForm.phone.value = p.phone || '';
		createForm.location.value = p.location || '';
		createForm.parents.value = p.parents || '';
		createForm.siblings.value = p.siblings || '';
		createForm.skill.value = p.stats?.skill ?? 50;
		createForm.intelligence.value = p.stats?.intelligence ?? 50;
		createForm.performance.value = p.stats?.performance ?? 50;
		createForm.jobs.value = p.stats?.jobs ?? 50;
		createForm.occupation.value = p.stats?.occupation ?? 50;
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	// Eliminar
	async function deleteProfile(id) {
		try {
			const res = await fetch(`/api/profiles/${id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error('delete failed');
			await renderAllProfiles();
		} catch (err) {
			console.error('deleteProfile error', err);
			alert('Error al eliminar perfil.');
		}
	}

	// Submit
	if (createForm) {
		createForm.addEventListener('submit', async (e) => {
			e.preventDefault();
			try {
				const formData = new FormData(createForm);
				const fileInput = createForm.querySelector('input[name="photoFile"]');
				let photoUrl = formData.get('photo') || '';
				if (fileInput && fileInput.files && fileInput.files[0]) {
					const uploaded = await uploadPhotoFile(fileInput.files[0]);
					if (uploaded) photoUrl = uploaded;
				}

				const payload = {
					firstName: formData.get('firstName') || '',
					lastName: formData.get('lastName') || '',
					dni: formData.get('dni') || '',
					photo: photoUrl || '',
					email: formData.get('email') || '',
					phone: formData.get('phone') || '',
					location: formData.get('location') || '',
					parents: formData.get('parents') || '',
					siblings: formData.get('siblings') || '',
					stats: {
						skill: Number(formData.get('skill')) || 50,
						intelligence: Number(formData.get('intelligence')) || 50,
						performance: Number(formData.get('performance')) || 50,
						jobs: Number(formData.get('jobs')) || 50,
						occupation: Number(formData.get('occupation')) || 50,
					},
				};

				const method = editingId ? 'PUT' : 'POST';
				const url = editingId ? `/api/profiles/${editingId}` : '/api/profiles';
				const res = await fetch(url, {
					method,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});

				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					throw new Error(body.error || `Error ${res.status}`);
				}

				editingId = null;
				createForm.reset();
				await renderAllProfiles();
				alert('Perfil guardado correctamente.');
			} catch (err) {
				console.error('submit error', err);
				alert('Error: ' + err.message);
			}
		});
	}

	if (clearBtn) {
		clearBtn.addEventListener('click', () => {
			editingId = null;
			createForm.reset();
		});
	}

	renderAllProfiles();
});
