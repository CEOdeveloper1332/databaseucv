(async () => {
	// DOM
	const profilesPool = document.getElementById('profilesPool');
	const nodesContainer = document.getElementById('nodesContainer');
	const createNetworkBtn = document.getElementById('createNetworkBtn');
	const networkNameInput = document.getElementById('networkName');
	const networksSelect = document.getElementById('networksSelect');
	const neuralModal = document.getElementById('neuralModal');
	const nodeStatsForm = document.getElementById('nodeStatsForm');
	const cancelNodeEdit = document.getElementById('cancelNodeEdit');

	let profiles = [];
	let networks = [];
	let currentNetwork = null;
	let editingNodeId = null;

	// helpers fetch
	async function fetchProfiles() {
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

	// initialize
	async function init() {
		profiles = await fetchProfiles();
		networks = await fetchNetworks();
		renderPool();
		renderNetworksSelect();
	}

	function renderPool() {
		profilesPool.innerHTML = '';
		profiles.forEach(p => {
			const el = document.createElement('div');
			el.className = 'neural-node';
			el.dataset.profileId = p.id;
			el.style.cursor = 'pointer';
			el.style.display = 'inline-block';
			const img = document.createElement('img');
			img.src = p.photo || '';
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
			overlay.innerHTML = `
				<div style="font-weight:bold;font-size:11px">${escapeHtml(p.firstName||'')} ${escapeHtml(p.lastName||'')}</div>
				<div style="font-size:9px;margin-top:4px;color:#ddd">Clic para agregar</div>
			`;
			el.appendChild(img);
			el.appendChild(overlay);
			el.style.position = 'relative';
			el.addEventListener('mouseenter', () => overlay.style.opacity = '1');
			el.addEventListener('mouseleave', () => overlay.style.opacity = '0');
			el.addEventListener('click', () => addToNetwork(p.id));
			profilesPool.appendChild(el);
		});
	}

	function renderNetworksSelect() {
		networksSelect.innerHTML = '<option value="">-- Seleccionar red existente --</option>';
		networks.forEach(n => {
			const o = document.createElement('option');
			o.value = n.id;
			o.textContent = n.name || `Red ${n.id.substring(0,6)}`;
			networksSelect.appendChild(o);
		});
	}

	function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

	// create new network
	createNetworkBtn.addEventListener('click', async () => {
		const name = (networkNameInput.value || '').trim();
		if (!name) return alert('Asigne un nombre a la red.');
		const payload = { name, nodes: [], links: [] };
		const created = await createNetwork(payload);
		if (!created) return alert('Error creando la red.');
		networks.unshift(created);
		renderNetworksSelect();
		networksSelect.value = created.id;
		loadNetwork(created);
		networkNameInput.value = '';
	});

	// on select network
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
		if (selected) loadNetwork(selected);
	});

	// add profile to current network
	async function addToNetwork(profileId) {
		if (!networksSelect.value) return alert('Seleccione o cree una red primero.');
		
		// asegurar que currentNetwork esté cargado
		if (!currentNetwork) {
			const sel = networks.find(x => x.id === networksSelect.value);
			if (!sel) return alert('Red no encontrada');
			currentNetwork = JSON.parse(JSON.stringify(sel));
		}
		
		// evitar duplicados
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
		
		// persist - preparar payload sin _id
		const payloadToSend = {
			name: currentNetwork.name,
			nodes: currentNetwork.nodes,
			links: currentNetwork.links || []
		};
		
		const updated = await updateNetwork(currentNetwork.id, payloadToSend);
		if (updated) {
			currentNetwork = updated;
			networks = networks.map(n => n.id === updated.id ? updated : n);
			renderNetworkView();
		} else {
			alert('Error al agregar perfil a la red');
		}
	}

	async function refreshNetworks(){
		networks = await fetchNetworks();
		renderNetworksSelect();
	}

	// load network into view
	function loadNetwork(net) {
		currentNetwork = JSON.parse(JSON.stringify(net)); // clone
		renderNetworkView();
	}

	// render nodes GROUPED (sin enlazar ni líneas)
	function renderNetworkView() {
		nodesContainer.innerHTML = '';
		
		if (!currentNetwork || !currentNetwork.nodes || currentNetwork.nodes.length === 0) {
			nodesContainer.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:20px">Agrega perfiles a la red</div>';
			return;
		}

		// render nodes en grupos simples
		(currentNetwork.nodes||[]).forEach((node) => {
			const p = profiles.find(x => x.id === node.profileId);
			if (!p) return;
			
			const wrapper = document.createElement('div');
			wrapper.className = 'neural-node';
			wrapper.dataset.profileId = node.profileId;
			wrapper.style.position = 'relative';
			wrapper.style.cursor = 'pointer';
			
			const img = document.createElement('img');
			img.src = p.photo || '';
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
				openNodeEditor(node.profileId);
			});
			
			nodesContainer.appendChild(wrapper);
		});
	}

	// open editor modal for node stats
	function openNodeEditor(profileId) {
		if (!currentNetwork) return;
		const node = (currentNetwork.nodes||[]).find(n => n.profileId === profileId);
		if (!node) return;
		const p = profiles.find(x => x.id === profileId);
		editingNodeId = profileId;
		document.getElementById('modalTitle').textContent = `Editar: ${escapeHtml(p?.firstName || '')} ${escapeHtml(p?.lastName || '')}`;
		nodeStatsForm.amistad.value = node.stats?.amistad ?? 50;
		nodeStatsForm.odio.value = node.stats?.odio ?? 0;
		nodeStatsForm.estres.value = node.stats?.estres ?? 10;
		neuralModal.setAttribute('aria-hidden','false');
	}

	cancelNodeEdit.addEventListener('click', () => {
		neuralModal.setAttribute('aria-hidden','true');
		editingNodeId = null;
	});

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
		
		// preparar payload sin _id
		const payloadToSend = {
			name: currentNetwork.name,
			nodes: currentNetwork.nodes,
			links: currentNetwork.links || []
		};
		
		const updated = await updateNetwork(currentNetwork.id, payloadToSend);
		if (updated) {
			currentNetwork = updated;
			networks = networks.map(n => n.id === updated.id ? updated : n);
			renderNetworkView();
		}
		neuralModal.setAttribute('aria-hidden','true');
		editingNodeId = null;
	});

	// initialize
	await init();
})();
