// Unified locations script: list + mini-maps (read-only) + edit (geocode & persist)
(function () {
	// helpers
	const $ = sel => document.querySelector(sel);

	// DOM nodes
	const container = document.getElementById('locationsListContainer');
	const tileInfoEl = $('#tileInfo');
	const mapEl = $('#map'); // optional main map (may not exist)

	// optional main map state
	let mainMap = null, mainTileLayer = null, mainTileCount = 0;
	function initMainMap() {
		if (!mapEl || !window.L) return;
		if (mainMap) return;
		mainMap = L.map(mapEl, { center: [20, 0], zoom: 2, zoomControl: false, attributionControl: false });
		mainTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 16 }).addTo(mainMap);
		L.control.zoom({ position: 'topright' }).addTo(mainMap);
		mainTileLayer.on('tileload', () => { mainTileCount++; if (tileInfoEl) tileInfoEl.textContent = `Tiles: ${mainTileCount}`; });
	}

	// escape helper
	function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

	// country flag helpers
	function parseCountryCode(location) {
		if (!location) return '';
		const parts = location.trim().split(/[,\s]+/);
		const last = parts[parts.length - 1] || '';
		return (last.length === 2) ? last.toLowerCase() : '';
	}
	function getFlagUrl(code) { if (!code) return ''; return `https://flagcdn.com/w40/${code.toLowerCase()}.png`; }

	// fetch profiles from server
	async function fetchProfiles() {
		try {
			const res = await fetch('/api/profiles');
			if (!res.ok) return [];
			return await res.json();
		} catch (err) {
			console.error('fetchProfiles error', err);
			return [];
		}
	}

	// geocoding with cache (Nominatim)
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
		} catch (err) {
			console.error('geocode error', err);
			geocodeCache.set(key, null);
			return null;
		}
	}

	// mini-map management
	const mapsById = new Map();

	function destroyMiniMap(id) {
		const e = mapsById.get(id);
		if (!e) return;
		try { e.map.remove(); } catch (err) { /* ignore */ }
		mapsById.delete(id);
	}

	function createMiniMap(containerEl, coords) {
		// ensure container has height so Leaflet can render
		if (!containerEl.style.height) containerEl.style.height = '140px';
		if (!window.L) {
			containerEl.innerHTML = '<div style="color:#888;font-size:12px;padding:12px;text-align:center">Mapa no disponible</div>';
			return null;
		}
		containerEl.innerHTML = '';
		const map = L.map(containerEl, {
			center: coords ? [coords.lat, coords.lng] : [0, 0],
			zoom: coords ? 13 : 2,
			zoomControl: false,
			attributionControl: false,
			dragging: true,
			scrollWheelZoom: true,
			doubleClickZoom: true,
			boxZoom: false,
			keyboard: false,
			tap: false
		});
		L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
		let marker = null;
		if (coords) marker = L.marker([coords.lat, coords.lng]).addTo(map);
		return { map, marker };
	}

	function updateMiniMapForProfile(p) {
		const id = p.id || (p._id && String(p._id)) || '';
		const containerEl = document.getElementById(`miniMap_${id}`);
		if (!containerEl) return;
		
		// encontrar el elemento de ubicación para actualizar dinámicamente
		const profileItemEl = containerEl.closest('.profile-item');
		const locationSpanEl = profileItemEl ? profileItemEl.querySelector('.profile-location') : null;
		
		if (typeof p.lat === 'number' && typeof p.lng === 'number') {
			const coords = { lat: p.lat, lng: p.lng };
			if (mapsById.has(id)) {
				const entry = mapsById.get(id);
				try {
					entry.map.setView([coords.lat, coords.lng], 13);
					if (entry.marker) {
						entry.marker.setLatLng([coords.lat, coords.lng]);
					} else {
						entry.marker = L.marker([coords.lat, coords.lng]).addTo(entry.map);
					}
				} catch (err) {
					console.error('Error actualizando mini-mapa', err);
				}
			} else {
				const entry = createMiniMap(containerEl, coords);
				mapsById.set(id, entry);
				
				// agregar listener para cambios de vista (moveend = cuando termina de arrastrar/zoom)
				entry.map.on('moveend', () => {
					const center = entry.map.getCenter();
					const lat = center.lat.toFixed(4);
					const lng = center.lng.toFixed(4);
					if (locationSpanEl) {
						locationSpanEl.textContent = `${lat}, ${lng}`;
					}
				});
			}
		} else {
			destroyMiniMap(id);
			createMiniMap(containerEl, null);
		}
	}

	// extraer "Ciudad/País" desde location (ej. "Caracas, Distrito Capital, Venezuela" -> "Caracas/Venezuela")
	function extractCity(location) {
		if (!location) return '';
		const parts = String(location).split(',').map(s => s.trim()).filter(Boolean);
		if (parts.length === 0) return '';
		const city = parts[0];
		const country = parts.length > 1 ? parts[parts.length - 1] : '';
		return country ? `${city}/${country}` : city;
	}

	// Priorizar y derivar un nombre display (soporta varios esquemas de campo)
	function getDisplayName(p) {
		if (!p) return 'Usuario';
		if (p.fullName) return String(p.fullName).trim();
		if (p.full_name) return String(p.full_name).trim();
		if (p.nombre) return String(p.nombre).trim();
		if (p.name) return String(p.name).trim();
		if ((p.firstName || p.first_name) && (p.lastName || p.last_name)) {
			const fn = p.firstName || p.first_name || '';
			const ln = p.lastName || p.last_name || '';
			return `${String(fn).trim()} ${String(ln).trim()}`.trim();
		}
		if (p.username) return String(p.username).trim();
		if (p.user) return String(p.user).trim();
		if (p.email) return String(p.email).split('@')[0];
		return 'Usuario';
	}

	// render profiles list (solo lectura: nombre + ciudad/país + mini-mapa)
	async function renderProfilesList() {
		const profiles = await fetchProfiles();
		// destroy previous mini-maps to avoid leaks/mismatches
		for (const id of Array.from(mapsById.keys())) destroyMiniMap(id);
		container.innerHTML = '';
		profiles.forEach((p, idx) => {
			// asegurar id único: usar id, _id o índice como fallback
			const id = p.id || (p._id && String(p._id)) || `idx_${idx}`;
			const cityCountry = extractCity(p.location);
			const avatarUrl = p.avatar || p.photo || p.picture || '';
			// Priorizar nombre completo antes de username
			const displayUser = getDisplayName(p);
			const profileEl = document.createElement('div');
			profileEl.className = 'profile-item';
			profileEl.innerHTML = `
				<div class="profile-left">
					<div class="avatar-wrap">
						${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(displayUser)}" class="profile-avatar">` : `<div class="avatar-placeholder">?</div>`}
					</div>
				</div>
				<div class="profile-main">
					<div class="profile-info">
						<strong class="profile-name">${escapeHtml(displayUser)}</strong>
						<br>
						<span class="profile-location">${escapeHtml(cityCountry)}</span>
					</div>
				</div>
				<div id="miniMap_${id}" class="mini-map"></div>
			`;
			container.appendChild(profileEl);

			// crear/actualizar mini-mapa para este perfil (usa p.lat / p.lng si existen)
			updateMiniMapForProfile(Object.assign({}, p, { id }));
		});
	}

	// inicialización
	document.addEventListener('DOMContentLoaded', () => {
		initMainMap();
		renderProfilesList();
	});

	// Expose for debugging (optional)
	window.locationsApp = {
		fetchProfiles,
		geocodeLocation,
		renderProfilesList,
		updateMiniMapForProfile
	};
})();
