import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { 
  getFirestore, 
  doc, 
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const AUTHORIZED_EMAIL = 'jedi21132@gmail.com';

let financeData = {
  monthlyUpkeep: [],
  founderContributions: [],
  totalMonthlyBudget: 0,
  notes: ''
};

/**
 * Initialize editor
 */
async function initializeEditor() {
  const auth = getAuth();
  const db = getFirestore();

  onAuthStateChanged(auth, async (user) => {
    const editorContent = document.getElementById('editorContent');
    const accessDenied = document.getElementById('accessDenied');

    if (!user || user.email !== AUTHORIZED_EMAIL) {
      editorContent.style.display = 'none';
      accessDenied.style.display = 'flex';
      return;
    }

    editorContent.style.display = 'block';
    accessDenied.style.display = 'none';

    // Load finance data
    await loadFinanceData(db);
    renderUI();
  });
}

/**
 * Load finance data from Firestore
 */
async function loadFinanceData(db) {
  try {
    const financeRef = doc(db, 'settings/finance');
    const financeDoc = await getDoc(financeRef);

    if (financeDoc.exists()) {
      financeData = financeDoc.data();
    } else {
      // Initialize with empty data
      financeData = {
        monthlyUpkeep: [
          { month: 'Jan', amount: 150 },
          { month: 'Feb', amount: 155 },
          { month: 'Mar', amount: 160 }
        ],
        founderContributions: [
          { name: 'Founder 1', amount: 100 },
          { name: 'Founder 2', amount: 80 }
        ],
        totalMonthlyBudget: 230,
        notes: ''
      };
    }
  } catch (error) {
    console.error('Error loading finance data:', error);
  }
}

/**
 * Render the UI with current data
 */
function renderUI() {
  renderUpkeepList();
  renderContributionsList();

  document.getElementById('totalBudget').value = financeData.totalMonthlyBudget || 0;
  document.getElementById('financeNotes').value = financeData.notes || '';
}

/**
 * Render monthly upkeep list
 */
function renderUpkeepList() {
  const container = document.getElementById('upkeepList');
  container.innerHTML = financeData.monthlyUpkeep.map((item, idx) => `
    <div class="item-row">
      <input type="text" placeholder="Month (e.g., Jan)" value="${item.month}" 
        onchange="financeData.monthlyUpkeep[${idx}].month = this.value">
      <input type="number" placeholder="Amount ($)" value="${item.amount}" min="0" step="0.01"
        onchange="financeData.monthlyUpkeep[${idx}].amount = parseFloat(this.value)">
      <button onclick="removeUpkeepMonth(${idx})">
        <i class="fa-solid fa-trash"></i> Delete
      </button>
    </div>
  `).join('');
}

/**
 * Render founder contributions list
 */
function renderContributionsList() {
  const container = document.getElementById('contributionsList');
  container.innerHTML = financeData.founderContributions.map((item, idx) => `
    <div class="item-row">
      <input type="text" placeholder="Founder Name" value="${item.name}" 
        onchange="financeData.founderContributions[${idx}].name = this.value">
      <input type="number" placeholder="Amount ($)" value="${item.amount}" min="0" step="0.01"
        onchange="financeData.founderContributions[${idx}].amount = parseFloat(this.value)">
      <button onclick="removeContributor(${idx})">
        <i class="fa-solid fa-trash"></i> Delete
      </button>
    </div>
  `).join('');
}

/**
 * Add a new upkeep month
 */
window.addUpkeepMonth = function() {
  financeData.monthlyUpkeep.push({ month: '', amount: 0 });
  renderUpkeepList();
};

/**
 * Remove an upkeep month
 */
window.removeUpkeepMonth = function(idx) {
  financeData.monthlyUpkeep.splice(idx, 1);
  renderUpkeepList();
};

/**
 * Add a new contributor
 */
window.addContributor = function() {
  financeData.founderContributions.push({ name: '', amount: 0 });
  renderContributionsList();
};

/**
 * Remove a contributor
 */
window.removeContributor = function(idx) {
  financeData.founderContributions.splice(idx, 1);
  renderContributionsList();
};

/**
 * Save finance data to Firestore
 */
window.saveFinanceData = async function() {
  try {
    const db = getFirestore();
    
    // Update budget and notes
    financeData.totalMonthlyBudget = parseFloat(document.getElementById('totalBudget').value) || 0;
    financeData.notes = document.getElementById('financeNotes').value || '';

    const financeRef = doc(db, 'settings/finance');
    await setDoc(financeRef, financeData);

    // Show success message
    const successMsg = document.getElementById('successMessage');
    successMsg.classList.add('show');

    setTimeout(() => {
      successMsg.classList.remove('show');
    }, 3000);
  } catch (error) {
    console.error('Error saving finance data:', error);
    alert('Failed to save data. Please try again.');
  }
};

// Initialize when page loads
document.addEventListener('includesLoaded', initializeEditor);

// Fallback initialization
window.addEventListener('load', () => {
  if (document.getElementById('editorContent').style.display === '') {
    initializeEditor();
  }
});
