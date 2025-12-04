(function(){
	const LS_KEY = 'calendar_events';

	// state
	let viewYear, viewMonth;
	const daysGrid = document.getElementById('daysGrid');
	const monthLabel = document.getElementById('monthLabel');
	const todayLabel = document.getElementById('todayLabel');
	const selectedDayLabel = document.getElementById('selectedDayLabel');
	const eventsListEl = document.getElementById('eventsList');
	const addEventBtn = document.getElementById('addEventBtn');
	const eventModal = document.getElementById('eventModal');
	const eventForm = document.getElementById('eventForm');

	// init
	const now = new Date();
	viewYear = now.getFullYear();
	viewMonth = now.getMonth();

	document.getElementById('prevMonth').addEventListener('click', ()=> changeMonth(-1));
	document.getElementById('nextMonth').addEventListener('click', ()=> changeMonth(1));
	document.getElementById('addEventBtn').addEventListener('click', openAddModal);
	document.getElementById('cancelBtn').addEventListener('click', closeModal);
	eventForm.addEventListener('submit', onSaveEvent);

	updateTodayLabel();
	renderCalendar();

	// helpers: storage
	function loadEvents(){
		try{
			const raw = localStorage.getItem(LS_KEY);
			return raw ? JSON.parse(raw) : [];
		}catch(e){ return []; }
	}
	function saveEvents(arr){
		localStorage.setItem(LS_KEY, JSON.stringify(arr));
	}

	// color determinístico y variantes suaves para background
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

	// calendar rendering con previews estilo Notion (hasta 4 eventos, +N más)
	function renderCalendar(){
		daysGrid.innerHTML = '';
		const first = new Date(viewYear, viewMonth, 1);
		const startDay = first.getDay();
		const daysInMonth = new Date(viewYear, viewMonth+1, 0).getDate();
		const prevMonthDays = startDay;
		const prevLast = new Date(viewYear, viewMonth, 0).getDate();
		const totalCells = Math.ceil((prevMonthDays + daysInMonth)/7)*7;
		const events = loadEvents();

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

			// day number
			const dn = document.createElement('div');
			dn.className = 'day-number';
			dn.textContent = cellDate.getDate();
			cell.appendChild(dn);

			// events for this day sorted by time (empty times last)
			const dayEvents = events.filter(ev => ev.date === iso)
				.sort((a,b)=>{
					if (!a.time) return 1;
					if (!b.time) return -1;
					return a.time.localeCompare(b.time);
				});

			if (dayEvents.length) {
				const evContainer = document.createElement('div');
				evContainer.className = 'cell-events';
				// show up to 4
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
					// abrir la vista del día al hacer click en +N
					more.addEventListener('click', (e)=>{
						e.stopPropagation();
						selectDay(iso, cellDate);
					});
					cell.appendChild(more);
				}
			}

			// highlight today
			const today = new Date();
			if (cellDate.toDateString() === today.toDateString()) {
				cell.classList.add('today');
			}

			// click -> select day
			cell.addEventListener('click', ()=> selectDay(iso, cellDate));
			daysGrid.appendChild(cell);
		}

		const mNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
		monthLabel.textContent = `${mNames[viewMonth]} ${viewYear}`;
	}

	function changeMonth(delta){
		viewMonth += delta;
		if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
		if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
		renderCalendar();
	}

	// select day: show events, enable add btn
	let currentSelected = null;
	function selectDay(iso, dateObj){
		currentSelected = iso;
		selectedDayLabel.textContent = `${dateObj.toLocaleDateString()} (${iso})`;
		addEventBtn.disabled = false;
		renderEventsForDay(iso);
	}

	function renderEventsForDay(iso){
		const events = loadEvents().filter(ev => ev.date === iso).sort((a,b)=>{
			if (!a.time) return 1; if (!b.time) return -1;
			return a.time.localeCompare(b.time);
		});
		eventsListEl.innerHTML = '';
		if (events.length === 0) {
			eventsListEl.innerHTML = `<p class="muted">No hay eventos para esta fecha.</p>`;
			return;
		}
		events.forEach(ev=>{
			const el = document.createElement('div');
			el.className = 'event-item';
			el.innerHTML = `<div>
					<div><strong>${escapeHtml(ev.title)}</strong></div>
					<div class="event-meta">${ev.time ? ev.time+' • ' : ''}${escapeHtml(ev.desc || '')}</div>
				</div>
				<div>
					<button class="btn edit" data-id="${ev.id}">Editar</button>
					<button class="btn delete" data-id="${ev.id}">Borrar</button>
				</div>`;
			eventsListEl.appendChild(el);
		});

		// attach handlers
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

	// modal controls
	function openAddModal(){
		if (!currentSelected) return;
		openModal();
		eventForm.id.value = '';
		eventForm.title.value = '';
		eventForm.date.value = currentSelected;
		eventForm.time.value = '';
		eventForm.desc.value = '';
		document.getElementById('modalTitle').textContent = 'Nuevo evento';
	}
	function openEditModal(id){
		const events = loadEvents();
		const ev = events.find(x=>x.id===id);
		if (!ev) return;
		openModal();
		eventForm.id.value = ev.id;
		eventForm.title.value = ev.title;
		eventForm.date.value = ev.date;
		eventForm.time.value = ev.time || '';
		eventForm.desc.value = ev.desc || '';
		document.getElementById('modalTitle').textContent = 'Editar evento';
	}
	function openModal(){ eventModal.classList.remove('hidden'); }
	function closeModal(){ eventModal.classList.add('hidden'); }

	function onSaveEvent(e){
		e.preventDefault();
		const id = eventForm.id.value || generateId();
		const title = eventForm.title.value.trim();
		const date = eventForm.date.value;
		const time = eventForm.time.value;
		const desc = eventForm.desc.value.trim();

		if (!title || !date) return alert('Título y fecha requeridos');

		const events = loadEvents();
		const existing = events.find(x=>x.id===id);
		if (existing){
			existing.title = title; existing.date = date; existing.time = time; existing.desc = desc; existing.updatedAt = new Date().toISOString();
		} else {
			events.push({ id, title, date, time, desc, createdAt: new Date().toISOString() });
		}
		saveEvents(events);
		closeModal();
		// refresh calendar and day view
		renderCalendar();
		if (currentSelected === date) renderEventsForDay(date);
	}

	function deleteEvent(id){
		if (!confirm('Borrar evento?')) return;
		let events = loadEvents();
		events = events.filter(x=>x.id!==id);
		saveEvents(events);
		renderCalendar();
		if (currentSelected) renderEventsForDay(currentSelected);
	}

	function generateId(){ return 'ev_' + Math.random().toString(36).slice(2,9); }

	// small util
	function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

	function updateTodayLabel(){
		const t = new Date();
		todayLabel.textContent = `Hoy: ${t.toLocaleDateString()}`;
	}
})();
