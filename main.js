/* Archivo consolidado: main.js
   - Se eliminaron bloques repetidos
   - Se consolidó la lógica Overpass/quota/fallback
   - Mantiene funcionalidades: perfiles, calendario, ciclos, neural, locations
*/
document.addEventListener('DOMContentLoaded', async () => {
	// Determine whether current user is an admin/approved
	window.__isAdmin = false;
	try {
		const savedEmail = localStorage.getItem('userEmail');
		if (savedEmail) {
			const resp = await fetch('/status?email=' + encodeURIComponent(savedEmail));
			if (resp.ok) {
				const j = await resp.json();
				if (j && j.approved && j.role === 'admin') window.__isAdmin = true;
			}
		}
	} catch (e) {
		console.warn('Could not determine admin status', e);
	}
	// ========== APP.JS - PERFILES ==========
	const searchInput = document.getElementById('searchInput');
	const searchBtn = document.getElementById('searchBtn');
	const createForm = document.getElementById('createForm');
	const clearBtn = document.getElementById('clearBtn');
	const profilesList = document.getElementById('profilesList');

	let profiles = [];
	let editingId = null;

	function doSearch() {
		const q = (searchInput && searchInput.value || '').trim().toLowerCase();
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
	if (searchBtn) searchBtn.addEventListener('click', doSearch);
	if (searchInput) searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') doSearch(); });

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

	function escapeHtml(s) {
		return String(s || '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
	}

	// helper: obtener URL de foto desde varios campos o devolver placeholder
	function getPhotoUrl(profileOrUrl) {
		const placeholder = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 120 140%22%3E%3Crect fill=%22%23e5e7eb%22 width=%22120%22 height=%22140%22/%3E%3Ctext x=%2250%22 y=%2270%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%236b7280%22 font-size=%2212%22 font-family=%22Arial%22%3ENo foto%3C/text%3E%3C/svg%3E';
		if (!profileOrUrl) return placeholder;
		if (typeof profileOrUrl === 'string') return profileOrUrl.trim() ? profileOrUrl : placeholder;
		const p = profileOrUrl || {};
		const keys = ['photo','avatar','picture','image','photoUrl','url'];
		for (let k of keys) {
			if (p[k] && String(p[k]).trim()) return p[k];
		}
		if (p.photo && p.photo.url) return p.photo.url;
		return placeholder;
	}

	function renderProfile(profile) {
		const div = document.createElement('div');
		div.className = 'profile-item';
		div.dataset.id = profile.id || '';

		const photoContainer = document.createElement('div');
		photoContainer.className = 'profile-photo-container';
		const img = document.createElement('img');
		img.className = 'profile-photo';
		img.src = getPhotoUrl(profile);
		img.alt = escapeHtml(profile.firstName || '');
		img.onerror = () => {
			img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 140"%3E%3Crect fill="%23e5e7eb" width="120" height="140"/%3E%3Ctext x="50%" y="50%" text-anchor="middle" dy=".3em" fill="%236b7280" font-size="12" font-family="Arial" text-anchor="middle"%3ESin foto%3C/text%3E%3C/svg%3E';
		};
		photoContainer.appendChild(img);

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
		// Only show edit/delete to admins
		if (window.__isAdmin) {
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
		}

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
		if (profilesList) {
			profilesList.innerHTML = '';
			if (data.length === 0) {
				profilesList.innerHTML = '<div class="empty-state"><p>No hay perfiles que mostrar.</p></div>';
				return;
			}
			data.forEach(p => {
				profilesList.appendChild(renderProfile(p));
			});
		}
	}

	function openEdit(id) {
		const p = profiles.find(x => (x.id || x._id || '') === id);
		if (!p) return alert('Perfil no encontrado');
		editingId = id;
		if (createForm) {
			// If not admin, hide/disable the create/edit form entirely
			if (!window.__isAdmin) {
				const aside = document.querySelector('.form-panel');
				if (aside) aside.style.display = 'none';
			}
			createForm.firstName.value = p.firstName || '';
			createForm.lastName.value = p.lastName || '';
			createForm.dni.value = p.dni || '';
			createForm.photo.value = p.photo || '';
			createForm.email.value = p.email || '';
			createForm.phone.value = p.phone || '';
			if (createForm.locality) createForm.locality.value = p.locality || p.district || '';
			if (createForm.province) createForm.province.value = p.province || '';
			if (createForm.department) createForm.department.value = p.department || '';
			if (createForm.country) createForm.country.value = p.country || 'Perú';
			createForm.location.value = p.location || '';
			createForm.parents.value = p.parents || '';
			createForm.siblings.value = p.siblings || '';
			createForm.skill.value = p.stats?.skill ?? 50;
			createForm.intelligence.value = p.stats?.intelligence ?? 50;
			createForm.performance.value = p.stats?.performance ?? 50;
			createForm.jobs.value = p.stats?.jobs ?? 50;
			createForm.occupation.value = p.stats?.occupation ?? 50;
		}
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}

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

	if (createForm) {
		createForm.addEventListener('submit', async (e) => {
			e.preventDefault();
			if (!window.__isAdmin) return alert('Permisos insuficientes');
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
					locality: formData.get('locality') || formData.get('district') || '',
					province: formData.get('province') || '',
					department: formData.get('department') || '',
					country: formData.get('country') || 'Perú',
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

				const saved = await res.json();
				// intentar geocodificar y actualizar lat/lng en el servidor para que el mapa refleje cambios
				(async () => {
					try {
						const parts = [];
						const l = saved.locality || saved.district || saved.location || '';
						if (l) parts.push(String(l).trim());
						if (saved.province) parts.push(String(saved.province).trim());
						if (saved.department) parts.push(String(saved.department).trim());
						if (saved.country) parts.push(String(saved.country).trim());
						const q = parts.join(', ');
						let coords = null;
						if (q) coords = await geocodeLocation(q);
						if (!coords && q) coords = await geocodeLocation(q + ', ' + (saved.country || 'Perú'));
						if (coords && saved.id) {
							await fetch(`/api/profiles/${saved.id}`, {
								method: 'PUT',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ lat: coords.lat, lng: coords.lng })
							});
						}
					} catch (e) { console.warn('post-save geocode/update failed', e); }
					// refrescar UI/markers
					editingId = null;
					createForm.reset();
					await renderAllProfiles();
					if (window.loadLocationsOnGlobe) try { window.loadLocationsOnGlobe(); } catch(e){/*ignore*/}
					alert('Perfil guardado correctamente.');
				})();
			} catch (err) {
				console.error('submit error', err);
				alert('Error: ' + (err.message || err));
			}
		});
	}

	if (clearBtn) {
		clearBtn.addEventListener('click', () => {
			editingId = null;
			if (createForm) createForm.reset();
		});
	}

	if (profilesList) renderAllProfiles();

	// ========== CALENDAR.JS ==========
	const daysGrid = document.getElementById('daysGrid');
	const monthLabel = document.getElementById('monthLabel');
	const todayLabel = document.getElementById('todayLabel');
	const selectedDayLabel = document.getElementById('selectedDayLabel');
	const eventsListEl = document.getElementById('eventsList');
	const addEventBtn = document.getElementById('addEventBtn');
	const eventModal = document.getElementById('eventModal');
	const eventForm = document.getElementById('eventForm');

	if (daysGrid) {
		let viewYear, viewMonth;
		const now = new Date();
		viewYear = now.getFullYear();
		viewMonth = now.getMonth();

		const prevMonthBtn = document.getElementById('prevMonth');
		const nextMonthBtn = document.getElementById('nextMonth');
		const cancelBtn = document.getElementById('cancelBtn');

		if (prevMonthBtn) prevMonthBtn.addEventListener('click', ()=> changeMonth(-1));
		if (nextMonthBtn) nextMonthBtn.addEventListener('click', ()=> changeMonth(1));
		if (addEventBtn) {
			if (window.__isAdmin) {
				addEventBtn.addEventListener('click', openAddModal);
			} else {
				addEventBtn.style.display = 'none';
			}
		}
		if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
		if (eventForm) {
			if (window.__isAdmin) {
				eventForm.addEventListener('submit', onSaveEvent);
			} else {
				// disable form inputs for non-admins
				eventForm.querySelectorAll('input,button,select,textarea').forEach(el=>el.disabled=true);
			}
		}

		updateTodayLabel();
		renderCalendar();

		async function loadEvents(){
			try{
				const res = await fetch('/api/events');
				if (!res.ok) return [];
				return await res.json();
			}catch(e){ console.error('loadEvents error', e); return []; }
		}
		async function saveEvent(event){
			try{
				const method = event.id && event.id.startsWith('ev_') ? 'POST' : (event.id ? 'PUT' : 'POST');
				const url = event.id && !event.id.startsWith('ev_') ? `/api/events/${event.id}` : '/api/events';
				const res = await fetch(url, {
					method,
					headers: {'Content-Type':'application/json'},
					body: JSON.stringify(event)
				});
				if (!res.ok) throw new Error();
				return await res.json();
			}catch(e){ console.error('saveEvent error', e); return null; }
		}
		async function deleteEventFromDb(id){
			try{
				const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
				if (!res.ok) throw new Error();
				return true;
			}catch(e){ console.error('deleteEvent error', e); return false; }
		}

		function getColorForEvent(id){
			const palette = [
				{bg: 'rgba(26,154,240,0.08)', color: '#1a9af0'},
				{bg: 'rgba(255,107,107,0.08)', color: '#ff6b6b'},
				{bg: 'rgba(255,209,102,0.08)', color: '#ffd166'},
				{bg: 'rgba(139,195,74,0.08)', color: '#8bc34a'},
				{bg: 'rgba(142,125,255,0.08)', color: '#8e7dff'},
				{bg: 'rgba(255,159,67,0.08)', color: '#ff9f43'}
			];
			if (!id) return palette[0];
			let h = 0;
			for (let i = 0; i < id.length; i++) h = (h << 5) - h + id.charCodeAt(i);
			return palette[Math.abs(h) % palette.length];
		}

		function renderCalendar(){
			(async () => {
				daysGrid.innerHTML = '';
				const first = new Date(viewYear, viewMonth, 1);
				const startDay = first.getDay();
				const daysInMonth = new Date(viewYear, viewMonth+1, 0).getDate();
				const prevMonthDays = startDay;
				const prevLast = new Date(viewYear, viewMonth, 0).getDate();
				const totalCells = Math.ceil((prevMonthDays + daysInMonth)/7)*7;
				const events = await loadEvents();

				for(let i=0;i<totalCells;i++){
					const cell = document.createElement('div');
					cell.className = 'day-cell';

					const dayIndex = i - prevMonthDays + 1;
					let cellDate;
					if (dayIndex <= 0) {
						cell.classList.add('other-month');
						const d = prevLast + dayIndex;
						cellDate = new Date(viewYear, viewMonth-1, d);
					} else if (dayIndex > daysInMonth) {
						cell.classList.add('other-month');
						const d = dayIndex - daysInMonth;
						cellDate = new Date(viewYear, viewMonth+1, d);
					} else {
						cellDate = new Date(viewYear, viewMonth, dayIndex);
					}

					const y = cellDate.getFullYear();
					const m = (cellDate.getMonth()+1).toString().padStart(2,'0');
					const dnum = cellDate.getDate();
					const iso = `${y}-${m}-${String(dnum).padStart(2,'0')}`;

					const dn = document.createElement('div');
					dn.className = 'day-number';
					dn.textContent = cellDate.getDate();
					cell.appendChild(dn);

					const dayEvents = events.filter(ev => ev.date === iso)
						.sort((a,b)=>{
							if (!a.time) return 1;
							if (!b.time) return -1;
							return a.time.localeCompare(b.time);
						});

					if (dayEvents.length) {
						const evContainer = document.createElement('div');
						evContainer.className = 'cell-events';
						const visible = dayEvents.slice(0,4);
						visible.forEach(ev=>{
							const evEl = document.createElement('div');
							evEl.className = 'cell-event';
							const col = getColorForEvent(ev.id);
							evEl.style.background = 'linear-gradient(90deg,' + col.bg + ', rgba(255,255,255,0.3))';
							evEl.style.borderLeft = `4px solid ${col.color}`;
							const timeHtml = ev.time ? `<span class="event-time">${ev.time}</span>` : '';
							evEl.innerHTML = `<span class="event-dot" style="background:${col.color}"></span><span class="event-title">${escapeHtml(ev.title)}</span>${timeHtml}`;
							evEl.addEventListener('click', (e)=>{
								e.stopPropagation();
								openEditModal(ev.id);
							});
							evContainer.appendChild(evEl);
						});
						cell.appendChild(evContainer);

						if (dayEvents.length > 4) {
							const more = document.createElement('div');
							more.className = 'cell-more';
							more.textContent = `+${dayEvents.length-4} más`;
							more.addEventListener('click', (e)=>{
								e.stopPropagation();
								selectDay(iso, cellDate);
							});
							cell.appendChild(more);
						}
					}

					const today = new Date();
					if (cellDate.toDateString() === today.toDateString()) {
						cell.classList.add('today');
					}

					cell.addEventListener('click', ()=> selectDay(iso, cellDate));
					daysGrid.appendChild(cell);
				}

				const mNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
				monthLabel.textContent = `${mNames[viewMonth]} ${viewYear}`;
			})();
		}

		function changeMonth(delta){
			viewMonth += delta;
			if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
			if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
			renderCalendar();
		}

		let currentSelected = null;
		function selectDay(iso, dateObj){
			currentSelected = iso;
			selectedDayLabel.textContent = `${dateObj.toLocaleDateString()} (${iso})`;
			if (addEventBtn) addEventBtn.disabled = false;
			renderEventsForDay(iso);
		}

		function renderEventsForDay(iso){
			(async () => {
				const events = (await loadEvents()).filter(ev => ev.date === iso).sort((a,b)=>{
					if (!a.time) return 1; if (!b.time) return -1;
					return a.time.localeCompare(b.time);
				});
				if (eventsListEl) {
					eventsListEl.innerHTML = '';
					if (events.length === 0) {
						eventsListEl.innerHTML = `<p class="muted">No hay eventos para esta fecha.</p>`;
						return;
					}
					events.forEach(ev=>{
						const el = document.createElement('div');
						el.className = 'event-item';
						let actionsHtml = '';
						if (window.__isAdmin) {
							actionsHtml = `<div>
									<button class="btn edit" data-id="${ev.id}">Editar</button>
									<button class="btn delete" data-id="${ev.id}">Borrar</button>
								</div>`;
						}
						el.innerHTML = `<div>
									<div><strong>${escapeHtml(ev.title)}</strong></div>
									<div class="event-meta">${ev.time ? ev.time+' • ' : ''}${escapeHtml(ev.desc || '')}</div>
								</div>` + actionsHtml;
						eventsListEl.appendChild(el);
					});

					if (window.__isAdmin) {
						eventsListEl.querySelectorAll('.delete').forEach(btn=>{
							btn.addEventListener('click', ()=> {
								const id = btn.getAttribute('data-id');
								deleteEvent(id);
							});
						});
						eventsListEl.querySelectorAll('.edit').forEach(btn=>{
							btn.addEventListener('click', ()=> {
								const id = btn.getAttribute('data-id');
								openEditModal(id);
							});
						});
					}
				}
			})();
		}

		function openAddModal(){
			if (!currentSelected) return;
			openModal();
			if (eventForm) {
				eventForm.id.value = '';
				eventForm.title.value = '';
				eventForm.date.value = currentSelected;
				eventForm.time.value = '';
				eventForm.desc.value = '';
			}
			const modalTitle = document.getElementById('modalTitle');
			if (modalTitle) modalTitle.textContent = 'Nuevo evento';
		}
		function openEditModal(id){
			(async () => {
				const events = await loadEvents();
				const ev = events.find(x=>x.id===id);
				if (!ev) return;
				openModal();
				if (eventForm) {
					eventForm.id.value = ev.id;
					eventForm.title.value = ev.title;
					eventForm.date.value = ev.date;
					eventForm.time.value = ev.time || '';
					eventForm.desc.value = ev.desc || '';
				}
				const modalTitle = document.getElementById('modalTitle');
				if (modalTitle) modalTitle.textContent = 'Editar evento';
			})();
		}
		function openModal(){ if (eventModal) eventModal.classList.remove('hidden'); }
		function closeModal(){ if (eventModal) eventModal.classList.add('hidden'); }

		function onSaveEvent(e){
			e.preventDefault();
			(async () => {
				if (!eventForm) return;
				const id = eventForm.id.value;
				const title = eventForm.title.value.trim();
				const date = eventForm.date.value;
				const time = eventForm.time.value;
				const desc = eventForm.desc.value.trim();

				if (!title || !date) return alert('Título y fecha requeridos');

				const event = { id: id || undefined, title, date, time, desc };
				const saved = await saveEvent(event);
				if (!saved) return alert('Error guardando evento');

				closeModal();
				renderCalendar();
				if (currentSelected === date) renderEventsForDay(date);
			})();
		}

		function deleteEvent(id){
			if (!confirm('Borrar evento?')) return;
			(async () => {
				const deleted = await deleteEventFromDb(id);
				if (!deleted) return alert('Error eliminando evento');
				renderCalendar();
				if (currentSelected) renderEventsForDay(currentSelected);
			})();
		}

		function generateId(){ return 'ev_' + Math.random().toString(36).slice(2,9); }

		function updateTodayLabel(){
			const t = new Date();
			if (todayLabel) todayLabel.textContent = `Hoy: ${t.toLocaleDateString()}`;
		}
	}

	// ========== CYCLE.JS ==========
	const groupNameInput = document.getElementById('groupNameInput');
	const createGroupBtn = document.getElementById('createGroupBtn');
	const groupsList = document.getElementById('groupsList');
	const groupContent = document.getElementById('groupContent');
	const emptyState = document.getElementById('emptyState');
	const groupTitle = document.getElementById('groupTitle');
	const deleteGroupBtn = document.getElementById('deleteGroupBtn');
	const profilesSelect = document.getElementById('profilesSelect');
	const addProfileBtn = document.getElementById('addProfileBtn');
	const participantsList = document.getElementById('participantsList');
	const psychoModal = document.getElementById('psychoModal');
	const psychoForm = document.getElementById('psychoForm');
	const cancelPsychoBtn = document.getElementById('cancelPsychoBtn');

	if (groupNameInput) {
		let cycleProfiles = [];
		let groups = [];
		let currentGroupId = null;

		async function fetchCycleGroups(){
			try{
				const res = await fetch('/api/cycles');
				if (!res.ok) return [];
				return await res.json();
			} catch(e){ console.error('fetch cycles error', e); return []; }
		}

		async function loadCycleGroups(){
			groups = await fetchCycleGroups();
			renderCycleGroupsList();
		}

		async function saveCycleGroup(group){
			try{
				const method = group.id ? 'PUT' : 'POST';
				const url = group.id ? `/api/cycles/${group.id}` : '/api/cycles';
				const res = await fetch(url, {
					method,
					headers: {'Content-Type':'application/json'},
					body: JSON.stringify(group)
				});
				if (!res.ok) throw new Error();
				return await res.json();
			}catch(e){ console.error('save cycle error', e); return null; }
		}

		async function deleteCycleGroup(id){
			try{
				const res = await fetch(`/api/cycles/${id}`, { method: 'DELETE' });
				if (!res.ok) throw new Error();
				return true;
			}catch(e){ console.error('delete cycle error', e); return false; }
		}

		loadCycleProfiles();
		loadCycleGroups();
		renderCycleGroupsList();

		if (window.__isAdmin) {
			if (createGroupBtn) createGroupBtn.addEventListener('click', createCycle);
			if (deleteGroupBtn) deleteGroupBtn.addEventListener('click', deleteCycleGroupClick);
			if (addProfileBtn) addProfileBtn.addEventListener('click', addProfileToCycleGroup);
			if (cancelPsychoBtn) cancelPsychoBtn.addEventListener('click', ()=> closeCyclePsychoModal());
			if (psychoForm) psychoForm.addEventListener('submit', saveCyclePsychoOptions);
		} else {
			if (createGroupBtn) createGroupBtn.style.display = 'none';
			if (deleteGroupBtn) deleteGroupBtn.style.display = 'none';
			if (addProfileBtn) addProfileBtn.style.display = 'none';
			if (cancelPsychoBtn) cancelPsychoBtn.style.display = 'none';
			if (psychoForm) psychoForm.querySelectorAll('input,button,select,textarea').forEach(el=>el.disabled=true);
		}

		async function loadCycleProfiles(){
			try{
				const res = await fetch('/api/profiles');
				if (res.ok) cycleProfiles = await res.json();
			} catch(e){ console.error('load cycle profiles error', e); }
			updateCycleProfilesSelect();
			renderCycleProfilesPool();
		}

		// render visual pool of profiles (mini-tarjetas) next to selector
		function renderCycleProfilesPool(){
			const pool = document.getElementById('cycleProfilesPool');
			if (!pool) return;
			pool.innerHTML = '';
			if (!Array.isArray(cycleProfiles) || cycleProfiles.length === 0) {
				pool.innerHTML = '<div class="muted" style="font-size:12px">No hay perfiles disponibles.</div>';
				return;
			}
			cycleProfiles.forEach(p => {
				const id = p.id || (p._id && String(p._id)) || '';
				const card = document.createElement('div');
				card.className = 'cycle-profile-card';
				card.style.width = '110px';
				card.style.border = '1px solid var(--border, #ddd)';
				card.style.borderRadius = '6px';
				card.style.overflow = 'hidden';
				card.style.textAlign = 'center';
				card.style.background = '#fff';
				card.style.padding = '6px';
				card.style.cursor = 'default';

				const img = document.createElement('img');
				img.src = getPhotoUrl(p);
				img.alt = (p.firstName || p.lastName) ? `${p.firstName||''} ${p.lastName||''}`.trim() : (p.email||'');
				img.style.width = '100%';
				img.style.height = '90px';
				img.style.objectFit = 'cover';
				img.style.display = 'block';
				img.onerror = () => { img.src = getPhotoUrl(null); };

				const name = document.createElement('div');
				name.textContent = `${p.firstName||''} ${p.lastName||''}`.trim() || (p.email||'Perfil');
				name.style.fontSize = '12px';
				name.style.margin = '6px 0 4px';

				if (window.__isAdmin) {
					const btn = document.createElement('button');
					btn.className = 'btn btn-sm';
					btn.textContent = 'Agregar';
					btn.style.fontSize = '12px';
					btn.addEventListener('click', () => addProfileToCycleGroupById(id));
					card.appendChild(btn);
				}
				card.appendChild(img);
				card.appendChild(name);
				pool.appendChild(card);
			});
		}

		async function createCycle(){
			const name = groupNameInput.value.trim();
			if (!name) return alert('Ingrese nombre del grupo');
			const group = { name, participants: [] };
			const saved = await saveCycleGroup(group);
			if (!saved) return alert('Error creando grupo');
			groups.push(saved);
			groupNameInput.value = '';
			renderCycleGroupsList();
		}

		async function deleteCycleGroupClick(){
			if (!currentGroupId) return;
			if (!confirm('¿Eliminar este grupo?')) return;
			const deleted = await deleteCycleGroup(currentGroupId);
			if (!deleted) return alert('Error eliminando grupo');
			groups = groups.filter(g => g.id !== currentGroupId);
			currentGroupId = null;
			renderCycleGroupsList();
			showCycleEmptyState();
		}

		function renderCycleGroupsList(){
			if (groupsList) {
				groupsList.innerHTML = '';
				if (groups.length === 0) {
					groupsList.innerHTML = '<p class="muted">No hay grupos creados.</p>';
					return;
				}
				groups.forEach(g => {
					const item = document.createElement('div');
					item.className = 'group-item' + (g.id === currentGroupId ? ' active' : '');
					item.innerHTML = `
						<div>
							<div class="group-name">${escapeHtml(g.name)}</div>
							<div class="group-count">${g.participants.length} participantes</div>
						</div>
					`;
					item.addEventListener('click', ()=> selectCycleGroup(g.id));
					groupsList.appendChild(item);
				});
			}
		}

		function selectCycleGroup(id){
			currentGroupId = id;
			renderCycleGroupsList();
			showCycleGroupDetail();
		}

		function showCycleGroupDetail(){
			if (emptyState) emptyState.classList.add('hidden');
			if (groupContent) groupContent.classList.remove('hidden');
			const group = groups.find(g => g.id === currentGroupId);
			if (!group) return;
			if (groupTitle) groupTitle.textContent = group.name;
			renderCycleParticipants();
		}

		function showCycleEmptyState(){
			if (emptyState) emptyState.classList.remove('hidden');
			if (groupContent) groupContent.classList.add('hidden');
		}

		function updateCycleProfilesSelect(){
			if (profilesSelect) {
				profilesSelect.innerHTML = '<option value="">-- Seleccione un perfil --</option>';
				const group = groups.find(g => g.id === currentGroupId);
				if (!group) return;
				const usedIds = new Set(group.participants.map(p => p.profileId));
				cycleProfiles.forEach(p => {
					if (!usedIds.has(p.id)) {
						const opt = document.createElement('option');
						opt.value = p.id;
						opt.textContent = `${p.firstName || ''} ${p.lastName || ''}`.trim() || p.email || opt.value;
						profilesSelect.appendChild(opt);
					}
				});
			}
		}

		async function addProfileToCycleGroup(){
			if (!profilesSelect) return;
			const profileId = profilesSelect.value;
			if (!profileId) return alert('Seleccione un perfil');
			return addProfileToCycleGroupById(profileId);
		}

		// Agregar por id (usado por pool o select)
		async function addProfileToCycleGroupById(profileId){
			if (!profileId) return alert('Perfil inválido');
			const group = groups.find(g => g.id === currentGroupId);
			if (!group) return alert('Seleccione un grupo primero');
			if (group.participants.some(p => p.profileId === profileId)) return alert('Perfil ya existe en el grupo');
			group.participants.push({ profileId, participation: 50, psycho: { leadership: 50, communication: 50, empathy: 50, creativity: 50, commitment: 50 } });
			const saved = await saveCycleGroup(group);
			if (!saved) return alert('Error agregando perfil');
			groups = groups.map(g => g.id === saved.id ? saved : g);
			// actualizar UI
			updateCycleProfilesSelect();
			renderCycleProfilesPool();
			renderCycleParticipants();
		}

		function renderCycleParticipants(){
			if (participantsList) {
				participantsList.innerHTML = '';
				const group = groups.find(g => g.id === currentGroupId);
				if (!group || group.participants.length === 0) {
					participantsList.innerHTML = '<p class="muted">Sin participantes.</p>';
					return;
				}

				const total = group.participants.reduce((s, p) => s + (p.participation || 50), 0);
				group.participants.forEach(p => {
					const profile = cycleProfiles.find(pr => pr.id === p.profileId);
					if (!profile) return;
					const pct = Math.round((p.participation || 50) / total * 100);
					const card = document.createElement('div');
					card.className = 'participant-card';
					card.innerHTML = `
						<div class="participant-info">
							<div class="participant-name">${escapeHtml(`${profile.firstName || ''} ${profile.lastName || ''}`.trim())}</div>
							<div class="participant-stats">Liderazgo: ${p.psycho?.leadership || 50}% • Comunicación: ${p.psycho?.communication || 50}%</div>
						</div>
						<div class="participation-bar">
							<div class="participation-fill" style="width:${pct}%">${pct}%</div>
						</div>
						<div class="participant-actions">
							<button class="btn edit-psycho" data-id="${p.profileId}">Opciones</button>
							<button class="btn btn-remove remove-profile" data-id="${p.profileId}">Remover</button>
						</div>
					`;
					participantsList.appendChild(card);
				});

				participantsList.querySelectorAll('.edit-psycho').forEach(btn => {
					btn.addEventListener('click', ()=> openCyclePsychoModal(btn.getAttribute('data-id')));
				});
				participantsList.querySelectorAll('.remove-profile').forEach(btn => {
					btn.addEventListener('click', ()=> removeCycleProfile(btn.getAttribute('data-id')));
				});
			}
		}

		function openCyclePsychoModal(profileId){
			const group = groups.find(g => g.id === currentGroupId);
			if (!group) return;
			const part = group.participants.find(p => p.profileId === profileId);
			if (!part) return;
			const profile = cycleProfiles.find(p => p.id === profileId);

			const modalTitle = document.getElementById('psychoModalTitle');
			if (modalTitle) modalTitle.textContent = `${escapeHtml(`${profile?.firstName || ''} ${profile?.lastName || ''}`.trim())} - Opciones socio-psicológicas`;
			if (psychoForm) {
				psychoForm.participantId.value = profileId;
				psychoForm.leadership.value = part.psycho?.leadership || 50;
				psychoForm.communication.value = part.psycho?.communication || 50;
				psychoForm.empathy.value = part.psycho?.empathy || 50;
				psychoForm.creativity.value = part.psycho?.creativity || 50;
				psychoForm.commitment.value = part.psycho?.commitment || 50;
			}

			if (psychoModal) psychoModal.classList.remove('hidden');
		}

		function closeCyclePsychoModal(){ if (psychoModal) psychoModal.classList.add('hidden'); }

		async function saveCyclePsychoOptions(e){
			e.preventDefault();
			if (!psychoForm) return;
			const profileId = psychoForm.participantId.value;
			const group = groups.find(g => g.id === currentGroupId);
			if (!group) return;
			const part = group.participants.find(p => p.profileId === profileId);
			if (!part) return;

			part.psycho = {
				leadership: parseInt(psychoForm.leadership.value) || 50,
				communication: parseInt(psychoForm.communication.value) || 50,
				empathy: parseInt(psychoForm.empathy.value) || 50,
				creativity: parseInt(psychoForm.creativity.value) || 50,
				commitment: parseInt(psychoForm.commitment.value) || 50
			};
			const saved = await saveCycleGroup(group);
			if (!saved) return alert('Error guardando opciones');
			groups = groups.map(g => g.id === saved.id ? saved : g);
			closeCyclePsychoModal();
			renderCycleParticipants();
		}

		async function removeCycleProfile(profileId){
			const group = groups.find(g => g.id === currentGroupId);
			if (!group) return;
			if (!confirm('¿Remover este participante?')) return;
			group.participants = group.participants.filter(p => p.profileId !== profileId);
			const saved = await saveCycleGroup(group);
			if (!saved) return alert('Error removiendo participante');
			groups = groups.map(g => g.id === saved.id ? saved : g);
			updateCycleProfilesSelect();
			renderCycleParticipants();
			renderCycleProfilesPool();
		}
	}

	// ========== NEURAL.JS ==========
	const profilesPool = document.getElementById('profilesPool');
	const nodesContainer = document.getElementById('nodesContainer');
	const createNetworkBtn = document.getElementById('createNetworkBtn');
	const networkNameInput = document.getElementById('networkName');
	const networksSelect = document.getElementById('networksSelect');
	const neuralModal = document.getElementById('neuralModal');
	const nodeStatsForm = document.getElementById('nodeStatsForm');
	const cancelNodeEdit = document.getElementById('cancelNodeEdit');

	if (profilesPool) {
		(async () => {
			let neuralProfiles = [];
			let networks = [];
			let currentNetwork = null;
			let editingNodeId = null;

			async function fetchNeuralProfiles() {
				const res = await fetch('/api/profiles');
				if (!res.ok) return [];
				return res.json();
			}
			async function fetchNetworks() {
				const res = await fetch('/api/networks');
				if (!res.ok) return [];
				return res.json();
			}
			async function createNetwork(payload) {
				const res = await fetch('/api/networks', {
					method: 'POST',
					headers: {'Content-Type':'application/json'},
					body: JSON.stringify(payload)
				});
				return res.ok ? res.json() : null;
			}
			async function updateNetwork(id, payload) {
				const res = await fetch(`/api/networks/${id}`, {
					method: 'PUT',
					headers: {'Content-Type':'application/json'},
					body: JSON.stringify(payload)
				});
				return res.ok ? res.json() : null;
			}

			async function initNeural() {
				neuralProfiles = await fetchNeuralProfiles();
				networks = await fetchNetworks();
				renderNeuralPool();
				renderNeuralNetworksSelect();
			}

			function renderNeuralPool() {
				profilesPool.innerHTML = '';
				neuralProfiles.forEach(p => {
					const el = document.createElement('div');
					el.className = 'neural-node';
					el.dataset.profileId = p.id;
					el.style.cursor = 'pointer';
					el.style.display = 'inline-block';
					const img = document.createElement('img');
					img.src = getPhotoUrl(p);
					img.alt = escapeHtml(p.firstName || '');
					img.style.width = '80px';
					img.style.height = '100px';
					img.style.borderRadius = '4px';
					img.style.objectFit = 'cover';
					img.style.border = '1px solid var(--border)';
					img.onerror = () => {
						img.src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 80 100%22%3E%3Crect fill=%22%23e5e7eb%22 width=%2280%22 height=%22100%22/%3E%3Ctext x=%2240%22 y=%2250%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%236b7280%22 font-size=%2210%22 font-family=%22Arial%22%3ENo foto%3C/text%3E%3C/svg%3E';
					};
					const overlay = document.createElement('div');
					overlay.className = 'neural-overlay';
					overlay.style.position = 'absolute';
					overlay.style.top = '0';
					overlay.style.left = '0';
					overlay.style.width = '100%';
					overlay.style.height = '100%';
					overlay.style.background = 'rgba(0,0,0,0.6)';
					overlay.style.color = '#fff';
					overlay.style.display = 'flex';
					overlay.style.flexDirection = 'column';
					overlay.style.alignItems = 'center';
					overlay.style.justifyContent = 'center';
					overlay.style.opacity = '0';
					overlay.style.transition = 'opacity .15s ease';
					overlay.style.borderRadius = '4px';
					overlay.style.fontSize = '10px';
					overlay.style.padding = '4px';
					overlay.style.boxSizing = 'border-box';
					overlay.style.textAlign = 'center';
					if (window.__isAdmin) {
						overlay.innerHTML = `
							<div style="font-weight:bold;font-size:11px">${escapeHtml(p.firstName||'')} ${escapeHtml(p.lastName||'')}</div>
							<div style="font-size:9px;margin-top:4px;color:#ddd">Clic para agregar</div>
						`;
						el.addEventListener('click', () => addNeuralToNetwork(p.id));
					} else {
						overlay.innerHTML = `
							<div style="font-weight:bold;font-size:11px">${escapeHtml(p.firstName||'')} ${escapeHtml(p.lastName||'')}</div>
							<div style="font-size:9px;margin-top:4px;color:#ddd">Sólo administradores</div>
						`;
						el.style.cursor = 'default';
					}
					el.appendChild(img);
					el.appendChild(overlay);
					el.style.position = 'relative';
					el.addEventListener('mouseenter', () => overlay.style.opacity = '1');
					el.addEventListener('mouseleave', () => overlay.style.opacity = '0');
					profilesPool.appendChild(el);
				});
			}

			function renderNeuralNetworksSelect() {
				networksSelect.innerHTML = '<option value="">-- Seleccionar red existente --</option>';
				networks.forEach(n => {
					const o = document.createElement('option');
					o.value = n.id;
					o.textContent = n.name || `Red ${n.id.substring(0,6)}`;
					networksSelect.appendChild(o);
				});
			}

			if (createNetworkBtn) {
				if (window.__isAdmin) {
					createNetworkBtn.addEventListener('click', async () => {
						const name = (networkNameInput.value || '').trim();
						if (!name) return alert('Asigne un nombre a la red.');
						const payload = { name, nodes: [], links: [] };
						const created = await createNetwork(payload);
						if (!created) return alert('Error creando la red.');
						networks.unshift(created);
						renderNeuralNetworksSelect();
						networksSelect.value = created.id;
						loadNeuralNetwork(created);
						networkNameInput.value = '';
					});
				} else {
					createNetworkBtn.style.display = 'none';
					if (networkNameInput) networkNameInput.style.display = 'none';
				}
			}

			if (networksSelect) {
				networksSelect.addEventListener('change', async () => {
					const id = networksSelect.value;
					if (!id) {
						currentNetwork = null;
						nodesContainer.innerHTML = '';
						return;
					}
					const n = networks.find(x => x.id === id);
					if (!n) {
						networks = await fetchNetworks();
					}
					const selected = networks.find(x => x.id === id);
					if (selected) loadNeuralNetwork(selected);
				});
			}

			async function addNeuralToNetwork(profileId) {
				if (!networksSelect.value) return alert('Seleccione o cree una red primero.');
				
				if (!currentNetwork) {
					const sel = networks.find(x => x.id === networksSelect.value);
					if (!sel) return alert('Red no encontrada');
					currentNetwork = JSON.parse(JSON.stringify(sel));
				}
				
				if (currentNetwork.nodes?.some(n=>n.profileId===profileId)) {
					return alert('Perfil ya está en la red.');
				}
				
				const node = {
					profileId,
					stats: { amistad:50, odio:0, estres:10 },
					createdAt: new Date()
				};
				
				currentNetwork.nodes = currentNetwork.nodes || [];
				currentNetwork.nodes.push(node);
				
				const payloadToSend = {
					name: currentNetwork.name,
					nodes: currentNetwork.nodes,
					links: currentNetwork.links || []
				};
				
				const updated = await updateNetwork(currentNetwork.id, payloadToSend);
				if (updated) {
					currentNetwork = updated;
					networks = networks.map(n => n.id === updated.id ? updated : n);
					renderNeuralNetworkView();
				} else {
					alert('Error al agregar perfil a la red');
				}
			}

			async function removeNeuralNode(profileId) {
				if (!window.__isAdmin) return alert('Permisos insuficientes');
				if (!currentNetwork) return;
				if (!confirm('Quitar este nodo de la red?')) return;
				currentNetwork.nodes = (currentNetwork.nodes||[]).filter(n => n.profileId !== profileId);
				const payloadToSend = { name: currentNetwork.name, nodes: currentNetwork.nodes, links: currentNetwork.links || [] };
				const updated = await updateNetwork(currentNetwork.id, payloadToSend);
				if (updated) {
					currentNetwork = updated;
					networks = networks.map(n => n.id === updated.id ? updated : n);
					renderNeuralNetworkView();
				} else {
					alert('Error removiendo nodo de la red');
				}
			}

			function loadNeuralNetwork(net) {
				currentNetwork = JSON.parse(JSON.stringify(net));
				renderNeuralNetworkView();
			}

			function renderNeuralNetworkView() {
				nodesContainer.innerHTML = '';
				
				if (!currentNetwork || !currentNetwork.nodes || currentNetwork.nodes.length === 0) {
					nodesContainer.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:20px">Agrega perfiles a la red</div>';
					return;
				}

				(currentNetwork.nodes||[]).forEach((node) => {
					const p = neuralProfiles.find(x => x.id === node.profileId);
					if (!p) return;
					
					const wrapper = document.createElement('div');
					wrapper.className = 'neural-node';
					wrapper.dataset.profileId = node.profileId;
					wrapper.style.position = 'relative';
					wrapper.style.cursor = 'pointer';
					
					const img = document.createElement('img');
					img.src = getPhotoUrl(p);
					img.alt = escapeHtml(p.firstName || '');
					img.style.width = '100px';
					img.style.height = '120px';
					img.style.borderRadius = '6px';
					img.style.objectFit = 'cover';
					img.style.border = '2px solid var(--border)';
					img.style.display = 'block';
					img.onerror = () => {
						img.src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 120%22%3E%3Crect fill=%22%23e5e7eb%22 width=%22100%22 height=%22120%22/%3E%3Ctext x=%2250%22 y=%2260%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%236b7280%22 font-size=%2212%22 font-family=%22Arial%22%3ENo foto%3C/text%3E%3C/svg%3E';
					};
					
					const overlay = document.createElement('div');
					overlay.className = 'neural-overlay';
					overlay.style.position = 'absolute';
					overlay.style.top = '0';
					overlay.style.left = '0';
					overlay.style.width = '100%';
					overlay.style.height = '100%';
					overlay.style.background = 'rgba(0,0,0,0.7)';
					overlay.style.color = '#fff';
					overlay.style.display = 'flex';
					overlay.style.flexDirection = 'column';
					overlay.style.alignItems = 'center';
					overlay.style.justifyContent = 'center';
					overlay.style.opacity = '0';
					overlay.style.transition = 'opacity .2s ease';
					overlay.style.borderRadius = '6px';
					overlay.style.fontSize = '11px';
					overlay.style.padding = '6px';
					overlay.style.boxSizing = 'border-box';
					overlay.style.textAlign = 'center';
					overlay.style.zIndex = '10';
					overlay.innerHTML = `
						<div style="font-weight:bold;font-size:12px;margin-bottom:6px">${escapeHtml(p.firstName||'')} ${escapeHtml(p.lastName||'')}</div>
						<div style="font-size:10px;color:#ccc">
							<div>Amistad: ${Number(node.stats?.amistad||0)}%</div>
							<div>Odio: ${Number(node.stats?.odio||0)}%</div>
							<div>Estrés: ${Number(node.stats?.estres||0)}%</div>
						</div>
					`;
					
					wrapper.appendChild(img);
					wrapper.appendChild(overlay);
					
					wrapper.addEventListener('mouseenter', () => overlay.style.opacity = '1');
					wrapper.addEventListener('mouseleave', () => overlay.style.opacity = '0');
					wrapper.addEventListener('click', (ev) => {
						ev.stopPropagation();
						openNeuralNodeEditor(node.profileId);
					});
					// remove button for admins
					if (window.__isAdmin) {
						const rem = document.createElement('button');
						rem.className = 'neural-remove-btn';
						rem.textContent = 'Quitar';
						rem.style.position = 'absolute';
						rem.style.top = '6px';
						rem.style.right = '6px';
						rem.style.zIndex = '20';
						rem.style.fontSize = '11px';
						rem.style.padding = '4px 6px';
						rem.style.borderRadius = '4px';
						rem.style.border = 'none';
						rem.style.background = 'rgba(0,0,0,0.6)';
						rem.style.color = '#fff';
						rem.addEventListener('click', (ev)=>{ ev.stopPropagation(); removeNeuralNode(node.profileId); });
						wrapper.appendChild(rem);
					}
					
					nodesContainer.appendChild(wrapper);
				});
			}

			function openNeuralNodeEditor(profileId) {
				if (!window.__isAdmin) return alert('Permisos insuficientes');
				if (!currentNetwork) return;
				const node = (currentNetwork.nodes||[]).find(n => n.profileId === profileId);
				if (!node) return;
				const p = neuralProfiles.find(x => x.id === profileId);
				editingNodeId = profileId;
				const modalTitle = document.getElementById('modalTitle');
				if (modalTitle) modalTitle.textContent = `Editar: ${escapeHtml(p?.firstName || '')} ${escapeHtml(p?.lastName || '')}`;
				if (nodeStatsForm) {
					nodeStatsForm.amistad.value = node.stats?.amistad ?? 50;
					nodeStatsForm.odio.value = node.stats?.odio ?? 0;
					nodeStatsForm.estres.value = node.stats?.estres ?? 10;
				}
				if (neuralModal) neuralModal.setAttribute('aria-hidden','false');
			}

			if (cancelNodeEdit) {
				cancelNodeEdit.addEventListener('click', () => {
					if (neuralModal) neuralModal.setAttribute('aria-hidden','true');
					editingNodeId = null;
				});
			}

			if (nodeStatsForm) {
				if (window.__isAdmin) {
					nodeStatsForm.addEventListener('submit', async (e) => {
						e.preventDefault();
						if (!currentNetwork || !editingNodeId) return;
						const node = (currentNetwork.nodes||[]).find(n => n.profileId === editingNodeId);
						if (!node) return;
						node.stats = {
							amistad: Number(nodeStatsForm.amistad.value) || 0,
							odio: Number(nodeStatsForm.odio.value) || 0,
							estres: Number(nodeStatsForm.estres.value) || 0,
						};
					
						const payloadToSend = {
							name: currentNetwork.name,
							nodes: currentNetwork.nodes,
							links: currentNetwork.links || []
						};
					
						const updated = await updateNetwork(currentNetwork.id, payloadToSend);
						if (updated) {
							currentNetwork = updated;
							networks = networks.map(n => n.id === updated.id ? updated : n);
							renderNeuralNetworkView();
						}
						if (neuralModal) neuralModal.setAttribute('aria-hidden','true');
						editingNodeId = null;
					});
				} else {
					// disable editing for non-admins
					nodeStatsForm.querySelectorAll('input,button,select,textarea').forEach(el=>el.disabled=true);
					if (cancelNodeEdit) cancelNodeEdit.style.display = 'none';
				}
			}

			await initNeural();
		})();
	}

	// ========== LOCATIONS.JS ==========
	const locationsListContainer = document.getElementById('locationsListContainer');
	
	if (window) {
		// Obtener perfiles desde API
		async function fetchLocationsProfiles() {
			try {
				const res = await fetch('/api/profiles');
				if (!res.ok) return [];
				return await res.json();
			} catch (err) { console.error('fetchProfiles error', err); return []; }
		}

		// Cache simple para Nominatim
		const geocodeCache = new Map();
		async function geocodeLocation(query) {
			if (!query) return null;
			const key = query.trim().toLowerCase();
			if (geocodeCache.has(key)) return geocodeCache.get(key);
			try {
				const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
				const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
				if (!res.ok) { geocodeCache.set(key, null); return null; }
				const data = await res.json();
				if (!Array.isArray(data) || data.length === 0) { geocodeCache.set(key, null); return null; }
				const out = { lat: Number(data[0].lat), lng: Number(data[0].lon) };
				geocodeCache.set(key, out);
				return out;
			} catch (err) { console.error('geocode error', err); geocodeCache.set(key, null); return null; }
		}

		// Nombre mostrable
		function getDisplayName(p) {
			if (!p) return 'Usuario';
			if (p.fullName) return String(p.fullName).trim();
			if (p.firstName || p.lastName) return `${p.firstName||''} ${p.lastName||''}`.trim();
			if (p.name) return String(p.name).trim();
			if (p.email) return String(p.email).split('@')[0];
			return 'Usuario';
		}

		// Esperar a que el mapa 3D (maplibre) esté listo y luego cargar ubicaciones
		async function loadLocationsOnGlobe() {
			const profiles = await fetchLocationsProfiles();
			if (window.clear3DMarkers) window.clear3DMarkers();

			// Group profiles by coordinates (rounded) so multiple profiles at same place appear together
			const groups = new Map();
			const pendingLocationStrings = new Map(); // locationString -> [profiles]

			for (const p of profiles) {
				if (typeof p.lat === 'number' && typeof p.lng === 'number') {
					const lat = Number(p.lat);
					const lng = Number(p.lng);
					const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
					if (!groups.has(key)) groups.set(key, { coords: {lat,lng}, profiles: [] });
					groups.get(key).profiles.push(p);
					continue;
				}

				// build a full location string from locality/province/department/country if available
				let locStr = null;
				if (p.location && String(p.location).trim()) {
					locStr = String(p.location).trim();
				} else {
					const parts = [];
					const loc = (p.locality || p.district || p.caserio || p.city || '').trim();
					if (loc) parts.push(loc);
					if (p.province) parts.push(String(p.province).trim());
					if (p.department) parts.push(String(p.department).trim());
					if (p.country) parts.push(String(p.country).trim());
					if (parts.length) locStr = parts.join(', ');
				}

				if (locStr) {
					if (!pendingLocationStrings.has(locStr)) pendingLocationStrings.set(locStr, []);
					pendingLocationStrings.get(locStr).push(p);
				}
			}

			// Geocode unique location strings once and group results
			for (const [locStr, plist] of pendingLocationStrings.entries()) {
				let coords = await geocodeLocation(locStr);
				// try with country hint if not found
				if (!coords) coords = await geocodeLocation(locStr + ', Peru');
				if (!coords) {
					// if still no coords, skip but mark profiles so they don't get lost
					console.warn('No coords for', locStr);
					continue;
				}
				const lat = Number(coords.lat), lng = Number(coords.lng);
				const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
				if (!groups.has(key)) groups.set(key, { coords: {lat,lng}, profiles: [] });
				groups.get(key).profiles.push(...plist);
			}

			// Add markers for each group
			for (const [key, bucket] of groups.entries()) {
				const coords = bucket.coords;
				const plist = bucket.profiles || [];
				const locationKey = key; // already a good string
				try {
					window.addOrUpdateGroupMarker(locationKey, coords, plist);
				} catch (e) { console.error('add group marker error', e); }
			}

			if (window.fit3DMarkers) {
				setTimeout(() => { try { window.fit3DMarkers(); } catch(e){/*ignore*/} }, 300);
			}
		}

		(function waitForMap(){ if (window._map3d) loadLocationsOnGlobe(); else setTimeout(waitForMap, 200); })();

		// ===========================
		// DYNAMIC OSM LABELS (Overpass)
		// Carga etiquetas de "place" y centroides admin para el viewport cuando
		// estamos dentro / cerca de Perú y con zoom suficiente.
		// ===========================
		(function setupOverpassAndQuota() {
			const PERU_BBOX = { minLat: -18.35, minLng: -81.35, maxLat: 1.83, maxLng: -68.65 };
			const LABEL_SOURCE_ID = 'osm-peru-labels-src';
			const LABEL_LAYER_ID = 'osm-peru-labels-layer';
			const overpassEndpoint = '/api/overpass';
			const labelsCache = new Map(); // key -> GeoJSON
			let lastLabelsRequest = 0;

			// Quota cliente (ventana)
			const OVERPASS_MAX = 10;
			const OVERPASS_WINDOW = 60_000;
			const overpassTimestamps = [];
			const quotaUsageEl = () => document.getElementById('quotaUsage');
			const quotaResetEl = () => document.getElementById('quotaReset');
			const quotaLastEl = () => document.getElementById('quotaLast');

			// Fallback raster labels
			const FALLBACK_SRC = 'stamen-fallback-src';
			const FALLBACK_LAYER = 'stamen-fallback-layer';

			function pruneOverpassTimestamps() {
				const now = Date.now();
				while (overpassTimestamps.length && (now - overpassTimestamps[0]) > OVERPASS_WINDOW) overpassTimestamps.shift();
			}
			function canSendOverpass() { pruneOverpassTimestamps(); return overpassTimestamps.length < OVERPASS_MAX; }
			function recordOverpassRequest() { overpassTimestamps.push(Date.now()); pruneOverpassTimestamps(); updateQuotaUI(); }
			function nextResetInMs() { pruneOverpassTimestamps(); if (overpassTimestamps.length === 0) return 0; return Math.max(0, OVERPASS_WINDOW - (Date.now() - overpassTimestamps[0])); }
			function formatMs(ms) { const s = Math.ceil(ms/1000); const mm = Math.floor(s/60).toString().padStart(2,'0'); const ss = (s%60).toString().padStart(2,'0'); return `${mm}:${ss}`; }
			function updateQuotaUI(lastText) {
				try {
					const used = Math.min(overpassTimestamps.length, OVERPASS_MAX);
					if (quotaUsageEl()) quotaUsageEl().textContent = `Usos: ${used} / ${OVERPASS_MAX}`;
					const nr = nextResetInMs();
					if (quotaResetEl()) quotaResetEl().textContent = `Reset: ${nr ? formatMs(nr) : 'ahora'}`;
					if (quotaLastEl() && lastText) quotaLastEl().textContent = `Última: ${lastText}`;
				} catch (e) { /* ignore */ }
			}
			function startQuotaTicker() { setInterval(() => updateQuotaUI(), 1000); }

			// helper: find label layer id
			function findLabelLayerIdForMap(map) {
				try {
					const layers = map.getStyle().layers || [];
					for (let i = 0; i < layers.length; i++) {
						const ly = layers[i];
						if (ly.type === 'symbol' && ly.layout && (ly.layout['text-field'] || ly.layout['text-max-width'])) return ly.id;
					}
				} catch (e) { /* ignore */ }
				return null;
			}
			async function addFallbackLabelsLayer(map) {
				try {
					if (!map) return;
					if (map.getLayer && map.getLayer(FALLBACK_LAYER)) { map.setLayoutProperty(FALLBACK_LAYER, 'visibility', 'visible'); return; }
					if (!map.getSource(FALLBACK_SRC)) {
						map.addSource(FALLBACK_SRC, { type: 'raster', tiles: ['https://stamen-tiles.a.ssl.fastly.net/toner-labels/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 20 });
					}
					const before = findLabelLayerIdForMap(map);
					map.addLayer({ id: FALLBACK_LAYER, type: 'raster', source: FALLBACK_SRC, paint: { 'raster-opacity': 1.0 } }, before || undefined);
				} catch (e) { /* ignore */ }
			}
			function hideFallbackLabelsLayer(map) { try { if (map && map.getLayer && map.getLayer(FALLBACK_LAYER)) map.setLayoutProperty(FALLBACK_LAYER, 'visibility', 'none'); } catch(e){/*ignore*/} }

			function bboxIntersectsPeru(bbox) {
				return !(bbox.north < PERU_BBOX.minLat || bbox.south > PERU_BBOX.maxLat || bbox.east < PERU_BBOX.minLng || bbox.west > PERU_BBOX.maxLng);
			}

			function makeCacheKey(bbox) {
				const s = bbox.south.toFixed(2), w = bbox.west.toFixed(2), n = bbox.north.toFixed(2), e = bbox.east.toFixed(2);
				return `${s},${w},${n},${e}`;
			}

			async function fetchOverpassGeoJSON(bbox) {
				const key = makeCacheKey(bbox);
				if (labelsCache.has(key)) return labelsCache.get(key);
				const now = Date.now();
				if (now - lastLabelsRequest < 800) return null;
				if (!canSendOverpass()) { updateQuotaUI(); return null; }
				lastLabelsRequest = now;

				const s = bbox.south, w = bbox.west, n = bbox.north, e = bbox.east;
				const query = `
					[out:json][timeout:25];
					(
						node["place"](${s},${w},${n},${e});
						relation["boundary"="administrative"]["admin_level"~"6|8"](${s},${w},${n},${e});
					);
					out center;
				`;
				try {
					recordOverpassRequest();
					const res = await fetch(overpassEndpoint, { method: 'POST', body: query, headers: { 'Content-Type': 'text/plain' } });
					if (!res.ok) return null;
					const data = await res.json();
					if (!data || !Array.isArray(data.elements)) return null;
					const features = [];
					for (const el of data.elements) {
						if (el.type === 'node' && el.lat && el.lon && el.tags && el.tags.name) {
							features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [el.lon, el.lat] }, properties: { name: el.tags['name:es'] || el.tags.name, kind: el.tags.place || 'place' } });
						} else if ((el.type === 'relation' || el.type === 'way') && el.center && el.tags && el.tags.name) {
							const c = el.center;
							features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: { name: el.tags['name:es'] || el.tags.name, kind: 'admin', admin_level: el.tags.admin_level || null } });
						}
					}
					const geo = { type: 'FeatureCollection', features };
					labelsCache.set(key, geo);
					updateQuotaUI(new Date().toLocaleTimeString());
					return geo;
				} catch (err) {
					console.error('Overpass fetch error', err);
					updateQuotaUI('error');
					return null;
				}
			}

			function ensureLabelsLayer(map) {
				try {
					if (!map.getSource(LABEL_SOURCE_ID)) map.addSource(LABEL_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
					if (!map.getLayer(LABEL_LAYER_ID)) {
						map.addLayer({
							id: LABEL_LAYER_ID,
							type: 'symbol',
							source: LABEL_SOURCE_ID,
							layout: {
								'text-field': ['coalesce', ['get', 'name'], ''],
								'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 10, 12, 14, 14],
								'text-offset': [0, 0.2],
								'text-anchor': 'top'
							},
							paint: { 'text-color': '#083b66', 'text-halo-color': '#fff', 'text-halo-width': 1.5, 'text-opacity': 0.95 }
						});
					}
				} catch (e) { /* ignore */ }
			}

			async function updateLabelsForViewport() {
				const map = window._map3d;
				if (!map) return;
				const z = map.getZoom();
				if (z < 6) {
					try { if (map.getLayer(LABEL_LAYER_ID)) map.setLayoutProperty(LABEL_LAYER_ID, 'visibility', 'none'); } catch(e){/*ignore*/}
					try { hideFallbackLabelsLayer(map); } catch(e){/*ignore*/}
					return;
				}
				const bounds = map.getBounds();
				const bbox = { south: bounds.getSouth(), west: bounds.getWest(), north: bounds.getNorth(), east: bounds.getEast() };
				if (!bboxIntersectsPeru(bbox)) {
					try { if (map.getLayer(LABEL_LAYER_ID)) map.setLayoutProperty(LABEL_LAYER_ID, 'visibility', 'none'); } catch(e){/*ignore*/}
					try { hideFallbackLabelsLayer(map); } catch(e){/*ignore*/}
					return;
				}
				ensureLabelsLayer(map);
				const geo = await fetchOverpassGeoJSON(bbox);
				if (geo && map.getSource(LABEL_SOURCE_ID)) {
					map.getSource(LABEL_SOURCE_ID).setData(geo);
					try { map.setLayoutProperty(LABEL_LAYER_ID, 'visibility', 'visible'); } catch(e){/*ignore*/}
					try { hideFallbackLabelsLayer(map); } catch(e){/*ignore*/}
				} else {
					try { addFallbackLabelsLayer(map); } catch(e){/*ignore*/}
				}
			}

			// Attach listeners when map is ready
			(function waitForLabelsMap(){
				const map = window._map3d;
				if (!map) return setTimeout(waitForLabelsMap, 300);
				const deb = (function debounce(fn, wait) { let t = null; return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); }; })(updateLabelsForViewport, 700);
				map.on('moveend', deb);
				map.on('zoomend', deb);
				setTimeout(updateLabelsForViewport, 600);
				updateQuotaUI();
				startQuotaTicker();
			})();
		})(); // end setupOverpassAndQuota

		// Exponer API mínima
		window.locationsApp = { fetchLocationsProfiles, geocodeLocation, loadLocationsOnGlobe };
 	}
 });
