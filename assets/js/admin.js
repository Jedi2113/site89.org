import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, getDocs, getDoc, deleteDoc, updateDoc, query, where } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { meritSlotBonus } from "/assets/js/merit.js";

const ADMIN_EMAIL = 'jedi21132@gmail.com';

/**
 * Helper: Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

document.addEventListener('includesLoaded', () => {
  const auth = getAuth();
  const db = getFirestore();

  onAuthStateChanged(auth, async (user) => {
    if (!user || user.email !== ADMIN_EMAIL) {
      // redirect non-admins
      window.location.replace('/403/');
      return;
    }
    
    // Admin email verified - grant access
    console.log('Admin access granted for', user.email);

    // wired
    const pid = document.getElementById('pid');
    const pidName = document.getElementById('pidName');
    const pidClass = document.getElementById('pidClass');
    const pidClearance = document.getElementById('pidClearance');
    const pidDepartment = document.getElementById('pidDepartment');
    const pidRank = document.getElementById('pidRank');
    const pidSave = document.getElementById('pidSave');
    const pidDelete = document.getElementById('pidDelete');
    const pidFeedback = document.getElementById('pidFeedback');
    const personnelList = document.getElementById('personnelList');
    const accountsList = document.getElementById('accountsList');
    const charactersList = document.getElementById('charactersList');
    const charSearchInput = document.getElementById('charSearchInput');

    async function loadPersonnel() {
      const snaps = await getDocs(collection(db,'personnel'));
      const arr = [];
      snaps.forEach(s => arr.push({ id: s.id, ...s.data() }));
      arr.sort((a,b)=> a.id.localeCompare(b.id));
      personnelList.innerHTML = '';
      arr.forEach(p => {
        const el = document.createElement('div');
        el.style.padding = '.6rem';
        el.style.borderBottom = '1px solid rgba(255,255,255,0.02)';
        
        // Use textContent and safe DOM methods instead of innerHTML
        const strongEl = document.createElement('strong');
        strongEl.textContent = p.id;
        
        const textNode = document.createTextNode(` — ${p.name} `);
        
        const smallEl = document.createElement('small');
        smallEl.style.opacity = '.8';
        smallEl.textContent = `clear:${p.clearance} dept:${p.department} rank:${p.rank}`;
        
        const btn = document.createElement('button');
        btn.className = 'pid-edit';
        btn.dataset.pid = p.id;
        btn.style.marginLeft = '.6rem';
        btn.textContent = 'Edit';
        
        el.appendChild(strongEl);
        el.appendChild(textNode);
        el.appendChild(smallEl);
        const spacer = document.createTextNode(' ');
        el.appendChild(spacer);
        el.appendChild(btn);
        personnelList.appendChild(el);
      });

      // wire edit buttons
      Array.from(document.querySelectorAll('.pid-edit')).forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = btn.dataset.pid;
          const s = await getDoc(doc(db,'personnel',id));
          if (!s.exists()) return;
          const data = s.data();
          pid.value = id;
          pidName.value = data.name || '';
          pidClass.value = data['class'] || '';
          pidClearance.value = data.clearance || '';
          pidDepartment.value = data.department || '';
          pidRank.value = data.rank || '';
        });
      });
    }

    pidSave.addEventListener('click', async () => {
      const id = (pid.value || '').trim();
      if (!id) return pidFeedback.textContent = 'Enter a Personnel ID.';
      try {
        await setDoc(doc(db,'personnel',id), {
          name: (pidName.value || '').trim(),
          class: (pidClass.value || '').trim(),
          clearance: parseInt(pidClearance.value || '0',10) || 0,
          department: (pidDepartment.value || '').trim(),
          rank: (pidRank.value || '').trim()
        });
        pidFeedback.style.color = 'var(--accent-mint)';
        pidFeedback.textContent = 'Saved.';
        loadPersonnel();
      } catch (err) {
        pidFeedback.style.color = 'var(--accent-red)';
        pidFeedback.textContent = 'Error: ' + err.message;
      }
    });

    pidDelete.addEventListener('click', async () => {
      const id = (pid.value || '').trim();
      if (!id) return pidFeedback.textContent = 'Enter a Personnel ID to delete.';
      try {
        await deleteDoc(doc(db,'personnel',id));
        pidFeedback.style.color = 'var(--accent-mint)';
        pidFeedback.textContent = 'Deleted.';
        pid.value = ''; pidName.value = ''; pidClass.value = ''; pidClearance.value = ''; pidDepartment.value = ''; pidRank.value = '';
        loadPersonnel();
      } catch (err) {
        pidFeedback.style.color = 'var(--accent-red)';
        pidFeedback.textContent = 'Error: ' + err.message;
      }
    });

    async function loadAccounts(){
      const snaps = await getDocs(collection(db,'users'));
      accountsList.innerHTML = '';
      const accounts = [];
      snaps.forEach(s => accounts.push({ id: s.id, ...s.data() }));
      accounts.sort((a, b) => (a.email || a.id).localeCompare(b.email || b.id));

      accounts.forEach(data => {
        const el = document.createElement('div');
        el.style.cssText = 'padding:0.85rem;border-bottom:1px solid rgba(255,255,255,0.06);display:grid;gap:0.65rem;';

        const merit = Number(data.merit || 0);
        const isStaff = !!(data.isStaff || data.isAdmin);
        const patronSlots = Number(data.patreonSlots || 0);
        const baseSlots = isStaff ? 6 : 2;
        const meritSlots = meritSlotBonus(merit);
        const totalSlots = baseSlots + meritSlots + patronSlots;

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;flex-wrap:wrap;';

        const identity = document.createElement('div');
        identity.innerHTML = `
          <strong>${escapeHtml(data.email || data.id)}</strong>
          <div style="font-size:0.82rem;color:var(--muted);margin-top:0.2rem;">UID: ${escapeHtml(data.id)}</div>
        `;

        const summary = document.createElement('div');
        summary.style.cssText = 'font-size:0.82rem;color:var(--muted);text-align:right;';
        summary.innerHTML = `
          Merit: <strong style="color:var(--text-light);">${merit.toLocaleString()}</strong><br>
          Slots: <strong style="color:var(--accent-mint);">${totalSlots}</strong>
          <span>(${baseSlots} base + ${meritSlots} merit + ${patronSlots} patron)</span>
        `;

        header.appendChild(identity);
        header.appendChild(summary);

        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;gap:1rem;flex-wrap:wrap;align-items:end;';

        const staffWrap = document.createElement('label');
        staffWrap.style.cssText = 'display:grid;gap:0.35rem;font-size:0.84rem;';
        staffWrap.textContent = 'Staff slots';
        const staffCheckbox = document.createElement('input');
        staffCheckbox.type = 'checkbox';
        staffCheckbox.checked = !!data.isStaff;
        staffCheckbox.disabled = !!data.isAdmin;
        staffWrap.appendChild(staffCheckbox);

        const patronWrap = document.createElement('label');
        patronWrap.style.cssText = 'display:grid;gap:0.35rem;font-size:0.84rem;';
        patronWrap.textContent = 'Patreon bonus slots';
        const patronInput = document.createElement('input');
        patronInput.type = 'number';
        patronInput.min = '0';
        patronInput.step = '1';
        patronInput.value = String(patronSlots);
        patronInput.style.cssText = 'width:120px;padding:0.5rem;background:var(--bg-card);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:var(--text-light);';
        patronWrap.appendChild(patronInput);

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn-primary';
        saveBtn.textContent = 'Save Slots';

        const feedback = document.createElement('span');
        feedback.style.cssText = 'font-size:0.82rem;color:var(--muted);min-width:120px;';

        saveBtn.addEventListener('click', async () => {
          const nextPatronSlots = Math.max(0, parseInt(patronInput.value || '0', 10) || 0);
          saveBtn.disabled = true;
          feedback.style.color = 'var(--muted)';
          feedback.textContent = 'Saving...';

          try {
            await setDoc(doc(db, 'users', data.id), {
              isStaff: !!staffCheckbox.checked,
              patreonSlots: nextPatronSlots
            }, { merge: true });
            feedback.style.color = 'var(--accent-mint)';
            feedback.textContent = 'Saved';
            loadAccounts();
          } catch (err) {
            feedback.style.color = 'var(--accent-red)';
            feedback.textContent = err.message || 'Save failed';
          } finally {
            saveBtn.disabled = false;
          }
        });

        controls.appendChild(staffWrap);
        controls.appendChild(patronWrap);
        controls.appendChild(saveBtn);
        controls.appendChild(feedback);

        el.appendChild(header);
        el.appendChild(controls);
        accountsList.appendChild(el);
      });
    }

    // Load and display all characters with their account links
    async function loadCharacters() {
      try {
        const snaps = await getDocs(collection(db, 'characters'));
        const characters = [];
        snaps.forEach(s => {
          characters.push({ id: s.id, ...s.data() });
        });
        
        // Sort by name
        characters.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        
        displayCharacters(characters);
      } catch (err) {
        console.error("Error loading characters:", err);
        charactersList.innerHTML = `<div style="color:var(--accent-red)">Error loading characters</div>`;
      }
    }

    function displayCharacters(characters) {
      charactersList.innerHTML = '';
      if (characters.length === 0) {
        charactersList.innerHTML = '<div>No characters found.</div>';
        return;
      }

      characters.forEach(char => {
        const el = document.createElement('div');
        el.style.cssText = 'padding:0.8rem;border-bottom:1px solid rgba(255,255,255,0.02);display:flex;justify-content:space-between;align-items:center;gap:1rem;';
        
        const linkedUID = char.linkedUID || 'Not linked';
        const displayUID = linkedUID === 'Not linked' ? linkedUID : linkedUID.substring(0, 12) + '...';
        
        // Create left container with safe text
        const leftDiv = document.createElement('div');
        leftDiv.style.flex = '1';
        
        const nameStrong = document.createElement('strong');
        nameStrong.textContent = char.name || 'Unknown';
        leftDiv.appendChild(nameStrong);
        
        const smallEl = document.createElement('small');
        smallEl.style.cssText = 'opacity:0.8;display:block;margin-top:0.2rem;';
        smallEl.textContent = `ID: ${char.id.substring(0, 8)}... | Linked: ${displayUID} | Dept: ${char.department || 'N/A'}`;
        leftDiv.appendChild(smallEl);
        
        // Create unlink button
        const btn = document.createElement('button');
        btn.className = 'char-unlink-btn';
        btn.dataset.charId = char.id;
        btn.dataset.charName = char.name || 'Unknown';
        btn.style.cssText = 'padding:0.4rem 0.8rem;background:var(--accent-red);border:none;border-radius:4px;color:white;cursor:pointer;font-size:0.85rem;';
        btn.textContent = 'Unlink';
        
        el.appendChild(leftDiv);
        el.appendChild(btn);
        charactersList.appendChild(el);
      });

      // Wire up unlink buttons
      document.querySelectorAll('.char-unlink-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const charId = btn.dataset.charId;
          const charName = btn.dataset.charName;
          
          if (!confirm(`Unlink character "${charName}" from its account? This will allow it to be linked to another account.`)) {
            return;
          }

          try {
            await updateDoc(doc(db, 'characters', charId), {
              linkedUID: null
            });
            alert(`Character "${charName}" has been unlinked.`);
            loadCharacters();
          } catch (err) {
            alert(`Error unlinking character: ${err.message}`);
          }
        });
      });
    }

    // Search/filter characters
    charSearchInput?.addEventListener('input', async () => {
      const searchTerm = charSearchInput.value.toLowerCase().trim();
      
      try {
        const snaps = await getDocs(collection(db, 'characters'));
        let characters = [];
        snaps.forEach(s => {
          characters.push({ id: s.id, ...s.data() });
        });

        if (searchTerm) {
          characters = characters.filter(char => 
            (char.name || '').toLowerCase().includes(searchTerm) ||
            (char.linkedUID || '').toLowerCase().includes(searchTerm)
          );
        }

        // Sort by name
        characters.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        displayCharacters(characters);
      } catch (err) {
        console.error("Error searching characters:", err);
      }
    });

    // initial load
    loadPersonnel();
    loadAccounts();
    loadCharacters();
  });
});