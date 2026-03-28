import { app } from '/assets/js/auth.js';
import { getFirestore, doc, getDoc, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
const db = getFirestore(app);
const viewSection = document.getElementById('goiView');
const messageSection = document.getElementById('goiMessage');
const messageText = document.getElementById('gvMessageText');
const designationEl = document.getElementById('gvDesignation');
const titleEl = document.getElementById('gvTitle');
const metaEl = document.getElementById('gvMeta');
const descriptionEl = document.getElementById('gvDescription');
const activitiesSection = document.getElementById('gvActivitiesSection');
const activitiesEl = document.getElementById('gvActivities');
const capabilitiesSection = document.getElementById('gvCapabilitiesSection');
const capabilitiesEl = document.getElementById('gvCapabilities');
const notesSection = document.getElementById('gvNotesSection');
const notesEl = document.getElementById('gvNotes');
function showMessage(text){ if(viewSection) viewSection.style.display = 'none'; if(messageSection) messageSection.style.display = 'block'; if(messageText) messageText.textContent = text; }
function showFile(){ if(viewSection) viewSection.style.display = 'block'; if(messageSection) messageSection.style.display = 'none'; }
function escapeHtml(text){ const div = document.createElement('div'); div.textContent = String(text || ''); return div.innerHTML; }
async function findByDesignation(value){ const normalized = String(value || '').trim().toUpperCase(); if(!normalized) return null; const snap = await getDocs(query(collection(db, 'groups-of-interest'), where('designation', '==', normalized))); return snap.empty ? null : snap.docs[0]; }
async function loadGoi(){ const params = new URLSearchParams(window.location.search); const rawId = (params.get('id') || '').trim(); if(!rawId){ showMessage('Missing GOI identifier.'); return; } try { let snap = await getDoc(doc(db, 'groups-of-interest', rawId)); if(!snap.exists()){ const byDesignation = await findByDesignation(rawId); if(byDesignation) snap = byDesignation; } if(!snap.exists()){ showMessage('GOI file not found.'); return; } const data = snap.data() || {}; designationEl.textContent = data.designation || 'GOI'; titleEl.textContent = data.name || 'Unknown Group'; document.title = `${data.designation ? `${data.designation}: ` : ''}${data.name || 'GOI File'} - Site-89`; metaEl.textContent = `${data.threatLevel || 'Unknown'} Threat • ${data.stance || 'Unknown'} Stance`; descriptionEl.innerHTML = escapeHtml(data.description || 'No description available.'); if(data.activities){ activitiesEl.innerHTML = escapeHtml(data.activities); activitiesSection.style.display = 'block'; } else { activitiesSection.style.display = 'none'; } if(data.capabilities){ capabilitiesEl.innerHTML = escapeHtml(data.capabilities); capabilitiesSection.style.display = 'block'; } else { capabilitiesSection.style.display = 'none'; } if(data.notes){ notesEl.innerHTML = escapeHtml(data.notes); notesSection.style.display = 'block'; } else { notesSection.style.display = 'none'; } showFile(); } catch(err){ console.error('Failed to load GOI file:', err); showMessage(`Failed to load GOI file: ${err.message || 'Unknown error'}`); } }
let booted = false; function kickoff(){ if(booted) return; booted = true; loadGoi(); }
document.addEventListener('includesLoaded', kickoff); document.addEventListener('DOMContentLoaded', kickoff);
