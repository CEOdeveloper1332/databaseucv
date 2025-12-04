document.addEventListener('DOMContentLoaded', () => {
	const CLIENT_ID = '903625348841-fnb905r99ou1r63hmog4c0eso5qvgsib.apps.googleusercontent.com';

	// DOM
	const searchInput = document.getElementById('searchInput');
	const searchBtn = document.getElementById('searchBtn');
	const createBtn = document.getElementById('createBtn');
	const modal = document.getElementById('createModal');
	const cancelBtn = document.getElementById('cancelBtn');
	const createForm = document.getElementById('createForm');
	const signOutBtn = document.getElementById('signOutBtn');
	const signinDiv = document.getElementById('g_id_signin');
	const userInfo = document.getElementById('userInfo');
	const userNameEl = document.getElementById('userName');
	const userPicEl = document.getElementById('userPic');
	const profilesRoot = document.getElementById('profiles');

	// estado
	let currentUser = null; // {name,email,picture}
	let profiles = []; // lista de perfiles (local cache)
	let editingId = null;

	// Añadir función para decodificar JWT (necesaria para handleCredentialResponse)
	function parseJwt(token) {
		try {
			const payload = token.split('.')[1];
			// decodificar base64 URL-safe
			return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
		} catch (e) {
			console.error('parseJwt error', e);
			return null;
		}
	}

	// UI helpers
	if (searchBtn) { searchBtn.textContent = ''; searchBtn.setAttribute('aria-label','Buscar'); }
	function doSearch() {
		const q = (searchInput && searchInput.value) ? searchInput.value.trim() : '';
		console.log(q);
	}
	if (searchBtn) searchBtn.addEventListener('click', doSearch);
	if (searchInput) searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') doSearch(); });

	function showUser(user) {
		currentUser = user || null;
		if (signinDiv) signinDiv.style.display = 'none';
		if (userInfo) userInfo.hidden = false;
		// no mostrar nombre ni foto: solo dejar botón de cerrar sesión visible
		if (userNameEl) userNameEl.style.display = 'none';
		if (userPicEl) userPicEl.style.display = 'none';
		renderAllProfiles();
	}
	// asegurar que el contenedor de sign-in sea visible cuando está desconectado
	function showSignedOut() {
		currentUser = null;
		if (signinDiv) {
			signinDiv.style.display = ''; // asegurarse visible
			// no eliminar evento ni crear otro fallback aquí; initGoogle lo manejará si hace falta
		}
		if (userInfo) userInfo.hidden = true;
		if (userNameEl) { userNameEl.textContent = ''; userNameEl.style.display = 'none'; }
		if (userPicEl) { userPicEl.src = ''; userPicEl.style.display = 'none'; }
		renderAllProfiles();
	}

	// agregar flag para evitar duplicados del fallback
	let fallbackCreated = false;
	let fallbackEl = null;

	// Init Google button (icon) y fallback seguro (sin duplicados)
	function initGoogle() {
		if (window.google && google.accounts && google.accounts.id) {
			try {
				google.accounts.id.initialize({ client_id: CLIENT_ID, callback: handleCredentialResponse });
				google.accounts.id.renderButton(signinDiv, { theme: 'outline', size: 'small', type: 'icon' });
				google.accounts.id.disableAutoSelect();
			} catch (e) {
				console.warn('google render failed', e);
			}

			// comprobar si hay un elemento visible dentro de signinDiv; si no, crear fallback textual una sola vez
			setTimeout(() => {
				if (!signinDiv) return;
				// si ya existe el botón oficial visible, asegurarse de quitar fallback
				let hasVisible = false;
				for (const ch of Array.from(signinDiv.children)) {
					if (ch.offsetWidth > 0 && ch.offsetHeight > 0) { hasVisible = true; break; }
					if (ch.querySelector && ch.querySelector('button,div,iframe')) {
						const inner = ch.querySelector('button,div,iframe');
						if (inner && inner.offsetWidth > 0 && inner.offsetHeight > 0) { hasVisible = true; break; }
					}
				}
				// si hay botón oficial, eliminar fallback si existe
				if (hasVisible) {
					if (fallbackEl && fallbackEl.parentNode) {
						fallbackEl.parentNode.removeChild(fallbackEl);
						fallbackCreated = false;
						fallbackEl = null;
					}
					return;
				}
				// crear fallback solo si no existe
				if (!fallbackCreated && !document.getElementById('fallbackGoogleBtn')) {
					const fb = document.createElement('button');
					fb.id = 'fallbackGoogleBtn';
					fb.type = 'button';
					fb.title = 'Acceder con Google';
					fb.textContent = 'Acceder con Google';
					fb.style.display = 'inline-flex';
					fb.style.alignItems = 'center';
					fb.style.padding = '6px 10px';
					fb.style.borderRadius = '8px';
					fb.style.border = '1px solid rgba(15,23,36,0.06)';
					fb.style.background = '#fff';
					fb.style.cursor = 'pointer';
					// sólo prompt; no re-render para evitar duplicados
					fb.addEventListener('click', () => {
						if (window.google && google.accounts && google.accounts.id) {
							try {
								google.accounts.id.prompt(); // solicitar el flujo
							} catch (err) {
								alert('No se pudo iniciar sesión. Recarga la página.');
							}
						} else {
							alert('Cargando servicio de Google, espera un momento e intenta de nuevo.');
						}
					});
					signinDiv.appendChild(fb);
					fallbackCreated = true;
					fallbackEl = fb;
				}
			}, 600);
		} else {
			setTimeout(initGoogle, 300);
		}
	}
	initGoogle();

	// ajustar handleCredentialResponse para eliminar fallback al iniciar sesión
	function handleCredentialResponse(response){
		if (!response || !response.credential) return;
		const payload = parseJwt(response.credential);
		if (!payload) return;
		const user = { name: payload.name, email: payload.email, picture: payload.picture };
		window._g_id_credential = response.credential;
		// eliminar fallback si existe
		if (fallbackEl && fallbackEl.parentNode) {
			fallbackEl.parentNode.removeChild(fallbackEl);
			fallbackCreated = false;
			fallbackEl = null;
		}
		showUser(user);
	}

	// Sign out
	if (signOutBtn) {
		signOutBtn.addEventListener('click', () => {
			try { google.accounts.id.disableAutoSelect(); } catch (e) {}
			window._g_id_credential = null;
			showSignedOut();
		});
	}

	// Open modal to create (only for signed in users)
	if (createBtn) {
		createBtn.addEventListener('click', () => {
			if (!currentUser) return alert('Inicia sesión con Google para crear (autor).');
			editingId = null;
			if (createForm) createForm.reset();
			if (modal) modal.setAttribute('aria-hidden','false');
		});
	}
	if (cancelBtn) cancelBtn.addEventListener('click', () => modal.setAttribute('aria-hidden','true'));

	// Fetch profiles from server
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

	// Upload photo file to backend
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

	// Render helpers
	function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
	function escapeAttr(s){ return (s||'').replace(/"/g,'&quot;'); }

	function renderBar(label, cls, value){
		const v = Number(value) || 0;
		return `<div style="font-size:13px;color:var(--muted);margin-bottom:4px">${escapeHtml(label)}</div>
			<div class="progress ${cls}"><i style="width:${Math.max(0,Math.min(100,v))}%"></i></div>`;
	}

	function renderProfile(profile){
		const container = document.createElement('article');
		container.className = 'profile-card';
		container.dataset.id = profile.id || '';

		// left
		const main = document.createElement('div');
		main.className = 'profile-main';
		const img = document.createElement('img');
		img.className = 'profile-photo';
		img.src = profile.photo || '';
		img.alt = '';
		// mejorar manejo de imagen no cargada
		img.onerror = () => {
			img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"%3E%3Crect fill="%23e5e7eb" width="96" height="96"/%3E%3Ctext x="50%" y="50%" text-anchor="middle" dy=".3em" fill="%236b7280" font-size="14" font-family="Arial"%3ENo imagen%3C/text%3E%3C/svg%3E';
		};

		const fields = document.createElement('div');
		fields.className = 'profile-fields';
		fields.innerHTML = `
			<div><strong>${escapeHtml(profile.firstName||'')}</strong> <span>${escapeHtml(profile.lastName||'')}</span></div>
			<div>DNI: ${escapeHtml(profile.dni||'')}</div>
			<div>Correo: ${escapeHtml(profile.email||'')}</div>
			<div>Tel: ${escapeHtml(profile.phone||'')}</div>
			<div>Ubicación: ${escapeHtml(profile.location||'')}</div>
			<div>Padres: ${escapeHtml(profile.parents||'')} — Hermanos: ${escapeHtml(profile.siblings||'')}</div>
			<div class="progress-row">
				<div>${renderBar('Habilidad', 'skill', profile.stats?.skill)}</div>
				<div>${renderBar('Inteligencia', 'intelligence', profile.stats?.intelligence)}</div>
				<div>${renderBar('Desempeño', 'performance', profile.stats?.performance)}</div>
				<div>${renderBar('Trabajos', 'jobs', profile.stats?.jobs)}</div>
				<div>${renderBar('Ocupación', 'occupation', profile.stats?.occupation)}</div>
			</div>
		`;

		main.appendChild(img);
		main.appendChild(fields);

		// right meta
		const meta = document.createElement('div');
		meta.className = 'profile-meta';
		meta.innerHTML = `
			<div class="meta-author">
				<div class="author-name">${escapeHtml(profile.author?.name || '')}</div>
				<img src="${escapeAttr(profile.author?.picture || '')}" alt="" class="profile-photo" style="width:40px;height:40px;border-radius:50%;object-fit:cover;margin-top:6px;" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22%3E%3Ccircle fill=%22%23e5e7eb%22 cx=%2220%22 cy=%2220%22 r=%2220%22/%3E%3C/svg%3E';" />
			</div>
			<div class="btn-actions"></div>
		`;

		const actions = meta.querySelector('.btn-actions');
		if (currentUser && currentUser.email === profile.author?.email) {
			const editBtn = document.createElement('button');
			editBtn.className = 'btn-edit';
			editBtn.textContent = 'Editar';
			editBtn.addEventListener('click', () => openEdit(profile.id));
			actions.appendChild(editBtn);

			const pubBtn = document.createElement('button');
			pubBtn.className = 'btn-publish';
			pubBtn.textContent = profile.published ? 'Publicado' : 'Publicar';
			pubBtn.addEventListener('click', () => togglePublish(profile.id, pubBtn));
			actions.appendChild(pubBtn);
		}

		container.appendChild(main);
		container.appendChild(meta);
		return container;
	}

	// render all from server
	async function renderAllProfiles(){
		if (!profilesRoot) return;
		const list = await fetchProfilesFromServer();
		profiles = Array.isArray(list) ? list : [];
		profilesRoot.innerHTML = '';
		profiles.forEach(p => {
			const node = renderProfile(p);
			profilesRoot.appendChild(node);
		});
	}

	// open edit
	function openEdit(id){
		const p = profiles.find(x => (x.id||x._id||'') === id);
		if (!p) return alert('Perfil no encontrado');
		editingId = id;
		// fill (safely)
		createForm.firstName.value = p.firstName || '';
		createForm.lastName.value = p.lastName || '';
		createForm.dni.value = p.dni || '';
		createForm.photo.value = p.photo || '';
		createForm.email.value = p.email || '';
		createForm.phone.value = p.phone || '';
		createForm.location.value = p.location || '';
		createForm.parents.value = p.parents || '';
		createForm.siblings.value = p.siblings || '';
		createForm.skill.value = p.stats?.skill ?? 0;
		createForm.intelligence.value = p.stats?.intelligence ?? 0;
		createForm.performance.value = p.stats?.performance ?? 0;
		createForm.jobs.value = p.stats?.jobs ?? 0;
		createForm.occupation.value = p.stats?.occupation ?? 0;
		if (modal) modal.setAttribute('aria-hidden','false');
	}

	// toggle publish via backend
	async function togglePublish(id){
		try {
			// find profile
			const p = profiles.find(x => (x.id||x._id||'') === id);
			if (!p) return;
			// flip
			const updated = { ...p, published: !p.published };
			const res = await fetch(`/api/profiles/${id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(updated),
			});
			if (!res.ok) throw new Error('publish failed');
			await renderAllProfiles();
		} catch (err) {
			console.error('togglePublish error', err);
			alert('Error al cambiar estado de publicación.');
		}
	}

	// submit form (create or update)
	if (createForm) {
		createForm.addEventListener('submit', async (e) => {
			e.preventDefault();
			if (!currentUser) return alert('Debes iniciar sesión con Google para asignarte como autor.');
			try {
				const formData = new FormData(createForm);
				// handle file upload if present
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
						skill: Number(formData.get('skill')) || 0,
						intelligence: Number(formData.get('intelligence')) || 0,
						performance: Number(formData.get('performance')) || 0,
						jobs: Number(formData.get('jobs')) || 0,
						occupation: Number(formData.get('occupation')) || 0,
					},
					author: { name: currentUser.name, email: currentUser.email, picture: currentUser.picture },
				};

				const method = editingId ? 'PUT' : 'POST';
				const url = editingId ? `/api/profiles/${editingId}` : '/api/profiles';
				const res = await fetch(url, {
					method,
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});

				// leer body de respuesta (json o text) para mensajes de error detallados
				const text = await res.text();
				let body = null;
				try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }

				if (!res.ok) {
					console.error('Save failed', res.status, body);
					const msg = (body && body.error) ? body.error : (typeof body === 'string' ? body : `status ${res.status}`);
					return alert('Error al guardar el perfil: ' + msg);
				}

				// éxito: usar respuesta del servidor si provee el objeto guardado
				const saved = body && typeof body === 'object' ? body : null;
				editingId = null;
				if (modal) modal.setAttribute('aria-hidden','true');

				// refrescar desde servidor para asegurar consistencia
				await renderAllProfiles();

				// opcional: mensaje breve de éxito
				console.info('Perfil guardado', saved || 'ok');
			} catch (err) {
				console.error('createForm submit error', err);
				alert('Error al guardar el perfil. Revisa la consola para más detalles.');
			}
		});
	}

	// initial actions
	showSignedOut();
	renderAllProfiles();
});
