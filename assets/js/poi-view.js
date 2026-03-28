import { app } from '/assets/js/auth.js';
import { getFirestore, doc, getDoc, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
const db = getFirestore(app);
const viewSection = document.getElementById('poiView');
const messageSection = document.getElementById('poiMessage');
const messageText = document.getElementById('pvMessageText');
const designationEl = document.getElementById('pvDesignation');
const titleEl = document.getElementById('pvTitle');
const metaEl = document.getElementById('pvMeta');
const descriptionEl = document.getElementById('pvDescription');
const abilitiesSection = document.getElementById('pvAbilitiesSection');
const abilitiesEl = document.getElementById('pvAbilities');
const activitiesSection = document.getElementById('pvActivitiesSection');
const activitiesEl = document.getElementById('pvActivities');
const notesSection = document.getElementById('pvNotesSection');
const notesEl = document.getElementById('pvNotes');
function showMessage(text){ if(viewSection) viewSection.style.display = 'none'; if(messageSection) messageSection.style.display = 'block'; if(messageText) messageText.textContent = text; }
function showFile(){ if(viewSection) viewSection.style.display = 'block'; if(messageSection) messageSection.style.display = 'none'; }
function escapeHtml(text){ const div = document.createElement('div'); div.textContent = String(text || ''); return div.innerHTML; }
async function findByDesignation(value){ const normalized = String(value || '').trim().toUpperCase(); if(!normalized) return null; const snap = await getDocs(query(collection(db, 'persons-of-interest'), where('designation', '==', normalized))); return snap.empty ? null : snap.docs[0]; }
async function loadPoi(){ const params = new URLSearchParams(window.location.search); const rawId = (params.get('id') || '').trim(); if(!rawId){ showMessage('Missing POI identifier.'); return; } try { let snap = await getDoc(doc(db, 'persons-of-interest', rawId)); if(!snap.exists()){ const byDesignation = await findByDesignation(rawId); if(byDesignation) snap = byDesignation; } if(!snap.exists()){ showMessage('POI file not found.'); return; } const data = snap.data() || {}; designationEl.textContent = data.designation || 'POI'; titleEl.textContent = data.name || 'Unknown Individual'; document.title = `${data.designation ? `${data.designation}: ` : ''}${data.name || 'POI File'} - Site-89`; metaEl.textContent = `${data.priority || 'Unknown'} Priority • ${data.status || 'Unknown'}${data.affiliation ? ` • ${data.affiliation}` : ''}`; descriptionEl.innerHTML = escapeHtml(data.description || 'No description available.'); if(data.abilities){ abilitiesEl.innerHTML = escapeHtml(data.abilities); abilitiesSection.style.display = 'block'; } else { abilitiesSection.style.display = 'none'; } if(data.activities){ activitiesEl.innerHTML = escapeHtml(data.activities); activitiesSection.style.display = 'block'; } else { activitiesSection.style.display = 'none'; } if(data.notes){ notesEl.innerHTML = escapeHtml(data.notes); notesSection.style.display = 'block'; } else { notesSection.style.display = 'none'; } showFile(); } catch(err){ console.error('Failed to load POI file:', err); showMessage(`Failed to load POI file: ${err.message || 'Unknown error'}`); } }
let booted = false; function kickoff(){ if(booted) return; booted = true; loadPoi(); }
document.addEventListener('includesLoaded', kickoff); document.addEventListener('DOMContentLoaded', kickoff);
