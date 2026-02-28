import { app, auth, onAuthStateChanged } from '/assets/js/auth.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  getDoc,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const db = getFirestore(app);

const filterButtons = document.querySelectorAll('.filter-btn');
const eventsGrid = document.getElementById('eventsGrid');
const emptyState = document.getElementById('emptyState');
const modal = document.getElementById('eventModal');
const closeModalBtn = document.getElementById('closeModal');
const modalAdmin = document.getElementById('modalAdmin');
const editEventBtn = document.getElementById('editEventBtn');

const modalBanner = document.getElementById('modalBanner');
const modalTitle = document.getElementById('modalTitle');
const modalTimes = document.getElementById('modalTimes');
const modalLong = document.getElementById('modalLong');
const modalIntel = document.getElementById('modalIntel');
const modalAttendees = document.getElementById('modalAttendees');

const rsvpBadge = document.getElementById('rsvpBadge');
const rsvpSelectLink = document.getElementById('rsvpSelectLink');
const rsvpLoginLink = document.getElementById('rsvpLoginLink');

const adminActions = document.getElementById('adminActions');
const addEventBtn = document.getElementById('addEventBtn');
const editorModal = document.getElementById('eventEditorModal');
const closeEditorBtn = document.getElementById('closeEditor');
const cancelEventBtn = document.getElementById('cancelEventBtn');
const saveEventBtn = document.getElementById('saveEventBtn');
const deleteEventBtn = document.getElementById('deleteEventBtn');
const editorTitle = document.getElementById('editorTitle');
const editorStatus = document.getElementById('editorStatus');

const eventTitleInput = document.getElementById('eventTitle');
const eventStartInput = document.getElementById('eventStart');
const eventShortInput = document.getElementById('eventShort');
const eventLongInput = document.getElementById('eventLong');
const eventZoneInput = document.getElementById('eventZone');
const eventDepartmentsInput = document.getElementById('eventDepartments');
const eventManagerInput = document.getElementById('eventManager');
const eventBannerInput = document.getElementById('eventBanner');
const eventBannerFileInput = document.getElementById('eventBannerFile');

let activeFilter = 'upcoming';
let selectedEventId = null;
let editingEventId = null;
let currentUser = null;
let canManageEvents = false;
let eventsData = [];
const rsvpMap = new Map();
const rsvpUnsubs = new Map();
let eventsUnsub = null;

function getSelectedCharacter() {
  try {
    return JSON.parse(localStorage.getItem('selectedCharacter'));
  } catch (err) {
    return null;
  }
}

function parseClearance(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return value;
  const match = String(value).match(/\d+/);
  return match ? parseInt(match[0], 10) : NaN;
}

function userCanManageEvents() {
  if (!currentUser) return false;
  const character = getSelectedCharacter();
  if (!character) return false;
  const clearance = parseClearance(character.clearance);
  if (!isNaN(clearance) && clearance >= 4) return true;
  const rank = String(character.rank || '').toLowerCase();
  return rank.includes('director') || rank.includes('asst. director') || rank.includes('assistant director');
}

function updateAdminUI() {
  canManageEvents = userCanManageEvents();
  if (adminActions) adminActions.style.display = canManageEvents ? 'flex' : 'none';
  if (modalAdmin) modalAdmin.style.display = canManageEvents ? 'flex' : 'none';
}

function updateRsvpIdentity() {
  if (!currentUser) {
    rsvpBadge.textContent = 'Login required to RSVP';
    rsvpSelectLink.style.display = 'none';
    rsvpLoginLink.style.display = 'inline-flex';
    return;
  }

  rsvpLoginLink.style.display = 'none';
  const character = getSelectedCharacter();
  if (character && character.name) {
    rsvpBadge.textContent = `RSVP as ${character.name}`;
    rsvpSelectLink.style.display = 'none';
    return;
  }

  rsvpBadge.textContent = 'Select a character to RSVP';
  rsvpSelectLink.style.display = 'inline-flex';
}

function formatDateTime(date, timeZone) {
  const options = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  };
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

function monthWindow(months) {
  const now = new Date();
  const past = new Date(now);
  past.setMonth(past.getMonth() - months);
  return { now, past };
}

function applyFilter(list) {
  const now = new Date();
  if (activeFilter === 'upcoming') {
    return list.filter(event => event.startDate && event.startDate >= now)
      .sort((a, b) => a.startDate - b.startDate);
  }

  if (activeFilter === 'past-3') {
    const window = monthWindow(3);
    return list
      .filter(event => event.startDate && event.startDate < window.now && event.startDate >= window.past)
      .sort((a, b) => b.startDate - a.startDate);
  }

  if (activeFilter === 'past-6') {
    const window = monthWindow(6);
    return list
      .filter(event => event.startDate && event.startDate < window.now && event.startDate >= window.past)
      .sort((a, b) => b.startDate - a.startDate);
  }

  return list.sort((a, b) => (b.startDate || 0) - (a.startDate || 0));
}

function getRsvpCount(eventId) {
  const attendees = rsvpMap.get(eventId) || [];
  return attendees.length;
}

function userHasRsvped(eventId) {
  const character = getSelectedCharacter();
  if (!character || !character.id) return false;
  const attendees = rsvpMap.get(eventId) || [];
  return attendees.some(attendee => attendee.id === character.id);
}

async function toggleRsvp(eventId) {
  if (!currentUser) {
    alert('You must log in to RSVP.');
    window.location.href = '/login/';
    return;
  }

  const character = getSelectedCharacter();
  if (!character || !character.id) {
    alert('You must select a character to RSVP.');
    window.location.href = '/character-select/';
    return;
  }

  try {
    const rsvpRef = doc(db, 'events', eventId, 'rsvps', character.id);
    const snapshot = await getDoc(rsvpRef);

    if (snapshot.exists()) {
      await deleteDoc(rsvpRef);
    } else {
      await setDoc(rsvpRef, {
        characterId: character.id,
        characterName: character.name || 'Unknown',
        createdByUid: currentUser.uid,
        createdByEmail: currentUser.email || '',
        createdAt: serverTimestamp()
      });
    }
    // RSVPs update via onSnapshot listener
  } catch (err) {
    console.error('RSVP error:', err);
    alert(`RSVP failed: ${err.message}`);
  }
}

function renderEvents() {
  const filtered = applyFilter([...eventsData]);
  eventsGrid.innerHTML = '';

  if (!filtered.length) {
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';

  filtered.forEach((event, index) => {
    const eventDate = event.startDate;
    const card = document.createElement('article');
    card.className = 'event-card';
    card.style.animationDelay = `${index * 0.08}s`;

    const rsvpCount = getRsvpCount(event.id);
    const activeRsvp = userHasRsvped(event.id);

    const manageButton = canManageEvents ?
      `<button class="btn-details" data-action="manage" data-id="${event.id}">Manage</button>` : '';

    card.innerHTML = `
      <div class="event-banner">
        <img src="${event.banner}" alt="${event.title}">
      </div>
      <div class="event-body">
        <div>
          <h3 class="event-title">${event.title}</h3>
          <div class="event-times">
            <div class="time-row"><strong>Site Time (ET)</strong> ${eventDate ? formatDateTime(eventDate, 'America/New_York') : 'TBD'}</div>
            <div class="time-row"><strong>Your Local</strong> ${eventDate ? formatDateTime(eventDate) : 'TBD'}</div>
          </div>
        </div>
        <p class="event-desc">${event.shortDesc}</p>
        <div class="event-meta">
          <span class="meta-chip">${event.zone}</span>
          <span class="meta-chip">${event.departments.join(' / ')}</span>
        </div>
        <div class="event-actions">
          <button class="btn-details" data-action="details" data-id="${event.id}">View Intel</button>
          ${manageButton}
          <button class="rsvp-btn ${activeRsvp ? 'active' : ''}" data-action="rsvp" data-id="${event.id}">
            <i class="fa-solid fa-caret-up"></i>
            <span>${rsvpCount}</span>
          </button>
        </div>
      </div>
    `;

    eventsGrid.appendChild(card);
  });
}

function renderModal(eventId) {
  const event = eventsData.find(item => item.id === eventId);
  if (!event) return;

  selectedEventId = eventId;
  const eventDate = event.startDate;
  const attendees = rsvpMap.get(eventId) || [];

  modalBanner.src = event.banner;
  modalBanner.alt = event.title;
  modalTitle.textContent = event.title;
  modalLong.textContent = event.longDesc;

  modalTimes.innerHTML = `
    <div><strong>Site Time (ET)</strong><br>${eventDate ? formatDateTime(eventDate, 'America/New_York') : 'TBD'}</div>
    <div><strong>Your Local</strong><br>${eventDate ? formatDateTime(eventDate) : 'TBD'}</div>
  `;

  modalIntel.innerHTML = `
    <div><strong>Zone</strong><br>${event.zone}</div>
    <div><strong>Departments</strong><br>${event.departments.join(', ')}</div>
    <div><strong>RP Manager</strong><br>${event.manager}</div>
  `;

  if (!attendees.length) {
    modalAttendees.innerHTML = '<span class="attendee-pill">No RSVPs yet</span>';
  } else {
    modalAttendees.innerHTML = attendees.map(attendee => `<a href="/personnel-files/?character=${encodeURIComponent(attendee.id)}" class="attendee-pill" title="View ${attendee.name}'s profile">${attendee.name}</a>`).join('');
  }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
  selectedEventId = null;
}

function resetEditor() {
  editorStatus.textContent = '';
  eventTitleInput.value = '';
  eventStartInput.value = '';
  eventShortInput.value = '';
  eventLongInput.value = '';
  eventZoneInput.value = '';
  eventDepartmentsInput.value = '';
  eventManagerInput.value = '';
  eventBannerInput.value = '';
  if (eventBannerFileInput) eventBannerFileInput.value = '';
}

function openEditor(eventData = null) {
  if (!canManageEvents) return;
  resetEditor();
  editorModal.classList.add('active');
  editorModal.setAttribute('aria-hidden', 'false');

  if (!eventData) {
    editingEventId = null;
    editorTitle.textContent = 'New Event';
    deleteEventBtn.style.display = 'none';
    return;
  }

  editingEventId = eventData.id;
  editorTitle.textContent = 'Edit Event';
  deleteEventBtn.style.display = 'inline-flex';

  eventTitleInput.value = eventData.title || '';
  eventShortInput.value = eventData.shortDesc || '';
  eventLongInput.value = eventData.longDesc || '';
  eventZoneInput.value = eventData.zone || '';
  eventDepartmentsInput.value = (eventData.departments || []).join(', ');
  eventManagerInput.value = eventData.manager || '';
  eventBannerInput.value = eventData.banner || '';
  eventStartInput.value = eventData.startDate ? formatInputDate(eventData.startDate, 'America/New_York') : '';
}

function closeEditor() {
  editorModal.classList.remove('active');
  editorModal.setAttribute('aria-hidden', 'true');
  editingEventId = null;
}

function setEditorStatus(message, isError = false) {
  editorStatus.textContent = message;
  editorStatus.style.color = isError ? '#ff4444' : 'var(--muted)';
  editorStatus.style.fontWeight = isError ? '700' : '400';
  editorStatus.style.fontSize = isError ? '0.95rem' : '0.85rem';
  if (isError) {
    console.error('Editor Error:', message);
  }
}

function collectEditorData() {
  const title = eventTitleInput.value.trim();
  const startRaw = eventStartInput.value.trim();
  const shortDesc = eventShortInput.value.trim();
  const longDesc = eventLongInput.value.trim();
  const zone = eventZoneInput.value.trim();
  const departmentsRaw = eventDepartmentsInput.value.trim();
  const manager = eventManagerInput.value.trim();
  const bannerFile = eventBannerFileInput && eventBannerFileInput.files && eventBannerFileInput.files[0];
  const existingBanner = eventBannerInput.value.trim();

  if (!title || !startRaw || !shortDesc || !longDesc || !zone || !departmentsRaw || !manager) {
    setEditorStatus('Fill in every required field.', true);
    return null;
  }

  // Banner is required for new events, optional for edits if already exists
  if (!editingEventId && !bannerFile) {
    setEditorStatus('Banner image is required.', true);
    return null;
  }

  const departments = departmentsRaw.split(',').map(item => item.trim()).filter(Boolean);
  if (!departments.length) {
    setEditorStatus('Add at least one department.', true);
    return null;
  }

  const startDate = parseEtInput(startRaw);
  if (!startDate || Number.isNaN(startDate.getTime())) {
    setEditorStatus('Invalid date/time.', true);
    return null;
  }

  return {
    title,
    startDate,
    shortDesc,
    longDesc,
    zone,
    departments,
    manager
  };
}

function getTimeZoneOffset(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asUtc - date.getTime()) / 60000;
}

function parseEtInput(value) {
  const [datePart, timePart] = value.split('T');
  if (!datePart || !timePart) return null;
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = getTimeZoneOffset(utcDate, 'America/New_York');
  return new Date(utcDate.getTime() - offset * 60000);
}

function formatInputDate(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

async function saveEvent() {
  if (!canManageEvents || !currentUser) {
    setEditorStatus('You do not have permission to manage events.', true);
    alert('You do not have permission to manage events. You need clearance level 4+ or director rank.');
    return;
  }
  
  const data = collectEditorData();
  if (!data) return;

  // Disable save button to prevent double-clicks
  saveEventBtn.disabled = true;
  const originalBtnText = saveEventBtn.textContent;
  saveEventBtn.textContent = 'Saving...';

  try {
    let bannerUrl = eventBannerInput.value.trim(); // Use existing banner for edits

    // If a new banner file was selected, upload it first
    const bannerFile = eventBannerFileInput && eventBannerFileInput.files && eventBannerFileInput.files[0];
    if (bannerFile) {
      setEditorStatus('Uploading banner...');
      const idToken = await currentUser.getIdToken();
      
      console.log('Uploading banner file:', bannerFile.name, bannerFile.type);
      
      const uploadResponse = await fetch('/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': bannerFile.type || 'application/octet-stream'
        },
        body: bannerFile
      });

      let uploadPayload = null;
      const uploadResponseText = await uploadResponse.text();
      if (uploadResponseText) {
        try {
          uploadPayload = JSON.parse(uploadResponseText);
        } catch (_error) {
          console.error('Failed to parse upload response:', uploadResponseText);
          uploadPayload = null;
        }
      }

      if (!uploadResponse.ok || !uploadPayload || !uploadPayload.url) {
        const fallbackError = uploadResponse.status === 401
          ? 'You must be logged in to upload images.'
          : `Banner upload failed (Status: ${uploadResponse.status})`;
        const errorMsg = (uploadPayload && uploadPayload.error) || fallbackError;
        console.error('Upload error:', errorMsg, uploadPayload);
        throw new Error(errorMsg);
      }

      bannerUrl = uploadPayload.url;
      console.log('Banner uploaded successfully:', bannerUrl);
    }

    // Banner must exist at this point
    if (!bannerUrl) {
      setEditorStatus('Banner is required.', true);
      saveEventBtn.disabled = false;
      saveEventBtn.textContent = originalBtnText;
      return;
    }

    const payload = {
      title: data.title,
      start: Timestamp.fromDate(data.startDate),
      shortDesc: data.shortDesc,
      longDesc: data.longDesc,
      zone: data.zone,
      departments: data.departments,
      manager: data.manager,
      banner: bannerUrl,
      updatedAt: serverTimestamp()
    };

    console.log('Saving event payload:', payload);
    console.log('Edit mode:', editingEventId ? `Editing ${editingEventId}` : 'Creating new');
    console.log('User:', currentUser.uid, currentUser.email);

    if (!editingEventId) {
      const newEventData = {
        ...payload,
        createdAt: serverTimestamp(),
        createdByUid: currentUser.uid,
        createdByEmail: currentUser.email || ''
      };
      console.log('Creating new event with data:', newEventData);
      await addDoc(collection(db, 'events'), newEventData);
      setEditorStatus('Event created successfully!');
      console.log('Event created successfully');
      setTimeout(() => closeEditor(), 1000);
      return;
    }

    console.log('Updating event:', editingEventId);
    await updateDoc(doc(db, 'events', editingEventId), payload);
    setEditorStatus('Event updated successfully!');
    console.log('Event updated successfully');
    setTimeout(() => closeEditor(), 1000);
  } catch (err) {
    console.error('Error saving event:', err);
    console.error('Error code:', err.code);
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    
    let errorMessage = 'Error saving event: ';
    
    // Handle specific Firestore errors
    if (err.code === 'permission-denied') {
      errorMessage += 'Permission denied. You may not have rights to edit this event. Check console for details.';
      console.error('Permission denied. User:', currentUser?.email, 'Editing event:', editingEventId);
      alert('PERMISSION DENIED: You do not have permission to save this event.\n\nYour email: ' + (currentUser?.email || 'unknown') + '\n\nCheck browser console (F12) for more details.');
    } else if (err.code === 'not-found') {
      errorMessage += 'Event not found. It may have been deleted.';
    } else if (err.code === 'unauthenticated') {
      errorMessage += 'You are not logged in. Please refresh and log in again.';
    } else if (err.message) {
      errorMessage += err.message;
    } else {
      errorMessage += 'Unknown error. Check browser console for details.';
    }
    
    setEditorStatus(errorMessage, true);
  } finally {
    saveEventBtn.disabled = false;
    saveEventBtn.textContent = originalBtnText;
  }
}

async function deleteEvent() {
  if (!editingEventId) return;
  if (!confirm('Delete this event? This cannot be undone.')) return;

  try {
    await deleteDoc(doc(db, 'events', editingEventId));
    setEditorStatus('Event deleted.');
    closeEditor();
  } catch (err) {
    console.error('Error deleting event', err);
    setEditorStatus(`Error deleting event: ${err.message}`, true);
  }
}

function syncRsvpSubscriptions(eventIds) {
  const idSet = new Set(eventIds);

  rsvpUnsubs.forEach((unsub, id) => {
    if (!idSet.has(id)) {
      unsub();
      rsvpUnsubs.delete(id);
      rsvpMap.delete(id);
    }
  });

  eventIds.forEach(id => {
    if (rsvpUnsubs.has(id)) return;
    const rsvpQuery = collection(db, 'events', id, 'rsvps');
    const unsub = onSnapshot(rsvpQuery, (snapshot) => {
      const attendees = [];
      snapshot.forEach(docSnap => {
        const data = docSnap.data();
        attendees.push({
          id: data.characterId || docSnap.id,
          name: data.characterName || 'Unknown'
        });
      });
      attendees.sort((a, b) => a.name.localeCompare(b.name));
      rsvpMap.set(id, attendees);
      renderEvents();
      if (selectedEventId === id) renderModal(id);
    });
    rsvpUnsubs.set(id, unsub);
  });
}

function subscribeEvents() {
  if (eventsUnsub) eventsUnsub();
  const eventsQuery = query(collection(db, 'events'), orderBy('start', 'asc'));
  eventsUnsub = onSnapshot(eventsQuery, (snapshot) => {
    eventsData = snapshot.docs.map(docSnap => {
      const data = docSnap.data();
      const startDate = data.start?.toDate ? data.start.toDate() : (data.start ? new Date(data.start) : null);
      return {
        id: docSnap.id,
        title: data.title || 'Untitled Event',
        startDate,
        shortDesc: data.shortDesc || '',
        longDesc: data.longDesc || '',
        zone: data.zone || 'TBD',
        departments: Array.isArray(data.departments) ? data.departments : [],
        manager: data.manager || 'TBD',
        banner: data.banner || '/assets/img/dataunavailable.png'
      };
    });

    syncRsvpSubscriptions(eventsData.map(event => event.id));
    renderEvents();
  });
}

filterButtons.forEach(button => {
  button.addEventListener('click', () => {
    filterButtons.forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');
    activeFilter = button.dataset.filter;
    renderEvents();
  });
});

eventsGrid.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) return;

  const action = target.dataset.action;
  const eventId = target.dataset.id;

  if (action === 'details') renderModal(eventId);
  if (action === 'rsvp') toggleRsvp(eventId);
  if (action === 'manage') {
    const data = eventsData.find(item => item.id === eventId);
    if (data) openEditor(data);
  }
});

modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal();
});

closeModalBtn.addEventListener('click', closeModal);

if (addEventBtn) addEventBtn.addEventListener('click', () => openEditor());
if (closeEditorBtn) closeEditorBtn.addEventListener('click', closeEditor);
if (cancelEventBtn) cancelEventBtn.addEventListener('click', closeEditor);
if (saveEventBtn) saveEventBtn.addEventListener('click', saveEvent);
if (deleteEventBtn) deleteEventBtn.addEventListener('click', deleteEvent);
if (editEventBtn) editEventBtn.addEventListener('click', () => {
  const data = eventsData.find(item => item.id === selectedEventId);
  if (data) {
    closeModal();
    openEditor(data);
  }
});

editorModal.addEventListener('click', (event) => {
  if (event.target === editorModal) closeEditor();
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  updateRsvpIdentity();
  updateAdminUI();
});

updateRsvpIdentity();
updateAdminUI();
subscribeEvents();
