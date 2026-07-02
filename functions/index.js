const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const crypto = require('crypto');

admin.initializeApp();

const db = admin.firestore();
const PRIMARY_ADMIN_EMAIL = 'jedi21132@gmail.com';
const EMAIL_PURGE_BATCH_SIZE = 400;
const SUPPRESSED_BANK_EMAIL_TX_TYPES = new Set(['late_fee_assessed', 'overdraft_fee_assessed']);

function normalizeMailboxAddress(value) {
  return String(value || '').trim().toLowerCase();
}

async function assertEmailPurgeAdmin(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const callerEmail = normalizeMailboxAddress(request.auth.token && request.auth.token.email);
  if (callerEmail === PRIMARY_ADMIN_EMAIL) {
    return;
  }

  const userDoc = await db.collection('users').doc(request.auth.uid).get();
  if (userDoc.exists && userDoc.data() && userDoc.data().isAdmin === true) {
    return;
  }

  throw new HttpsError('permission-denied', 'Admin access required.');
}

// Fallback webhook URLs (move to Firestore or environment variables for production)
const FALLBACK_EVENTS_WEBHOOK = 'https://discord.com/api/webhooks/1479885470216356098/xD9Et7LyKEqqaq3S8ESNIyUa3wqnqXvtS7Z-ulfvgcewkcKOn5Qn4yg4DdxRLfyPN3EN';
const FALLBACK_LOOKING_FOR_RP_ROLE = '1364330844528836679';
const FALLBACK_DEPARTMENT_ROLES = {
  AD: '1235374061396295701',
  TSD: '1235366964415959093',
  ScD: '1235366965413941378',
  SD: '1235366963690078359',
  IA: '1235374061291307119'
};

function formatCurrency(value) {
  const num = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function getTimePartsInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const map = new Map(parts.map(part => [part.type, part.value]));
  return {
    year: Number(map.get('year') || 0),
    month: Number(map.get('month') || 1),
    day: Number(map.get('day') || 1),
    hour: Number(map.get('hour') || 0),
    minute: Number(map.get('minute') || 0)
  };
}

function parseIsoDateParts(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function toUtcDateMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getMonthKey(parts) {
  const month = String(parts.month).padStart(2, '0');
  return `${parts.year}-${month}`;
}

function isNowAtOrAfterTime(nowParts, hour, minute) {
  if (nowParts.hour > hour) return true;
  if (nowParts.hour < hour) return false;
  return nowParts.minute >= minute;
}

function getPayrollRunDateKey(nowParts, payrollConfig) {
  if (!payrollConfig || payrollConfig.enabled === false) return null;

  const cfgHour = Number(payrollConfig.hour || 0);
  const cfgMinute = Number(payrollConfig.minute || 0);
  if (!isNowAtOrAfterTime(nowParts, cfgHour, cfgMinute)) return null;

  const anchorParts = parseIsoDateParts(payrollConfig.anchorDate);
  if (!anchorParts) return null;

  const anchorMs = toUtcDateMs(anchorParts);
  const nowDateMs = toUtcDateMs(nowParts);
  if (nowDateMs < anchorMs) return null;

  const diffDays = Math.floor((nowDateMs - anchorMs) / (24 * 60 * 60 * 1000));
  const cycleIndex = Math.floor(diffDays / 14);
  const cycleStartMs = anchorMs + (cycleIndex * 14 * 24 * 60 * 60 * 1000);
  const cycleStartDate = new Date(cycleStartMs);
  const month = String(cycleStartDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(cycleStartDate.getUTCDate()).padStart(2, '0');
  return `${cycleStartDate.getUTCFullYear()}-${month}-${day}`;
}

function shouldRunMonthlyNow(nowParts, monthlyConfig) {
  if (!monthlyConfig || monthlyConfig.enabled === false) return false;

  const cfgHour = Number(monthlyConfig.hour || 0);
  const cfgMinute = Number(monthlyConfig.minute || 0);
  if (!isNowAtOrAfterTime(nowParts, cfgHour, cfgMinute)) return false;

  const anchorParts = parseIsoDateParts(monthlyConfig.anchorDate);
  if (anchorParts) {
    const anchorMs = toUtcDateMs(anchorParts);
    const nowDateMs = toUtcDateMs(nowParts);
    if (nowDateMs < anchorMs) return false;

    const safeAnchorDay = Math.max(1, Math.min(31, Math.trunc(anchorParts.day)));
    const dueAnchorDay = Math.min(safeAnchorDay, getDaysInMonth(nowParts.year, nowParts.month));
    return nowParts.day >= dueAnchorDay;
  }

  // Backward compatibility for old configs that only saved a numeric day.
  const configuredDay = Number(monthlyConfig.dayOfMonth || 1);
  const safeDay = Math.max(1, Math.min(31, Math.trunc(configuredDay)));
  const dueDay = Math.min(safeDay, getDaysInMonth(nowParts.year, nowParts.month));
  return nowParts.day >= dueDay;
}

const SITE_FINANCE_ACCOUNT_DEFINITIONS = {
  site_total: {
    id: 'site_total',
    name: 'Site Total Fund',
    category: 'site',
    department: 'SITE'
  },
  reserve: {
    id: 'reserve',
    name: 'Reserve Fund',
    category: 'site',
    department: 'RESERVE'
  },
  dept_ad: {
    id: 'dept_ad',
    name: 'Administrative Department',
    category: 'department',
    department: 'AD'
  },
  dept_ia: {
    id: 'dept_ia',
    name: 'Internal Affairs',
    category: 'department',
    department: 'IA'
  },
  dept_tsd: {
    id: 'dept_tsd',
    name: 'Technical Services Department',
    category: 'department',
    department: 'TSD'
  },
  dept_sd: {
    id: 'dept_sd',
    name: 'Security Department',
    category: 'department',
    department: 'SD'
  },
  dept_scd: {
    id: 'dept_scd',
    name: 'Scientific Department',
    category: 'department',
    department: 'ScD'
  }
};

const SITE_FINANCE_DEPARTMENTS = [
  { code: 'AD', accountId: 'dept_ad' },
  { code: 'IA', accountId: 'dept_ia' },
  { code: 'TSD', accountId: 'dept_tsd' },
  { code: 'SD', accountId: 'dept_sd' },
  { code: 'ScD', accountId: 'dept_scd' }
];

function roundToCents(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function clampNumber(value, min, max) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function getAccountBalances(account = {}) {
  const checking = roundToCents(Number(account.checkingBalance ?? account.balance ?? 0));
  const savings = roundToCents(Number(account.savingsBalance ?? 0));
  return {
    checking,
    savings,
    total: roundToCents(checking + savings)
  };
}

function normalizeBankPid(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function getCanonicalBankAccountPid(docId, account = {}) {
  return normalizeBankPid(account.pid) || normalizeBankPid(docId);
}

function pickCanonicalAccountDocs(snapshot) {
  const byPid = new Map();
  snapshot.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const canonicalPid = getCanonicalBankAccountPid(docSnap.id, data);
    if (!canonicalPid) return;

    const current = byPid.get(canonicalPid);
    if (!current) {
      byPid.set(canonicalPid, docSnap);
      return;
    }

    // Prefer the canonical PID document when duplicate/legacy docs exist.
    if (docSnap.id === canonicalPid && current.id !== canonicalPid) {
      byPid.set(canonicalPid, docSnap);
    }
  });
  return byPid;
}

function debitFromCheckingThenSavings(checkingInput, savingsInput, amountInput) {
  let checking = roundToCents(checkingInput);
  let savings = roundToCents(savingsInput);
  let remaining = roundToCents(amountInput);
  let paid = 0;

  if (remaining <= 0) {
    return { checking, savings, paid: 0 };
  }

  if (checking > 0) {
    const useFromChecking = Math.min(checking, remaining);
    checking = roundToCents(checking - useFromChecking);
    remaining = roundToCents(remaining - useFromChecking);
    paid = roundToCents(paid + useFromChecking);
  }

  if (remaining > 0 && savings > 0) {
    const useFromSavings = Math.min(savings, remaining);
    savings = roundToCents(savings - useFromSavings);
    remaining = roundToCents(remaining - useFromSavings);
    paid = roundToCents(paid + useFromSavings);
  }

  return {
    checking,
    savings,
    paid
  };
}

function getConfiguredDeductions(account = {}) {
  if (Array.isArray(account.deductions) && account.deductions.length) return account.deductions;
  if (Array.isArray(account.monthlyDeductions)) return account.monthlyDeductions;
  return [];
}

function normalizeCreditProfile(rawProfile = {}) {
  return {
    monthsEvaluated: Math.max(0, Number(rawProfile.monthsEvaluated || 0)),
    onTimeMonths: Math.max(0, Number(rawProfile.onTimeMonths || 0)),
    lateMonths: Math.max(0, Number(rawProfile.lateMonths || 0)),
    overdraftEvents: Math.max(0, Number(rawProfile.overdraftEvents || 0)),
    consecutiveOnTimeMonths: Math.max(0, Number(rawProfile.consecutiveOnTimeMonths || 0)),
    consecutiveLateMonths: Math.max(0, Number(rawProfile.consecutiveLateMonths || 0)),
    lastEvaluatedMonthKey: String(rawProfile.lastEvaluatedMonthKey || ''),
    lastMonthlyDueTotal: roundToCents(rawProfile.lastMonthlyDueTotal || 0),
    lastMonthlyPaidAmount: roundToCents(rawProfile.lastMonthlyPaidAmount || 0),
    lastLateFeeAmount: roundToCents(rawProfile.lastLateFeeAmount || 0),
    lastOverdraftFeeAmount: roundToCents(rawProfile.lastOverdraftFeeAmount || 0),
    lastLateFeeMonthKey: String(rawProfile.lastLateFeeMonthKey || ''),
    lastOverdraftFeeMonthKey: String(rawProfile.lastOverdraftFeeMonthKey || ''),
    outstandingBalance: roundToCents(rawProfile.outstandingBalance || 0)
  };
}

function getAccountAgeMonths(createdAt) {
  if (!createdAt || typeof createdAt.toDate !== 'function') return 0;
  const created = createdAt.toDate();
  if (!(created instanceof Date) || Number.isNaN(created.getTime())) return 0;
  const now = new Date();
  let months = (now.getUTCFullYear() - created.getUTCFullYear()) * 12;
  months += now.getUTCMonth() - created.getUTCMonth();
  if (now.getUTCDate() < created.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function computeCreditScore({ account = {}, creditProfile = {}, deductionsDueMonthly = 0, outstandingBalance = 0 }) {
  const safeProfile = normalizeCreditProfile(creditProfile);
  const accountAgeMonths = getAccountAgeMonths(account.createdAt);
  const recurringIncome = roundToCents(Number(account?.recurring?.amount || 0));
  const balances = getAccountBalances(account);

  const baseScore = 620;
  const ageFactor = Math.min(60, accountAgeMonths * 1.5);

  const paymentMonths = Math.max(1, safeProfile.monthsEvaluated);
  const onTimeRatio = safeProfile.onTimeMonths / paymentMonths;
  const paymentHistoryFactor = Math.round((onTimeRatio - 0.5) * 240);
  const latePenalty = Math.min(220, safeProfile.lateMonths * 12 + safeProfile.consecutiveLateMonths * 10);
  const streakBonus = Math.min(45, safeProfile.consecutiveOnTimeMonths * 3);

  const burdenRatio = recurringIncome > 0 ? deductionsDueMonthly / recurringIncome : (deductionsDueMonthly > 0 ? 2 : 0);
  let utilizationFactor = 0;
  if (burdenRatio <= 0.2) utilizationFactor = 45;
  else if (burdenRatio <= 0.35) utilizationFactor = 25;
  else if (burdenRatio <= 0.5) utilizationFactor = 5;
  else if (burdenRatio <= 0.75) utilizationFactor = -35;
  else utilizationFactor = -70;

  const liquidBufferRatio = deductionsDueMonthly > 0 ? balances.total / deductionsDueMonthly : 2;
  const bufferFactor = clampNumber((liquidBufferRatio - 1) * 20, -40, 40);
  const outstandingPenalty = Math.min(170, Math.floor(outstandingBalance / 20));
  const overdraftPenalty = Math.min(140, safeProfile.overdraftEvents * 10);

  const rawScore = baseScore
    + ageFactor
    + paymentHistoryFactor
    + streakBonus
    + utilizationFactor
    + bufferFactor
    - latePenalty
    - outstandingPenalty
    - overdraftPenalty;

  const score = Math.round(clampNumber(rawScore, 300, 850));

  return {
    score,
    factors: {
      paymentHistory: Math.round(paymentHistoryFactor - latePenalty),
      utilization: Math.round(utilizationFactor),
      accountAge: Math.round(ageFactor),
      liquidity: Math.round(bufferFactor),
      overdraft: Math.round(-overdraftPenalty),
      outstandingDebt: Math.round(-outstandingPenalty),
      onTimeRatio: roundToCents(onTimeRatio),
      recurringIncome,
      deductionsDueMonthly: roundToCents(deductionsDueMonthly),
      accountAgeMonths,
      outstandingBalance: roundToCents(outstandingBalance)
    }
  };
}

function normalizeFinanceAllocations(rawAllocations = {}) {
  const normalized = {};
  SITE_FINANCE_DEPARTMENTS.forEach(({ code }) => {
    const value = Number(rawAllocations?.[code] || 0);
    normalized[code] = Number.isFinite(value) && value > 0 ? Math.min(100, value) : 0;
  });
  return normalized;
}

function normalizeSiteFinanceSettings(raw = {}) {
  return {
    foundationMonthlyDeposit: roundToCents(raw.foundationMonthlyDeposit || 0),
    autoAllocateEnabled: raw.autoAllocateEnabled === true,
    allocations: normalizeFinanceAllocations(raw.allocations || {}),
    lastFoundationDepositMonthKey: String(raw.lastFoundationDepositMonthKey || '')
  };
}

function computeAllocationRows(baseAmount, allocations) {
  const normalizedBase = roundToCents(baseAmount);
  if (!normalizedBase || normalizedBase <= 0) {
    return { rows: [], totalAllocated: 0 };
  }

  const percentageRows = SITE_FINANCE_DEPARTMENTS
    .map(({ code, accountId }) => ({ code, accountId, percent: Number(allocations?.[code] || 0) }))
    .filter(row => row.percent > 0);

  if (!percentageRows.length) {
    return { rows: [], totalAllocated: 0 };
  }

  const totalPct = percentageRows.reduce((sum, row) => sum + row.percent, 0);
  const cappedPct = Math.min(totalPct, 100);
  if (cappedPct <= 0) {
    return { rows: [], totalAllocated: 0 };
  }

  const allocatableCents = Math.round((normalizedBase * cappedPct / 100) * 100);
  if (allocatableCents <= 0) {
    return { rows: [], totalAllocated: 0 };
  }

  const rawRows = percentageRows.map(row => {
    const fraction = row.percent / totalPct;
    const rawCents = allocatableCents * fraction;
    return {
      ...row,
      rawCents,
      cents: Math.floor(rawCents)
    };
  });

  let remaining = allocatableCents - rawRows.reduce((sum, row) => sum + row.cents, 0);
  if (remaining > 0) {
    rawRows
      .sort((a, b) => (b.rawCents - b.cents) - (a.rawCents - a.cents))
      .forEach((row) => {
        if (remaining <= 0) return;
        row.cents += 1;
        remaining -= 1;
      });
  }

  const rows = rawRows
    .filter(row => row.cents > 0)
    .map(row => ({
      code: row.code,
      accountId: row.accountId,
      amount: roundToCents(row.cents / 100)
    }));

  const totalAllocated = roundToCents(rows.reduce((sum, row) => sum + row.amount, 0));
  return { rows, totalAllocated };
}

function getSiteFinanceAccountRef(accountId) {
  return db.collection('site_finance_accounts').doc(accountId);
}

function siteFinanceAccountPayload(accountId, balance = 0) {
  const def = SITE_FINANCE_ACCOUNT_DEFINITIONS[accountId];
  if (!def) {
    return { id: accountId, name: accountId, balance: roundToCents(balance) };
  }

  return {
    id: def.id,
    name: def.name,
    category: def.category,
    department: def.department,
    balance: roundToCents(balance),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedByUid: 'system'
  };
}

async function applySiteFinanceInflow(options = {}) {
  const amount = roundToCents(options.amount || 0);
  if (!amount || amount <= 0) {
    return { applied: false, reason: 'no-amount' };
  }

  const inflowType = String(options.inflowType || 'system_inflow');
  const note = String(options.note || 'Automated site finance inflow');
  const monthKey = String(options.monthKey || '');
  const timezone = String(options.timezone || 'America/New_York');

  return db.runTransaction(async tx => {
    const settingsRef = db.collection('bank_config').doc('site_finance_settings');
    const settingsSnap = await tx.get(settingsRef);
    const settings = normalizeSiteFinanceSettings(settingsSnap.exists ? settingsSnap.data() : {});

    const siteRef = getSiteFinanceAccountRef('site_total');
    const siteSnap = await tx.get(siteRef);
    const currentSiteBalance = roundToCents(siteSnap.exists ? siteSnap.data()?.balance : 0);
    let siteBalance = roundToCents(currentSiteBalance + amount);

    tx.set(siteRef, siteFinanceAccountPayload('site_total', siteBalance), { merge: true });
    tx.set(siteRef.collection('transactions').doc(), {
      scope: 'site_finance',
      type: inflowType,
      direction: 'credit',
      amount,
      note,
      monthKey,
      timezone,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdByUid: 'system',
      createdByName: 'Finance Scheduler',
      balanceAfter: siteBalance
    });

    let allocatedTotal = 0;
    const allocationBreakdown = [];
    if (settings.autoAllocateEnabled) {
      const allocation = computeAllocationRows(amount, settings.allocations);
      allocatedTotal = allocation.totalAllocated;

      for (const row of allocation.rows) {
        const deptRef = getSiteFinanceAccountRef(row.accountId);
        const deptSnap = await tx.get(deptRef);
        const deptBalance = roundToCents((deptSnap.exists ? deptSnap.data()?.balance : 0) + row.amount);

        tx.set(deptRef, siteFinanceAccountPayload(row.accountId, deptBalance), { merge: true });
        tx.set(deptRef.collection('transactions').doc(), {
          scope: 'site_finance',
          type: 'auto_allocation_in',
          direction: 'credit',
          amount: row.amount,
          note: `Auto-allocation from site inflow (${row.code})`,
          monthKey,
          timezone,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdByUid: 'system',
          createdByName: 'Finance Scheduler',
          balanceAfter: deptBalance
        });

        siteBalance = roundToCents(siteBalance - row.amount);
        allocationBreakdown.push({ code: row.code, amount: row.amount });
      }

      if (allocatedTotal > 0) {
        tx.set(siteRef, siteFinanceAccountPayload('site_total', siteBalance), { merge: true });
        tx.set(siteRef.collection('transactions').doc(), {
          scope: 'site_finance',
          type: 'auto_allocation_out',
          direction: 'debit',
          amount: allocatedTotal,
          note: 'Automatic department budget allocation',
          monthKey,
          timezone,
          breakdown: allocationBreakdown,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdByUid: 'system',
          createdByName: 'Finance Scheduler',
          balanceAfter: siteBalance
        });
      }
    }

    tx.set(settingsRef, {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: 'system'
    }, { merge: true });

    return {
      applied: true,
      inflowAmount: amount,
      allocatedTotal,
      siteBalanceAfter: siteBalance
    };
  });
}

async function applyFoundationDepositForMonth(monthKey, timezone) {
  return db.runTransaction(async tx => {
    const settingsRef = db.collection('bank_config').doc('site_finance_settings');
    const settingsSnap = await tx.get(settingsRef);
    const settings = normalizeSiteFinanceSettings(settingsSnap.exists ? settingsSnap.data() : {});

    const deposit = roundToCents(settings.foundationMonthlyDeposit || 0);
    if (!deposit || deposit <= 0) {
      return { applied: false, reason: 'deposit-disabled' };
    }

    if (String(settings.lastFoundationDepositMonthKey || '') === monthKey) {
      return { applied: false, reason: 'already-applied' };
    }

    const siteRef = getSiteFinanceAccountRef('site_total');
    const siteSnap = await tx.get(siteRef);
    const currentSiteBalance = roundToCents(siteSnap.exists ? siteSnap.data()?.balance : 0);
    let siteBalance = roundToCents(currentSiteBalance + deposit);

    tx.set(siteRef, siteFinanceAccountPayload('site_total', siteBalance), { merge: true });
    tx.set(siteRef.collection('transactions').doc(), {
      scope: 'site_finance',
      type: 'foundation_monthly_deposit',
      direction: 'credit',
      amount: deposit,
      note: 'Monthly Foundation operating deposit',
      monthKey,
      timezone,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdByUid: 'system',
      createdByName: 'Foundation Finance Scheduler',
      balanceAfter: siteBalance
    });

    let allocatedTotal = 0;
    const allocationBreakdown = [];
    if (settings.autoAllocateEnabled) {
      const allocation = computeAllocationRows(deposit, settings.allocations);
      allocatedTotal = allocation.totalAllocated;

      for (const row of allocation.rows) {
        const deptRef = getSiteFinanceAccountRef(row.accountId);
        const deptSnap = await tx.get(deptRef);
        const deptBalance = roundToCents((deptSnap.exists ? deptSnap.data()?.balance : 0) + row.amount);

        tx.set(deptRef, siteFinanceAccountPayload(row.accountId, deptBalance), { merge: true });
        tx.set(deptRef.collection('transactions').doc(), {
          scope: 'site_finance',
          type: 'auto_allocation_in',
          direction: 'credit',
          amount: row.amount,
          note: `Auto-allocation from Foundation deposit (${row.code})`,
          monthKey,
          timezone,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdByUid: 'system',
          createdByName: 'Foundation Finance Scheduler',
          balanceAfter: deptBalance
        });

        siteBalance = roundToCents(siteBalance - row.amount);
        allocationBreakdown.push({ code: row.code, amount: row.amount });
      }

      if (allocatedTotal > 0) {
        tx.set(siteRef, siteFinanceAccountPayload('site_total', siteBalance), { merge: true });
        tx.set(siteRef.collection('transactions').doc(), {
          scope: 'site_finance',
          type: 'auto_allocation_out',
          direction: 'debit',
          amount: allocatedTotal,
          note: 'Automatic department allocation from Foundation deposit',
          monthKey,
          timezone,
          breakdown: allocationBreakdown,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdByUid: 'system',
          createdByName: 'Foundation Finance Scheduler',
          balanceAfter: siteBalance
        });
      }
    }

    tx.set(settingsRef, {
      lastFoundationDepositMonthKey: monthKey,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedByUid: 'system'
    }, { merge: true });

    return {
      applied: true,
      deposit,
      allocatedTotal,
      siteBalanceAfter: siteBalance
    };
  });
}

function baseLocalFromName(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ? parts[0].toLowerCase().replace(/[^a-z]/g, '') : '';
  const last = parts.length > 1 ? parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '') : first;
  return last && first ? `${last}.${first}` : '';
}

function makeUniqueEmail(baseLocal, counts) {
  if (!baseLocal) return '';
  const current = counts.get(baseLocal) || 0;
  const next = current + 1;
  counts.set(baseLocal, next);
  const localPart = next === 1 ? baseLocal : `${baseLocal}${next}`;
  return `${localPart}@site89.org`.toLowerCase();
}

function sortCharsForDeterministicOrder(a, b) {
  const aSec = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
  const bSec = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
  const aNanos = a.createdAt && a.createdAt.nanoseconds ? a.createdAt.nanoseconds : 0;
  const bNanos = b.createdAt && b.createdAt.nanoseconds ? b.createdAt.nanoseconds : 0;
  if (aSec !== bSec) return aSec - bSec;
  if (aNanos !== bNanos) return aNanos - bNanos;

  const aPid = String(a.pid || '');
  const bPid = String(b.pid || '');
  if (aPid !== bPid) return aPid.localeCompare(bPid);

  return String(a.docId || '').localeCompare(String(b.docId || ''));
}

function seedCountsFromStoredEmail(char, counts) {
  const email = String(char.email || '').toLowerCase();
  const baseLocal = baseLocalFromName(char.name);
  if (!email || !baseLocal) return;

  const atIndex = email.indexOf('@');
  if (atIndex === -1) return;

  const localPart = email.substring(0, atIndex);
  const numMatch = localPart.match(/(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    const currentMax = counts.get(baseLocal) || 0;
    counts.set(baseLocal, Math.max(currentMax, num));
    return;
  }

  if (localPart === baseLocal) {
    const currentMax = counts.get(baseLocal) || 0;
    counts.set(baseLocal, Math.max(currentMax, 1));
  }
}

async function backfillMissingCharacterEmails() {
  const snap = await db.collection('characters').get();
  const withEmail = [];
  const withoutEmail = [];

  snap.forEach(docSnap => {
    const data = docSnap.data() || {};
    if (!data.name) return;
    const row = { docId: docSnap.id, ...data };
    if (row.email) withEmail.push(row);
    else withoutEmail.push(row);
  });

  if (!withoutEmail.length) {
    return { updated: 0, scanned: withEmail.length + withoutEmail.length };
  }

  const counts = new Map();
  withEmail.forEach(char => seedCountsFromStoredEmail(char, counts));

  withoutEmail.sort(sortCharsForDeterministicOrder);

  const updates = [];
  withoutEmail.forEach(char => {
    const baseLocal = baseLocalFromName(char.name);
    if (!baseLocal) return;
    const email = makeUniqueEmail(baseLocal, counts);
    updates.push({ docId: char.docId, email });
  });

  let applied = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const update of updates) {
    const ref = db.collection('characters').doc(update.docId);
    batch.set(ref, { email: update.email }, { merge: true });
    batchCount += 1;

    if (batchCount >= 400) {
      await batch.commit();
      applied += batchCount;
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
    applied += batchCount;
  }

  return { updated: applied, scanned: withEmail.length + withoutEmail.length };
}

async function resolveCharacterEmail(account) {
  if (!account || !account.name) return '';
  
  // If character has a stored email, use it
  if (account.email) return account.email.toLowerCase();

  const snap = await db.collection('characters').get();
  
  // Separate characters with existing emails from those without
  const withEmail = [];
  const withoutEmail = [];
  const targetCharId = account.docId || account.id || '';
  
  snap.forEach(docSnap => {
    const data = docSnap.data();
    if (data && data.name) {
      const char = { docId: docSnap.id, ...data };
      if (char.email) {
        withEmail.push(char);
      } else {
        withoutEmail.push(char);
      }
    }
  });

  // Sort characters without emails by creation time (older first)
  withoutEmail.sort((a, b) => {
    const aSec = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
    const bSec = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
    const aNanos = a.createdAt && a.createdAt.nanoseconds ? a.createdAt.nanoseconds : 0;
    const bNanos = b.createdAt && b.createdAt.nanoseconds ? b.createdAt.nanoseconds : 0;
    if (aSec !== bSec) return aSec - bSec;
    if (aNanos !== bNanos) return aNanos - bNanos;

    const aPid = String(a.pid || '');
    const bPid = String(b.pid || '');
    if (aPid !== bPid) return aPid.localeCompare(bPid);

    return String(a.docId || '').localeCompare(String(b.docId || ''));
  });

  // Build counts from existing emails
  const counts = new Map();
  const byPid = new Map();
  const byDocId = new Map();
  const byBase = new Map();

  withEmail.forEach(char => {
    const email = char.email.toLowerCase();
    const baseLocal = baseLocalFromName(char.name);
    
    if (char.pid) byPid.set(String(char.pid), email);
    if (char.docId) byDocId.set(char.docId, email);
    
    if (baseLocal) {
      const match = email.match(/@/);
      if (match) {
        const localPart = email.substring(0, match.index);
        const numMatch = localPart.match(/(\d+)$/);
        if (numMatch) {
          const num = parseInt(numMatch[1], 10);
          const currentMax = counts.get(baseLocal) || 0;
          counts.set(baseLocal, Math.max(currentMax, num));
        } else if (localPart === baseLocal) {
          const currentMax = counts.get(baseLocal) || 0;
          counts.set(baseLocal, Math.max(currentMax, 1));
        }
      }
      
      const list = byBase.get(baseLocal) || [];
      list.push({ email, department: char.department || '' });
      byBase.set(baseLocal, list);
    }
  });

  // Generate emails for characters without them
  withoutEmail.forEach(char => {
    const baseLocal = baseLocalFromName(char.name);
    if (baseLocal) {
      const email = makeUniqueEmail(baseLocal, counts);
      if (char.pid) byPid.set(String(char.pid), email);
      if (char.docId) byDocId.set(char.docId, email);
      
      const list = byBase.get(baseLocal) || [];
      list.push({ email, department: char.department || '' });
      byBase.set(baseLocal, list);
    }
  });

  // Resolve for target character
  const baseLocal = baseLocalFromName(account.name);
  const pidKey = account.pid ? String(account.pid) : '';
  
  if (pidKey && byPid.has(pidKey)) return byPid.get(pidKey);
  if (targetCharId && byDocId.has(targetCharId)) return byDocId.get(targetCharId);

  const bucket = byBase.get(baseLocal);
  if (bucket && bucket.length) {
    if (bucket.length === 1) return bucket[0].email;
    const dept = (account.department || '').toLowerCase();
    const match = bucket.find(entry => (entry.department || '').toLowerCase() === dept);
    return match ? match.email : bucket[0].email;
  }

  const snapshotCount = (counts.get(baseLocal) || 0) + 1;
  const localPart = snapshotCount === 1 ? baseLocal : `${baseLocal}${snapshotCount}`;
  return `${localPart}@site89.org`.toLowerCase();
}

exports.processPayroll = onSchedule({ schedule: 'every minute', timeZone: 'America/New_York' }, async () => {
  console.log('⏱️ processPayroll tick started');
  const scheduleSnap = await db.collection('bank_config').doc('schedule').get();
  const scheduleConfig = scheduleSnap.exists ? (scheduleSnap.data() || {}) : {};

  const timezone = scheduleConfig.timezone || 'America/New_York';
  const nowDate = new Date();
  const nowParts = getTimePartsInZone(nowDate, timezone);
  const monthKey = getMonthKey(nowParts);

  const payrollConfig = scheduleConfig.payroll || {
    enabled: true,
    anchorDate: '2026-01-01',
    hour: 9,
    minute: 0
  };
  const monthlyConfig = scheduleConfig.monthly || {
    enabled: true,
    anchorDate: '2026-01-01',
    hour: 9,
    minute: 0
  };

  const payrollRunKey = getPayrollRunDateKey(nowParts, payrollConfig);
  const payrollDueNow = payrollRunKey !== null;
  const monthlyDueNow = shouldRunMonthlyNow(nowParts, monthlyConfig);

  console.log('📋 Scheduler state', {
    timezone,
    nowParts,
    payrollConfig,
    monthlyConfig,
    payrollRunKey,
    payrollDueNow,
    monthlyDueNow,
    monthKey
  });

  if (!payrollDueNow && !monthlyDueNow) {
    console.log('⏭️ Nothing due this tick');
    return;
  }

  if (payrollDueNow) {
    console.log('💼 Payroll is due now; loading eligible accounts');
    const payrollAccounts = await db
      .collection('bank_accounts')
      .where('recurring.enabled', '==', true)
      .get();

    const payrollAccountsByPid = pickCanonicalAccountDocs(payrollAccounts);

    console.log('💼 Payroll accounts found', {
      count: payrollAccounts.size,
      uniquePidCount: payrollAccountsByPid.size,
      payrollRunKey
    });

    const payrollTasks = [];
    payrollAccountsByPid.forEach((docSnap, canonicalPid) => {
      payrollTasks.push(db.runTransaction(async tx => {
        const sourceRef = docSnap.ref;
        const sourceSnap = await tx.get(sourceRef);
        if (!sourceSnap.exists) return;

        const sourceAccount = sourceSnap.data() || {};
        const targetRef = db.collection('bank_accounts').doc(canonicalPid);
        const targetSnap = targetRef.path === sourceRef.path ? sourceSnap : await tx.get(targetRef);
        const targetAccount = targetSnap.exists ? (targetSnap.data() || {}) : {
          ...sourceAccount,
          pid: canonicalPid
        };

        const sourceRecurring = sourceAccount.recurring || {};
        const targetRecurring = targetAccount.recurring || {};
        const mergedLastPayrollKey = String(targetRecurring.lastPayrollKey || sourceRecurring.lastPayrollKey || '');
        const mergedAmount = Number(sourceRecurring.amount || targetRecurring.amount || 0);
        const recurring = {
          ...targetRecurring,
          ...sourceRecurring,
          amount: mergedAmount,
          lastPayrollKey: mergedLastPayrollKey,
          enabled: sourceRecurring.enabled !== false || targetRecurring.enabled !== false
        };

        const amount = Number(recurring.amount || 0);
        if (!amount || amount <= 0) {
          console.log('💼 Payroll skip: invalid amount', { pid: canonicalPid, amount: recurring.amount });
          return;
        }

        if (String(recurring.lastPayrollKey || '') === payrollRunKey) {
          console.log('💼 Payroll skip: already paid this cycle', { pid: canonicalPid, payrollRunKey });
          return;
        }

        const balances = getAccountBalances(targetAccount);
        const newChecking = roundToCents(balances.checking + amount);
        const newTotal = roundToCents(newChecking + balances.savings);
        const txRef = targetRef.collection('transactions').doc();

        tx.set(targetRef, {
          pid: canonicalPid,
          checkingBalance: newChecking,
          savingsBalance: balances.savings,
          balance: newTotal,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedByUid: 'system',
          recurring: {
            ...recurring,
            enabled: true,
            amount,
            lastPayrollKey: payrollRunKey,
            lastPayAt: admin.firestore.FieldValue.serverTimestamp()
          }
        }, { merge: true });

        if (targetRef.path !== sourceRef.path && sourceRecurring.enabled !== false) {
          tx.set(sourceRef, {
            recurring: {
              ...sourceRecurring,
              enabled: false,
              redirectedToPid: canonicalPid,
              redirectUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedByUid: 'system'
          }, { merge: true });
        }

        tx.set(txRef, {
          type: 'payroll',
          accountType: 'checking',
          amount,
          note: `Automated bi-weekly payroll (${timezone})`,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdByUid: 'system',
          createdByName: 'Payroll Scheduler',
          balanceAfter: newChecking
        });

        console.log('✅ Payroll applied', {
          pid: canonicalPid,
          amount,
          newBalance: newTotal,
          payrollRunKey
        });
      }));
    });

    const payrollResults = await Promise.allSettled(payrollTasks);
    const payrollFailures = payrollResults.filter(result => result.status === 'rejected');
    if (payrollFailures.length) {
      console.error('❌ Payroll task failures', {
        failed: payrollFailures.length,
        total: payrollResults.length,
        errors: payrollFailures.map(result => String(result.reason?.message || result.reason)).slice(0, 20)
      });
    } else {
      console.log('✅ Payroll tasks completed', { total: payrollResults.length });
    }
  }

  if (monthlyDueNow) {
    console.log('🏠 Monthly deductions are due now; loading accounts');
    const monthlyAccounts = await db.collection('bank_accounts').get();
    const monthlyAccountsByPid = pickCanonicalAccountDocs(monthlyAccounts);
    console.log('🏠 Monthly accounts found', {
      count: monthlyAccounts.size,
      uniquePidCount: monthlyAccountsByPid.size,
      monthKey
    });

    const monthlyTasks = [];

    monthlyAccountsByPid.forEach((docSnap, canonicalPid) => {
      monthlyTasks.push(db.runTransaction(async tx => {
        const sourceRef = docSnap.ref;
        const sourceSnap = await tx.get(sourceRef);
        if (!sourceSnap.exists) return 0;

        const sourceAccount = sourceSnap.data() || {};
        const accountRef = db.collection('bank_accounts').doc(canonicalPid);
        const canonicalSnap = accountRef.path === sourceRef.path ? sourceSnap : await tx.get(accountRef);
        const account = canonicalSnap.exists ? (canonicalSnap.data() || {}) : {
          ...sourceAccount,
          pid: canonicalPid
        };

        let existingDeductions = getConfiguredDeductions(account);
        if (!existingDeductions.length && accountRef.path !== sourceRef.path) {
          existingDeductions = getConfiguredDeductions(sourceAccount);
        }

        const outstandingBefore = roundToCents(Number(account.overdueDeductionsBalance ?? sourceAccount.overdueDeductionsBalance ?? 0));
        const startingBalances = getAccountBalances(account);

        if (!existingDeductions.length && outstandingBefore <= 0 && startingBalances.total >= 0) {
          console.log('🏠 Monthly skip: no deductions, no overdue balance', { pid: account.pid || docSnap.id });
          return 0;
        }

        let monthlyDueTotal = 0;
        const dueRows = [];
        const chargedAt = admin.firestore.Timestamp.now();

        const updatedDeductions = existingDeductions.map((item) => {
          const amount = Number(item?.amount || 0);
          const enabled = item?.enabled !== false;
          const lastProcessedMonthKey = String(item?.lastProcessedMonthKey || '');
          if (!enabled || !amount || amount <= 0 || lastProcessedMonthKey === monthKey) {
            return item;
          }

          monthlyDueTotal += amount;
          dueRows.push({
            type: String(item?.type || 'other'),
            label: String(item?.label || ''),
            amount
          });

          return {
            ...item,
            lastProcessedMonthKey: monthKey,
            // Important: FieldValue sentinels cannot be nested inside array objects.
            lastChargedAt: chargedAt
          };
        });

        const monthlyEnabledDeductionTotal = roundToCents(existingDeductions
          .filter(item => item?.enabled !== false && Number(item?.amount || 0) > 0)
          .reduce((sum, item) => sum + Number(item?.amount || 0), 0));

        const outstandingAfterDue = roundToCents(outstandingBefore + monthlyDueTotal);
        const autoPayment = debitFromCheckingThenSavings(
          startingBalances.checking,
          startingBalances.savings,
          Math.min(Math.max(startingBalances.total, 0), outstandingAfterDue)
        );

        let outstandingAfterPayment = roundToCents(outstandingAfterDue - autoPayment.paid);

        const shouldAssessLateFee = outstandingAfterPayment > 0
          && creditProfile.lastLateFeeMonthKey !== monthKey;
        const lateFeeAmount = shouldAssessLateFee
          ? roundToCents(Math.max(15, outstandingAfterPayment * 0.05))
          : 0;

        const shouldAssessOverdraftFee = (
          startingBalances.checking < 0
          || startingBalances.savings < 0
          || startingBalances.total < 0
        ) && creditProfile.lastOverdraftFeeMonthKey !== monthKey;
        const overdraftFeeAmount = shouldAssessOverdraftFee ? 35 : 0;

        outstandingAfterPayment = roundToCents(outstandingAfterPayment + lateFeeAmount + overdraftFeeAmount);

        const creditProfile = normalizeCreditProfile(account.creditProfile || {});
        const hadMonthlyObligation = monthlyDueTotal > 0 || outstandingBefore > 0;
        if (hadMonthlyObligation && creditProfile.lastEvaluatedMonthKey !== monthKey) {
          creditProfile.monthsEvaluated += 1;
          if (outstandingAfterPayment <= 0) {
            creditProfile.onTimeMonths += 1;
            creditProfile.consecutiveOnTimeMonths += 1;
            creditProfile.consecutiveLateMonths = 0;
          } else {
            creditProfile.lateMonths += 1;
            creditProfile.consecutiveLateMonths += 1;
            creditProfile.consecutiveOnTimeMonths = 0;
          }
        }

        if (overdraftFeeAmount > 0) {
          creditProfile.overdraftEvents += 1;
          creditProfile.lastOverdraftFeeMonthKey = monthKey;
        }

        if (lateFeeAmount > 0) {
          creditProfile.lastLateFeeMonthKey = monthKey;
        }

        creditProfile.lastEvaluatedMonthKey = monthKey;
        creditProfile.lastMonthlyDueTotal = roundToCents(monthlyDueTotal);
        creditProfile.lastMonthlyPaidAmount = roundToCents(autoPayment.paid);
        creditProfile.lastLateFeeAmount = roundToCents(lateFeeAmount);
        creditProfile.lastOverdraftFeeAmount = roundToCents(overdraftFeeAmount);
        creditProfile.outstandingBalance = roundToCents(outstandingAfterPayment);

        const scoreSnapshot = computeCreditScore({
          account: {
            ...account,
            checkingBalance: autoPayment.checking,
            savingsBalance: autoPayment.savings
          },
          creditProfile,
          deductionsDueMonthly: monthlyEnabledDeductionTotal,
          outstandingBalance: outstandingAfterPayment
        });

        const finalTotalBalance = roundToCents(autoPayment.checking + autoPayment.savings);

        tx.set(accountRef, {
          pid: canonicalPid,
          checkingBalance: autoPayment.checking,
          savingsBalance: autoPayment.savings,
          balance: finalTotalBalance,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedByUid: 'system',
          deductions: updatedDeductions,
          monthlyDeductions: updatedDeductions,
          overdueDeductionsBalance: outstandingAfterPayment,
          creditScore: scoreSnapshot.score,
          creditFactors: scoreSnapshot.factors,
          creditProfile
        }, { merge: true });

        dueRows.forEach((charge) => {
          const txRef = accountRef.collection('transactions').doc();
          const typeLabel = charge.type.replace(/_/g, ' ');
          const namePart = charge.label ? ` - ${charge.label}` : '';
          tx.set(txRef, {
            type: 'monthly_deduction_due',
            amount: charge.amount,
            note: `Monthly deduction due (${typeLabel}${namePart})`,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdByUid: 'system',
            createdByName: 'Monthly Deduction Scheduler',
            balanceAfter: finalTotalBalance
          });
        });

        if (autoPayment.paid > 0) {
          const paymentTxRef = accountRef.collection('transactions').doc();
          tx.set(paymentTxRef, {
            type: 'monthly_deduction_payment',
            amount: autoPayment.paid,
            note: 'Automatic payment applied to monthly deductions',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdByUid: 'system',
            createdByName: 'Monthly Deduction Scheduler',
            balanceAfter: finalTotalBalance
          });
        }

        if (lateFeeAmount > 0) {
          const lateTxRef = accountRef.collection('transactions').doc();
          tx.set(lateTxRef, {
            type: 'late_fee_assessed',
            amount: lateFeeAmount,
            note: 'Late fee assessed for unpaid monthly deductions',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdByUid: 'system',
            createdByName: 'Monthly Deduction Scheduler',
            balanceAfter: finalTotalBalance
          });
        }

        if (overdraftFeeAmount > 0) {
          const overdraftTxRef = accountRef.collection('transactions').doc();
          tx.set(overdraftTxRef, {
            type: 'overdraft_fee_assessed',
            amount: overdraftFeeAmount,
            note: 'Overdraft fee assessed due to negative balance',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            createdByUid: 'system',
            createdByName: 'Monthly Deduction Scheduler',
            balanceAfter: finalTotalBalance
          });
        }

        console.log('✅ Monthly deductions applied', {
          pid: canonicalPid,
          dueCount: dueRows.length,
          monthlyDueTotal,
          autoPayment: autoPayment.paid,
          lateFeeAmount,
          overdraftFeeAmount,
          overdueAfterRun: outstandingAfterPayment,
          creditScore: scoreSnapshot.score,
          newBalance: finalTotalBalance,
          monthKey
        });

        return autoPayment.paid;
      }));
    });

    const monthlyResults = await Promise.allSettled(monthlyTasks);
    const monthlyFailures = monthlyResults.filter(result => result.status === 'rejected');
    if (monthlyFailures.length) {
      console.error('❌ Monthly deduction task failures', {
        failed: monthlyFailures.length,
        total: monthlyResults.length,
        errors: monthlyFailures.map(result => String(result.reason?.message || result.reason)).slice(0, 20)
      });
    } else {
      console.log('✅ Monthly deduction tasks completed', { total: monthlyResults.length });
    }

    const monthlyDeductionInflow = roundToCents(monthlyResults
      .filter(result => result.status === 'fulfilled')
      .reduce((sum, result) => sum + Number(result.value || 0), 0));

    if (monthlyDeductionInflow > 0) {
      try {
        const inflowResult = await applySiteFinanceInflow({
          amount: monthlyDeductionInflow,
          inflowType: 'monthly_deduction_inflow',
          note: `Aggregated monthly deductions credited to Site funds (${monthKey})`,
          monthKey,
          timezone
        });
        console.log('🏦 Site finance inflow applied from monthly deductions', {
          monthKey,
          monthlyDeductionInflow,
          inflowResult
        });
      } catch (error) {
        console.error('❌ Failed to apply site finance inflow from monthly deductions', {
          monthKey,
          monthlyDeductionInflow,
          error: String(error?.message || error)
        });
      }
    }

    try {
      const foundationResult = await applyFoundationDepositForMonth(monthKey, timezone);
      console.log('🏦 Foundation monthly deposit processing complete', {
        monthKey,
        foundationResult
      });
    } catch (error) {
      console.error('❌ Failed to process Foundation monthly deposit', {
        monthKey,
        error: String(error?.message || error)
      });
    }
  }

  console.log('🏁 processPayroll tick finished');
});

exports.backfillCharacterEmails = onSchedule('every 15 minutes', async () => {
  try {
    const result = await backfillMissingCharacterEmails();
    console.log('character email backfill complete', result);
  } catch (error) {
    console.error('character email backfill failed', error);
  }
});

exports.onBankTransaction = onDocumentCreated('bank_accounts/{pid}/transactions/{txId}', async (event) => {
  console.log('🔔 Transaction trigger fired!', { pid: event.params.pid, txId: event.params.txId });
  
  const txData = event.data?.data();
  if (!txData) {
    console.log('❌ No transaction data found');
    return;
  }
  console.log('📝 Transaction data:', txData);

  const pid = event.params.pid;
  const accountSnap = await db.doc(`bank_accounts/${pid}`).get();
  if (!accountSnap.exists) {
    console.log('❌ Account not found:', pid);
    return;
  }

  const account = accountSnap.data() || {};
  console.log('👤 Account found:', { name: account.name, pid });
  
  const recipient = await resolveCharacterEmail(account);
  if (!recipient) {
    console.log('❌ Could not resolve email for:', account.name);
    return;
  }
  console.log('📧 Recipient resolved:', recipient);

  const txType = (txData.type || 'transaction').toString();
  if (SUPPRESSED_BANK_EMAIL_TX_TYPES.has(txType)) {
    console.log('⏭️ Suppressed bank email notification for transaction type', { txType, pid });
    return;
  }

  const typeLabel = txType.replace(/_/g, ' ').toUpperCase();
  const subject = `Transaction Alert: ${typeLabel}`;
  const amountText = formatCurrency(txData.amount || 0);
  const balanceText = formatCurrency(txData.balanceAfter || account.balance || 0);
  const accountName = account.name || `Personnel ${pid}`;

  let dateObj = new Date();
  if (txData.createdAt?.toDate) {
    dateObj = txData.createdAt.toDate();
  }
  const dateStr = dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const timeStr = dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const body = `---

## SITE-89 FINANCIAL DEPARTMENT

**Transaction Notification**

---

### Account Activity Summary

**Account Holder:** ${accountName}  
**Personnel ID:** \`${pid || 'N/A'}\`  
**Date & Time:** ${dateStr} at ${timeStr}

---

### Transaction Details

| Field | Value |
|-------|-------|
| **Transaction Type** | ${typeLabel} |
| **Amount** | **${amountText}** |
| **New Balance** | **${balanceText}** |
${txData.note ? `| **Notes** | ${txData.note} |` : ''}

---

${txType === 'payroll' ? '### Payroll Information\n\nYour bi-weekly salary has been automatically deposited into your account. Thank you for your continued service to the Foundation.\n\n---\n\n' : ''}
${txType === 'deposit' ? '### Deposit Confirmation\n\nA deposit has been credited to your account. Your updated balance is reflected above.\n\n---\n\n' : ''}
${txType === 'withdraw' ? '### Withdrawal Notice\n\nA withdrawal has been processed on your account. Please verify this transaction was authorized.\n\n---\n\n' : ''}
> **Security Notice:** If you did not authorize this transaction, please contact the Financial Department immediately at \`fd.mgmt@site89.org\` or visit your nearest Site-89 Financial Office.

---

*This is an automated notification from the Site-89 Financial Department. Please do not reply to this email.*

**Foundation Banking Services** | Site-89 Financial Operations  
*Secure • Contain • Protect • Pay*`;

  console.log('✉️ Creating email:', { sender: 'fd.mgmt@site89.org', recipient, subject });
  
  try {
    await db.collection('emails').add({
      sender: 'fd.mgmt@site89.org',
      senderEmail: 'fd.mgmt@site89.org',
      recipients: [recipient],
      subject,
      body,
      isHTML: false,
      format: 'markdown',
      status: 'sent',
      folder: '',
      deletedBy: [],
      ts: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('✅ Email created successfully!');
  } catch (error) {
    console.error('❌ Error creating email:', error);
    throw error;
  }
});

const IMAGE_CODE_LENGTH = 8;
const IMAGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/svg+xml'
]);

const IMAGE_MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg'
};

function normalizeMimeType(contentType = '') {
  return contentType.toString().split(';')[0].trim().toLowerCase();
}

function normalizeImageCode(input = '') {
  const cleaned = input.toString().trim();
  const match = cleaned.match(/^([A-Za-z0-9]{6,32})(?:\.[A-Za-z0-9]+)?$/);
  return match ? match[1] : '';
}

function randomImageCode() {
  const bytes = crypto.randomBytes(IMAGE_CODE_LENGTH);
  return bytes
    .toString('base64')
    .replace(/\+/g, 'A')
    .replace(/\//g, 'B')
    .replace(/=/g, '')
    .slice(0, IMAGE_CODE_LENGTH);
}

async function createUniqueImageCode() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = randomImageCode();
    const doc = await db.collection('image_files').doc(code).get();
    if (!doc.exists) return code;
  }
  throw new Error('Unable to generate unique image code');
}

async function verifyUserFromRequest(req) {
  const authHeader = (req.headers.authorization || '').trim();
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    return await admin.auth().verifyIdToken(token);
  } catch (_error) {
    return null;
  }
}

function parseCharacterClearance(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return value;
  const match = String(value).match(/\d+/);
  return match ? parseInt(match[0], 10) : NaN;
}

function characterCanManageEvents(characterData = {}) {
  const clearance = parseCharacterClearance(characterData.clearance);
  if (!Number.isNaN(clearance) && clearance >= 4) return true;

  const rank = String(characterData.rank || '').toLowerCase();
  return rank.includes('director') || rank.includes('asst. director') || rank.includes('assistant director');
}

async function userCanManageEventsByUid(uid) {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) return false;

  try {
    const charsSnap = await db.collection('characters')
      .where('linkedUID', '==', normalizedUid)
      .get();

    return charsSnap.docs.some(docSnap => characterCanManageEvents(docSnap.data() || {}));
  } catch (error) {
    console.error(`❌ Error checking event permissions for ${normalizedUid}:`, error);
    return false;
  }
}

const imageApiApp = express();

imageApiApp.get('/image/:code', async (req, res) => {
  const code = normalizeImageCode(req.params.code);
  if (!code) {
    res.status(404).send('Not found');
    return;
  }

  const imageDoc = await db.collection('image_files').doc(code).get();
  if (!imageDoc.exists) {
    res.status(404).send('Not found');
    return;
  }

  const imageData = imageDoc.data() || {};
  const storagePath = imageData.storagePath;
  if (!storagePath) {
    res.status(404).send('Not found');
    return;
  }

  try {
    const bucket = admin.storage().bucket('site-89-2d768.firebasestorage.app');
    const storageFile = bucket.file(storagePath);
    const [exists] = await storageFile.exists();
    if (!exists) {
      res.status(404).send('Not found');
      return;
    }

    const contentType = imageData.mimeType || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    storageFile.createReadStream().pipe(res);
  } catch (error) {
    console.error('Image read error:', error);
    res.status(500).send('Failed to load image');
  }
});

imageApiApp.post('/upload', express.raw({ type: '*/*', limit: IMAGE_MAX_UPLOAD_BYTES }), async (req, res) => {
  const verifiedUser = await verifyUserFromRequest(req);
  if (!verifiedUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const mimeType = normalizeMimeType(req.get('content-type'));
  if (!IMAGE_ALLOWED_MIME_TYPES.has(mimeType)) {
    res.status(400).json({ error: 'Unsupported file type' });
    return;
  }

  const uploadedBuffer = Buffer.isBuffer(req.body) ? req.body : null;
  if (!uploadedBuffer || !uploadedBuffer.length) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  try {
    const code = await createUniqueImageCode();
    const extension = IMAGE_MIME_EXTENSIONS[mimeType] || '.bin';
    const storagePath = `images/${code}${extension}`;

    const bucket = admin.storage().bucket('site-89-2d768.firebasestorage.app');
    const storageFile = bucket.file(storagePath);

    await storageFile.save(uploadedBuffer, {
      resumable: false,
      contentType: mimeType,
      metadata: {
        cacheControl: 'public, max-age=31536000, immutable'
      }
    });

    await db.collection('image_files').doc(code).set({
      code,
      extension,
      mimeType,
      size: uploadedBuffer.length,
      storagePath,
      uploaderUid: verifiedUser.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Always use site89.org domain for image URLs
    const url = `https://site89.org/image/${code}${extension}`;

    res.status(201).json({
      code,
      extension,
      url
    });
  } catch (error) {
    console.error('Image upload error:', error);
    
    // Provide more specific error messages
    let errorMessage = 'Upload failed';
    if (error.code === 'storage/unauthorized') {
      errorMessage = 'Storage access denied. Please check Firebase Storage configuration.';
    } else if (error.code === 'storage/bucket-not-found') {
      errorMessage = 'Storage bucket not found. Please configure Firebase Storage.';
    } else if (error.code === 'storage/quota-exceeded') {
      errorMessage = 'Storage quota exceeded. Please contact administrator.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

imageApiApp.use((error, _req, res, next) => {
  if (!error) {
    next();
    return;
  }

  if (error.type === 'entity.too.large' || error.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'File exceeds 10MB upload limit' });
    return;
  }

  console.error('Image API middleware error:', error);
  res.status(400).json({ error: error.message || 'Invalid upload request' });
});

imageApiApp.use((_req, res) => {
  res.status(404).send('Not found');
});

exports.imageApi = onRequest({ invoker: 'public' }, imageApiApp);

exports.purgeMailboxEmails = onCall(async (request) => {
  await assertEmailPurgeAdmin(request);

  const mailboxInput = String(request.data && request.data.mailbox ? request.data.mailbox : '').trim();
  const mailbox = normalizeMailboxAddress(mailboxInput);
  const includeSent = request.data && request.data.includeSent !== false;

  if (!mailbox || !mailbox.includes('@')) {
    throw new HttpsError('invalid-argument', 'A valid mailbox email is required.');
  }

  const mailboxVariants = [...new Set([mailboxInput, mailbox].filter(Boolean))];
  const emailRefsById = new Map();
  let recipientMatches = 0;
  let senderMatches = 0;

  await Promise.all(mailboxVariants.map(async (variant) => {
    const recipientSnap = await db.collection('emails')
      .where('recipients', 'array-contains', variant)
      .get();
    recipientSnap.forEach((docSnap) => {
      recipientMatches += 1;
      emailRefsById.set(docSnap.id, docSnap.ref);
    });
  }));

  if (includeSent) {
    await Promise.all(mailboxVariants.map(async (variant) => {
      const [senderSnap, senderEmailSnap] = await Promise.all([
        db.collection('emails').where('sender', '==', variant).get(),
        db.collection('emails').where('senderEmail', '==', variant).get()
      ]);

      senderSnap.forEach((docSnap) => {
        senderMatches += 1;
        emailRefsById.set(docSnap.id, docSnap.ref);
      });

      senderEmailSnap.forEach((docSnap) => {
        senderMatches += 1;
        emailRefsById.set(docSnap.id, docSnap.ref);
      });
    }));
  }

  const refsToDelete = [...emailRefsById.values()];
  for (let i = 0; i < refsToDelete.length; i += EMAIL_PURGE_BATCH_SIZE) {
    const batch = db.batch();
    refsToDelete.slice(i, i + EMAIL_PURGE_BATCH_SIZE).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  console.log('🧹 Mailbox purge complete', {
    mailbox,
    includeSent,
    recipientMatches,
    senderMatches,
    deletedCount: refsToDelete.length
  });

  return {
    mailbox,
    includeSent,
    deletedCount: refsToDelete.length,
    recipientMatches,
    senderMatches
  };
});

// ==============================================
// Discord Email Notifications
// ==============================================

// IMPORTANT: Set this webhook URL in your Firebase Functions config:
// firebase functions:config:set discord.webhook_url="YOUR_WEBHOOK_URL"
// Or use environment variables in Firebase Console

exports.onEmailCreated = onDocumentCreated('emails/{emailId}', async (event) => {
  console.log('📧 New email created, checking for Discord notifications');
  
  const emailData = event.data?.data();
  if (!emailData) {
    console.log('❌ No email data found');
    return;
  }

  // Resolve webhook URL in priority order:
  // 1) process.env.DISCORD_WEBHOOK_URL
  // 2) firebase functions config (discord.webhook_url)
  // 3) Firestore doc settings/integrations.discordWebhookUrl
  let DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

  if (!DISCORD_WEBHOOK_URL) {
    try {
      const config = functions.config();
      DISCORD_WEBHOOK_URL = (config && config.discord && config.discord.webhook_url) || '';
    } catch (_e) {
      // Ignore and continue to Firestore fallback
    }
  }

  if (!DISCORD_WEBHOOK_URL) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const integrationsData = integrationsDoc.data() || {};
        DISCORD_WEBHOOK_URL = String(integrationsData.discordWebhookUrl || '').trim();
      }
    } catch (error) {
      console.error('⚠️ Failed to read settings/integrations webhook fallback:', error);
    }
  }
  
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('⚠️ Discord webhook URL not configured. Skipping notification.');
    console.log('Set one of: DISCORD_WEBHOOK_URL env var, firebase config discord.webhook_url, or Firestore settings/integrations.discordWebhookUrl');
    return;
  }

  const recipients = emailData.recipients || [];
  console.log(`📬 Processing ${recipients.length} recipient(s)`);

  // Track which users we've already notified (to avoid duplicate notifications)
  const notifiedUsers = new Set();

  // Process each recipient
  for (const recipientEmail of recipients) {
    try {
      const normalizedEmail = recipientEmail.toLowerCase().trim();
      console.log(`🔍 Looking up character for email: ${normalizedEmail}`);
      
      // Find character by email
      const charSnap = await db.collection('characters')
        .where('email', '==', normalizedEmail)
        .limit(1)
        .get();
      
      if (charSnap.empty) {
        console.log(`⚠️ No character found for email: ${normalizedEmail}`);
        continue;
      }
      
      const charDoc = charSnap.docs[0];
      const charData = charDoc.data();
      const linkedUID = charData.linkedUID;
      
      if (!linkedUID) {
        console.log(`⚠️ Character ${charData.name || 'Unknown'} has no linked account`);
        continue;
      }
      
      // Skip if we've already notified this user (in case they have multiple characters receiving the same email)
      if (notifiedUsers.has(linkedUID)) {
        console.log(`⏭️ Already notified user ${linkedUID}, skipping duplicate`);
        continue;
      }
      
      console.log(`🔍 Looking up user account: ${linkedUID}`);
      
      // Find user's Discord ID from users collection
      const userDoc = await db.collection('users').doc(linkedUID).get();
      
      if (!userDoc.exists) {
        console.log(`⚠️ No user document found for UID: ${linkedUID}`);
        continue;
      }
      
      const userData = userDoc.data();
      const discordUserId = normalizeDiscordUserId(userData.discordUserId);
      
      if (!discordUserId) {
        console.log(`⚠️ User account has no Discord linked (character: ${charData.name || 'Unknown'})`);
        continue;
      }
      
      console.log(`✅ Found Discord user: ${discordUserId} for character ${charData.name}`);
      
      // Prepare Discord message
      const characterName = charData.name || 'your character';
      
      const discordPayload = {
        content: `<@${discordUserId}>`,
        allowed_mentions: buildAllowedMentions({ userIds: [discordUserId] }),
        embeds: [{
          title: '📬 New Email Received',
          description: `**To:** ${characterName}`,
          color: 0x00d9b5, // Teal accent color matching Site-89 theme
          timestamp: new Date().toISOString(),
          footer: {
            text: 'Site-89 Email System'
          },
          url: 'https://site89.org/emails/'
        }]
      };
      
      console.log(`📤 Sending Discord notification to user ${discordUserId}`);
      
      // Send to Discord webhook using native fetch (Node 18+ has built-in fetch)
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayload)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Discord webhook failed (${response.status}):`, errorText);
      } else {
        console.log(`✅ Discord notification sent successfully to ${charData.name}'s owner`);
        notifiedUsers.add(linkedUID); // Mark this user as notified
      }
      
      // Rate limiting: wait 100ms between notifications to avoid Discord rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (error) {
      console.error(`❌ Error processing recipient ${recipientEmail}:`, error);
      // Continue with other recipients even if one fails
    }
  }
  
  console.log('✅ Email notification processing complete');
});

// Discord Event Notifications
// ==============================================

// IMPORTANT: Set these webhook URLs in your Firebase Functions config or environment variables:
// firebase functions:config:set discord.events_webhook_url="YOUR_EVENTS_WEBHOOK_URL"
// firebase functions:config:set discord.looking_for_rp_role_id="YOUR_ROLE_ID"
// firebase functions:config:set discord.department_role_ids='{"AD":"role_id_1","TSD":"role_id_2","ScD":"role_id_3","SD":"role_id_4","IA":"role_id_5"}'
// firebase functions:config:set discord.debug_mode="true" -- Set to "true" to use plaintext role names instead of pings

function getRuntimeConfigFromEnv() {
  try {
    const raw = process.env.CLOUD_RUNTIME_CONFIG;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed || {};
  } catch (_e) {
    return {};
  }
}

function parseLooseRoleIdMap(input) {
  if (!input) return {};
  if (typeof input === 'object' && !Array.isArray(input)) return input;

  let raw = String(input).trim();
  if (!raw) return {};

  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    raw = raw.slice(1, -1).trim();
  }

  try {
    return JSON.parse(raw);
  } catch (_e) {
    const result = {};
    const cleaned = raw.replace(/^\{/, '').replace(/\}$/, '');
    const parts = cleaned.split(',').map(p => p.trim()).filter(Boolean);
    parts.forEach(part => {
      const idx = part.indexOf(':');
      if (idx === -1) return;
      const key = part.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
      const value = part.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && value) result[key] = value;
    });
    return result;
  }
}

async function resolveDebugMode() {
  const runtimeConfig = getRuntimeConfigFromEnv();
  let debugMode = process.env.DISCORD_DEBUG_MODE === 'true' || false;

  if (!debugMode) {
    const envConfigDebug = runtimeConfig && runtimeConfig.discord && runtimeConfig.discord.debug_mode;
    debugMode = envConfigDebug === 'true' || envConfigDebug === true;
  }

  if (!debugMode) {
    try {
      const config = functions.config();
      debugMode = (config && config.discord && (config.discord.debug_mode === 'true' || config.discord.debug_mode === true)) || false;
    } catch (_e) {
      // Ignore
    }
  }

  if (!debugMode) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const data = integrationsDoc.data() || {};
        debugMode = data.discordDebugMode === true;
      }
    } catch (error) {
      console.error('⚠️ Failed to read debug mode from Firestore:', error);
    }
  }

  return debugMode;
}

async function resolveEventsWebhookUrl() {
  const runtimeConfig = getRuntimeConfigFromEnv();
  let webhookUrl = process.env.DISCORD_EVENTS_WEBHOOK_URL || '';
  console.log(`🔍 Checking process.env.DISCORD_EVENTS_WEBHOOK_URL: ${webhookUrl ? 'FOUND' : 'NOT FOUND'}`);

  if (!webhookUrl) {
    webhookUrl = String(runtimeConfig?.discord?.events_webhook_url || '').trim();
    console.log(`🔍 Checking CLOUD_RUNTIME_CONFIG.discord.events_webhook_url: ${webhookUrl ? 'FOUND' : 'NOT FOUND'}`);
  }

  if (!webhookUrl) {
    try {
      const config = functions.config();
      webhookUrl = (config && config.discord && config.discord.events_webhook_url) || '';
      console.log(`🔍 Checking functions.config().discord.events_webhook_url: ${webhookUrl ? 'FOUND' : 'NOT FOUND'}`);
    } catch (e) {
      console.warn(`⚠️ functions.config() failed:`, e.message);
    }
  }

  if (!webhookUrl) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const data = integrationsDoc.data() || {};
        webhookUrl = String(data.discordEventsWebhookUrl || '').trim();
        console.log(`🔍 Checking Firestore settings/integrations.discordEventsWebhookUrl: ${webhookUrl ? 'FOUND' : 'NOT FOUND'}`);
      } else {
        console.log(`🔍 Firestore settings/integrations document does not exist`);
      }
    } catch (error) {
      console.error('⚠️ Failed to read events webhook from Firestore:', error);
    }
  }

  // Last resort fallback
  if (!webhookUrl) {
    console.warn(`⚠️ Using fallback webhook URL`);
    webhookUrl = FALLBACK_EVENTS_WEBHOOK;
  }

  console.log(`✅ Final webhook URL: ${webhookUrl ? 'RESOLVED' : 'NOT RESOLVED'}`);
  return webhookUrl;
}

async function resolveLookingForRpRoleId() {
  const runtimeConfig = getRuntimeConfigFromEnv();
  let roleId = process.env.DISCORD_LOOKING_FOR_RP_ROLE_ID || '';

  if (!roleId) {
    roleId = String(runtimeConfig?.discord?.looking_for_rp_role_id || '').trim();
  }

  if (!roleId) {
    try {
      const config = functions.config();
      roleId = (config && config.discord && config.discord.looking_for_rp_role_id) || '';
    } catch (_e) {
      // Ignore
    }
  }

  if (!roleId) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const data = integrationsDoc.data() || {};
        roleId = String(data.discordLookingForRpRoleId || '').trim();
      }
    } catch (error) {
      console.error('⚠️ Failed to read looking for RP role ID from Firestore:', error);
    }
  }

  // Last resort fallback
  if (!roleId) {
    console.warn(`⚠️ Using fallback looking for RP role ID`);
    roleId = FALLBACK_LOOKING_FOR_RP_ROLE;
  }

  return roleId;
}

async function resolveDepartmentRoleIds() {
  const runtimeConfig = getRuntimeConfigFromEnv();
  let roleIds = {};

  const envRoleIds = process.env.DISCORD_DEPARTMENT_ROLE_IDS || '';
  if (envRoleIds) {
    roleIds = parseLooseRoleIdMap(envRoleIds);
  }

  if (Object.keys(roleIds).length === 0) {
    roleIds = parseLooseRoleIdMap(runtimeConfig?.discord?.department_role_ids);
  }

  if (Object.keys(roleIds).length === 0) {
    try {
      const config = functions.config();
      if (config && config.discord && config.discord.department_role_ids) {
        roleIds = parseLooseRoleIdMap(config.discord.department_role_ids);
      }
    } catch (_e) {
      // Ignore
    }
  }

  if (Object.keys(roleIds).length === 0) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const data = integrationsDoc.data() || {};
        roleIds = parseLooseRoleIdMap(data.discordDepartmentRoleIds || {});
      }
    } catch (error) {
      console.error('⚠️ Failed to read department role IDs from Firestore:', error);
    }
  }

  // Last resort fallback
  if (Object.keys(roleIds).length === 0) {
    console.warn(`⚠️ Using fallback department role IDs`);
    roleIds = FALLBACK_DEPARTMENT_ROLES;
  }

  return roleIds;
}

function normalizeDiscordUserId(value) {
  const normalized = String(value || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeDiscordRoleId(value) {
  const normalized = String(value || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function buildAllowedMentions({ userIds = [], roleIds = [] } = {}) {
  const users = [...new Set(userIds.map(normalizeDiscordUserId).filter(Boolean))];
  const roles = [...new Set(roleIds.map(normalizeDiscordRoleId).filter(Boolean))];
  return {
    parse: [],
    users,
    roles
  };
}

async function resolveLinkedUidForRsvp(rsvpDoc) {
  const rsvpData = rsvpDoc.data() || {};
  const characterId = String(rsvpData.characterId || rsvpDoc.id || '').trim();
  const fallbackUid = String(rsvpData.createdByUid || '').trim();
  const fallbackCharacterName = rsvpData.characterName || 'Unknown';

  if (!characterId) {
    return {
      uid: fallbackUid,
      characterName: fallbackCharacterName
    };
  }

  try {
    const characterDoc = await db.collection('characters').doc(characterId).get();
    if (characterDoc.exists) {
      const characterData = characterDoc.data() || {};
      const linkedUID = String(characterData.linkedUID || '').trim();
      return {
        uid: linkedUID || fallbackUid,
        characterName: characterData.name || fallbackCharacterName
      };
    }

    console.log(`⚠️ No character document found for RSVP character ${characterId}`);
  } catch (error) {
    console.error(`❌ Error resolving character ${characterId} for RSVP:`, error);
  }

  return {
    uid: fallbackUid,
    characterName: fallbackCharacterName
  };
}

// Returns { attendees, mentionUserIds }
// attendees  – every RSVPd character (matches website display)
// mentionUserIds – deduplicated Discord user IDs that should be pinged
async function getRsvpedUsers(eventId) {
  const attendees = [];
  const seenDiscordIds = new Set();
  const mentionUserIds = [];

  try {
    const rsvpSnap = await db.collection('events').doc(eventId).collection('rsvps').get();
    console.log(`📋 Found ${rsvpSnap.size} RSVP doc(s) for event ${eventId}`);

    for (const rsvpDoc of rsvpSnap.docs) {
      const rsvpData = rsvpDoc.data() || {};
      const { uid, characterName } = await resolveLinkedUidForRsvp(rsvpDoc);

      // Always record this character – they show on the website regardless of Discord linkage
      const entry = { characterName, uid: uid || null, discordUserId: null };

      if (!uid) {
        console.log(`⚠️ RSVP for ${characterName} has no linked UID – listed but cannot be pinged`);
        attendees.push(entry);
        continue;
      }

      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) {
        console.log(`⚠️ No user doc for UID ${uid} (${characterName}) – listed but cannot be pinged`);
        attendees.push(entry);
        continue;
      }

      const discordUserId = normalizeDiscordUserId((userDoc.data() || {}).discordUserId);
      if (!discordUserId) {
        console.log(`⚠️ User ${uid} has no valid Discord ID (${characterName}) – listed but cannot be pinged`);
        attendees.push(entry);
        continue;
      }

      entry.discordUserId = discordUserId;
      attendees.push(entry);

      if (!seenDiscordIds.has(discordUserId)) {
        seenDiscordIds.add(discordUserId);
        mentionUserIds.push(discordUserId);
      } else {
        console.log(`⏭️ Discord user ${discordUserId} already queued for ping (${characterName})`);
      }
    }
  } catch (error) {
    console.error(`❌ Error fetching RSVPs for event ${eventId}:`, error);
  }

  console.log(`📊 RSVP summary for ${eventId}: ${attendees.length} total attendee(s), ${mentionUserIds.length} unique Discord ping(s)`);
  return { attendees, mentionUserIds };
}

// Builds the attendee field value, respecting Discord's 1024-char embed field limit
function formatAttendeeList(attendees) {
  const MAX_CHARS = 1024;
  const lines = attendees.map(a => `• **${a.characterName || 'Unknown'}**`);
  const full = lines.join('\n');
  if (full.length <= MAX_CHARS) return full || '—';

  let result = '';
  let included = 0;
  for (const line of lines) {
    const candidate = result ? `${result}\n${line}` : line;
    if (candidate.length > MAX_CHARS - 40) {
      result += `\n*…and ${lines.length - included} more*`;
      break;
    }
    result = candidate;
    included++;
  }
  return result || '—';
}

async function sendDiscordNotification(webhookUrl, payload) {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Discord webhook failed (${response.status}):`, errorText);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Error sending Discord notification:`, error);
    return false;
  }
}

async function markNotificationSent(eventId, notificationType) {
  const notificationKey = `${notificationType}_sent`;
  try {
    await db.collection('events').doc(eventId).update({
      [notificationKey]: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`✅ Marked ${notificationType} notification as sent for event ${eventId}`);
  } catch (error) {
    console.error(`❌ Error marking notification sent:`, error);
  }
}

async function hasNotificationBeenSent(eventData, notificationType) {
  const notificationKey = `${notificationType}_sent`;
  return !!eventData[notificationKey];
}

function formatEventTime(date) {
  // Discord timestamp format - shows in user's local timezone
  const epoch = Math.floor(date.getTime() / 1000);
  return `<t:${epoch}:F>`; // F = Full date and time
}

// Returns { start, end } as UTC Dates for the ET calendar day, optionally offset by N days
function getETDayBoundaries(offsetDays = 0) {
  const now = new Date();
  // Determine the ET date string for a point +offsetDays from now
  const base = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  const etDateStr = base.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // "YYYY-MM-DD"
  const [y, m, d] = etDateStr.split('-').map(Number);

  // Find the ET UTC-offset by checking what ET hour noon UTC falls on that day
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const etHourAtNoon = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(noonUTC),
    10
  );
  // Winter (EST) = UTC-5 → etHourAtNoon = 7 → offset = 5
  // Summer (EDT) = UTC-4 → etHourAtNoon = 8 → offset = 4
  const etOffsetHours = 12 - etHourAtNoon;

  const start = new Date(Date.UTC(y, m - 1, d, etOffsetHours, 0, 0));
  const end   = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function formatRoleMention(roleId) {
  return `<@&${roleId}>`;
}

function formatUserMention(userId) {
  return `<@${userId}>`;
}

// Check for events 3 days away - notify @looking for rp and departments
exports.checkEvents3DaysAway = onSchedule({ schedule: 'every day 00:00', timeZone: 'America/New_York' }, async () => {
  console.log('🔔 Checking for events 3 days away (ET)...');
  
  const webhookUrl = await resolveEventsWebhookUrl();
  if (!webhookUrl) {
    console.warn('⚠️ Events webhook URL not configured. Skipping.');
    return;
  }
  
  const lookingForRpRoleId = await resolveLookingForRpRoleId();
  const departmentRoleIds = await resolveDepartmentRoleIds();
  
  const { start: startOfTargetDay, end: endOfTargetDay } = getETDayBoundaries(3);
  console.log(`📅 Looking for events between ${startOfTargetDay.toISOString()} and ${endOfTargetDay.toISOString()}`);
  
  const eventsSnap = await db.collection('events')
    .where('start', '>=', admin.firestore.Timestamp.fromDate(startOfTargetDay))
    .where('start', '<', admin.firestore.Timestamp.fromDate(endOfTargetDay))
    .get();
  
  console.log(`📅 Found ${eventsSnap.size} event(s) 3 days away`);
  
  for (const eventDoc of eventsSnap.docs) {
    const eventData = eventDoc.data();
    const eventId = eventDoc.id;
    
    // Skip if 3-day notification already sent
    if (await hasNotificationBeenSent(eventData, 'three_day')) {
      console.log(`⏭️ 3-day notification already sent for: ${eventData.title}`);
      continue;
    }
    
    const eventTitle = eventData.title || 'Untitled Event';
    const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
    const eventDepartments = Array.isArray(eventData.departments) ? eventData.departments : [];
    const eventZone = eventData.zone || 'TBD';
    const eventManager = eventData.manager || 'TBD';
    const eventShortDesc = eventData.shortDesc || 'Details on events page.';
    
    // Build mentions string - include @looking for rp and department roles
    const mentions = [];
    const mentionedRoleIds = [];
    if (lookingForRpRoleId) {
      mentions.push(formatRoleMention(lookingForRpRoleId));
      mentionedRoleIds.push(lookingForRpRoleId);
    }
    
    // Add department role mentions
    for (const dept of eventDepartments) {
      const deptRoleId = departmentRoleIds[dept];
      if (deptRoleId) {
        mentions.push(formatRoleMention(deptRoleId));
        mentionedRoleIds.push(deptRoleId);
      }
    }
    
    // Main announcement to events channel
    const mainPayload = {
      content: mentions.length > 0 ? mentions.join(' ') : undefined,
      allowed_mentions: buildAllowedMentions({ roleIds: mentionedRoleIds }),
      embeds: [{
        title: '📅 Upcoming Event in 3 Days',
        description: `**${eventTitle}**\n\n${eventShortDesc}`,
        color: 0x00d9b5,
        fields: [
          { name: '⏰ Time', value: formatEventTime(eventStart), inline: false },
          { name: '🌍 Zone', value: eventZone, inline: true },
          { name: '🏢 Departments', value: eventDepartments.join(', ') || 'All', inline: true },
          { name: '👤 RP Manager', value: eventManager, inline: true }
        ],
        footer: { text: 'RSVP at site89.org/events' },
        url: 'https://site89.org/events/'
      }]
    };
    
    const mainSuccess = await sendDiscordNotification(webhookUrl, mainPayload);
    if (mainSuccess) {
      console.log(`✅ Sent 3-day notification for: ${eventTitle}`);
    }
    
    await markNotificationSent(eventId, 'three_day');
    await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting between events
  }
  
  console.log('✅ 3-day event check complete');
});

// Check for events starting today - notify RSVPed users
exports.checkEventsDayOf = onSchedule({ schedule: 'every day 00:00', timeZone: 'America/New_York' }, async () => {
  console.log('🔔 Checking for events starting today (ET)...');
  
  const webhookUrl = await resolveEventsWebhookUrl();
  if (!webhookUrl) {
    console.warn('⚠️ Events webhook URL not configured. Skipping.');
    return;
  }
  
  const { start: startOfToday, end: endOfToday } = getETDayBoundaries(0);
  console.log(`📅 Looking for events between ${startOfToday.toISOString()} and ${endOfToday.toISOString()}`);
  
  const eventsSnap = await db.collection('events')
    .where('start', '>=', admin.firestore.Timestamp.fromDate(startOfToday))
    .where('start', '<', admin.firestore.Timestamp.fromDate(endOfToday))
    .get();
  
  console.log(`📅 Found ${eventsSnap.size} event(s) today`);
  
  for (const eventDoc of eventsSnap.docs) {
    const eventData = eventDoc.data();
    const eventId = eventDoc.id;
    
    // Skip if day-of notification already sent
    if (await hasNotificationBeenSent(eventData, 'day_of')) {
      console.log(`⏭️ Day-of notification already sent for: ${eventData.title}`);
      continue;
    }
    
    const eventTitle = eventData.title || 'Untitled Event';
    const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
    
    // Get RSVPed users
    const { attendees: dayOfAttendees, mentionUserIds: dayOfMentions } = await getRsvpedUsers(eventId);

    if (dayOfAttendees.length === 0) {
      console.log(`⚠️ No RSVPs for event: ${eventTitle}`);
      await markNotificationSent(eventId, 'day_of');
      continue;
    }

    console.log(`📬 Notifying ${dayOfAttendees.length} RSVP(s) (${dayOfMentions.length} Discord ping(s)) for: ${eventTitle}`);

    const dayOfMentionStr = dayOfMentions.map(formatUserMention).join(' ');
    const payload = {
      content: dayOfMentionStr || undefined,
      allowed_mentions: buildAllowedMentions({ userIds: dayOfMentions }),
      embeds: [{
        title: '📅 Event Today!',
        description: `**${eventTitle}** starts today!\n\nThe following characters are registered to attend:`,
        color: 0x00d9b5,
        fields: [
          { name: '⏰ Start Time', value: formatEventTime(eventStart), inline: false },
          { name: `Attendees (${dayOfAttendees.length})`, value: formatAttendeeList(dayOfAttendees), inline: false }
        ],
        footer: { text: 'Site-89 Events' },
        url: 'https://site89.org/events/'
      }]
    };

    await sendDiscordNotification(webhookUrl, payload);
    console.log(`✅ Sent consolidated day-of notification to ${dayOfAttendees.length} attendees`);
    
    await markNotificationSent(eventId, 'day_of');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('✅ Day-of event check complete');
});

// Check for events starting in 30 minutes
exports.checkEvents30MinutesAway = onSchedule('every 15 minutes', async () => {
  console.log('🔔 Checking for events starting in 30 minutes...');
  
  const webhookUrl = await resolveEventsWebhookUrl();
  if (!webhookUrl) {
    console.warn('⚠️ Events webhook URL not configured. Skipping.');
    return;
  }
  
  const now = new Date();
  const thirtyMinutesFromNow = new Date(now.getTime() + (30 * 60 * 1000));
  const fortyFiveMinutesFromNow = new Date(now.getTime() + (45 * 60 * 1000)); // 15-minute window
  
  const eventsSnap = await db.collection('events')
    .where('start', '>=', admin.firestore.Timestamp.fromDate(thirtyMinutesFromNow))
    .where('start', '<', admin.firestore.Timestamp.fromDate(fortyFiveMinutesFromNow))
    .get();
  
  console.log(`📅 Found ${eventsSnap.size} event(s) starting in ~30 minutes`);
  
  for (const eventDoc of eventsSnap.docs) {
    const eventData = eventDoc.data();
    const eventId = eventDoc.id;
    
    // Skip if 30-minute notification already sent
    if (await hasNotificationBeenSent(eventData, 'thirty_min')) {
      console.log(`⏭️ 30-minute notification already sent for: ${eventData.title}`);
      continue;
    }
    
    const eventTitle = eventData.title || 'Untitled Event';
    const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
    
    const { attendees: thirtyMinAttendees, mentionUserIds: thirtyMinMentions } = await getRsvpedUsers(eventId);

    if (thirtyMinAttendees.length === 0) {
      console.log(`⚠️ No RSVPs for event: ${eventTitle}`);
      await markNotificationSent(eventId, 'thirty_min');
      continue;
    }

    console.log(`📬 Sending 30-min reminders for: ${eventTitle} – ${thirtyMinAttendees.length} attendee(s), ${thirtyMinMentions.length} Discord ping(s)`);

    const thirtyMinMentionStr = thirtyMinMentions.map(formatUserMention).join(' ');
    const payload = {
      content: thirtyMinMentionStr || undefined,
      allowed_mentions: buildAllowedMentions({ userIds: thirtyMinMentions }),
      embeds: [{
        title: '⏰ Event Starting in 30 Minutes!',
        description: `**${eventTitle}** is starting soon!\n\nThe following characters are registered to attend:`,
        color: 0xFFA500,
        fields: [
          { name: '⏰ Start Time', value: formatEventTime(eventStart), inline: false },
          { name: `Attendees (${thirtyMinAttendees.length})`, value: formatAttendeeList(thirtyMinAttendees), inline: false }
        ],
        footer: { text: 'Get ready!' },
        url: 'https://site89.org/events/'
      }]
    };

    await sendDiscordNotification(webhookUrl, payload);
    console.log(`✅ Sent consolidated 30-min reminder to ${thirtyMinAttendees.length} attendees`);
    
    await markNotificationSent(eventId, 'thirty_min');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('✅ 30-minute event check complete');
});

// Check for events starting now
exports.checkEventsStartingNow = onSchedule('every 5 minutes', async () => {
  console.log('🔔 Checking for events starting now...');
  
  const webhookUrl = await resolveEventsWebhookUrl();
  if (!webhookUrl) {
    console.warn('⚠️ Events webhook URL not configured. Skipping.');
    return;
  }
  
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - (5 * 60 * 1000));
  const fiveMinutesFromNow = new Date(now.getTime() + (5 * 60 * 1000));
  
  const eventsSnap = await db.collection('events')
    .where('start', '>=', admin.firestore.Timestamp.fromDate(fiveMinutesAgo))
    .where('start', '<', admin.firestore.Timestamp.fromDate(fiveMinutesFromNow))
    .get();
  
  console.log(`📅 Found ${eventsSnap.size} event(s) starting now`);
  
  for (const eventDoc of eventsSnap.docs) {
    const eventData = eventDoc.data();
    const eventId = eventDoc.id;
    
    // Skip if start notification already sent
    if (await hasNotificationBeenSent(eventData, 'start')) {
      console.log(`⏭️ Start notification already sent for: ${eventData.title}`);
      continue;
    }
    
    const eventTitle = eventData.title || 'Untitled Event';
    const eventZone = eventData.zone || 'TBD';
    
    const { attendees: startAttendees, mentionUserIds: startMentions } = await getRsvpedUsers(eventId);

    if (startAttendees.length === 0) {
      console.log(`⚠️ No RSVPs for event: ${eventTitle}`);
      await markNotificationSent(eventId, 'start');
      continue;
    }

    console.log(`📬 Sending start notifications for: ${eventTitle} – ${startAttendees.length} attendee(s), ${startMentions.length} Discord ping(s)`);

    const startMentionStr = startMentions.map(formatUserMention).join(' ');
    const payload = {
      content: startMentionStr || undefined,
      allowed_mentions: buildAllowedMentions({ userIds: startMentions }),
      embeds: [{
        title: '🎬 Event Starting NOW!',
        description: `**${eventTitle}** is starting right now!\n\nGo to the ${eventZone} to participate:`,
        color: 0xFF0000,
        fields: [
          { name: `Attendees (${startAttendees.length})`, value: formatAttendeeList(startAttendees), inline: false }
        ],
        footer: { text: 'Have fun!' },
        url: 'https://site89.org/events/'
      }]
    };

    await sendDiscordNotification(webhookUrl, payload);
    console.log(`✅ Sent consolidated start notification to ${startAttendees.length} attendees`);
    
    await markNotificationSent(eventId, 'start');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('✅ Start event check complete');
});

// Manual trigger endpoints for debugging
// ==============================================

exports.triggerEventNotifications = onRequest({ cors: true }, async (req, res) => {
  // Only allow POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method not allowed' });
    return;
  }

  const requester = await verifyUserFromRequest(req);
  if (!requester) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }

  const canManageEvents = await userCanManageEventsByUid(requester.uid);
  if (!canManageEvents) {
    res.status(403).json({ success: false, message: 'Insufficient permissions' });
    return;
  }

  const { notificationType, eventId } = req.body || {};

  if (!notificationType) {
    res.status(400).json({ success: false, message: 'Missing notificationType' });
    return;
  }

  console.log(`🔧 Manual trigger requested: ${notificationType} for event ${eventId || 'all'}`);

  try {
    const webhookUrl = await resolveEventsWebhookUrl();
    if (!webhookUrl) {
      res.status(500).json({
        success: false,
        message: 'Events webhook URL not configured (discord.events_webhook_url / DISCORD_EVENTS_WEBHOOK_URL / settings/integrations.discordEventsWebhookUrl)'
      });
      return;
    }

    if (notificationType === 'three_day') {
      const lookingForRpRoleId = await resolveLookingForRpRoleId();
      const departmentRoleIds = await resolveDepartmentRoleIds();
      
      // If eventId specified, only process that event
      let eventsSnap;
      if (eventId) {
        const eventDoc = await db.collection('events').doc(eventId).get();
        eventsSnap = { docs: eventDoc.exists ? [eventDoc] : [], size: eventDoc.exists ? 1 : 0 };
      } else {
        // Process all upcoming events (next 7 days)
        const now = new Date();
        const sevenDaysFromNow = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
        eventsSnap = await db.collection('events')
          .where('start', '>=', admin.firestore.Timestamp.fromDate(now))
          .where('start', '<', admin.firestore.Timestamp.fromDate(sevenDaysFromNow))
          .get();
      }
      
      for (const eventDoc of eventsSnap.docs) {
        const eventData = eventDoc.data();
        const eventTitle = eventData.title || 'Untitled Event';
        const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
        const eventDepartments = Array.isArray(eventData.departments) ? eventData.departments : [];
        const eventZone = eventData.zone || 'TBD';
        const eventManager = eventData.manager || 'TBD';
        const eventShortDesc = eventData.shortDesc || 'Details on events page.';
        
        const mentions = [];
        const mentionedRoleIds = [];
        if (lookingForRpRoleId) {
          mentions.push(formatRoleMention(lookingForRpRoleId));
          mentionedRoleIds.push(lookingForRpRoleId);
        }
        for (const dept of eventDepartments) {
          const deptRoleId = departmentRoleIds[dept];
          if (deptRoleId) {
            mentions.push(formatRoleMention(deptRoleId));
            mentionedRoleIds.push(deptRoleId);
          }
        }
        
        const payload = {
          content: mentions.length > 0 ? mentions.join(' ') : undefined,
          allowed_mentions: buildAllowedMentions({ roleIds: mentionedRoleIds }),
          embeds: [{
            title: '📅 Upcoming Event in 3 Days',
            description: `**${eventTitle}**\n\n${eventShortDesc}`,
            color: 0x00d9b5,
            fields: [
              { name: '⏰ Time', value: formatEventTime(eventStart), inline: false },
              { name: '🌍 Zone', value: eventZone, inline: true },
              { name: '🏢 Departments', value: eventDepartments.join(', ') || 'All', inline: true },
              { name: '👤 RP Manager', value: eventManager, inline: true }
            ],
            footer: { text: 'RSVP at site89.org/events [MANUAL TEST]' },
            url: 'https://site89.org/events/'
          }]
        };
        
        await sendDiscordNotification(webhookUrl, payload);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      res.json({ success: true, message: `Sent ${eventsSnap.size} notification(s)` });
    } else if (notificationType === 'day_of' || notificationType === 'thirty_min' || notificationType === 'start') {
      if (!eventId) {
        res.status(400).send('eventId required for this notification type');
        return;
      }
      
      const eventDoc = await db.collection('events').doc(eventId).get();
      if (!eventDoc.exists) {
        res.status(404).send('Event not found');
        return;
      }
      
      const eventData = eventDoc.data();
      const eventTitle = eventData.title || 'Untitled Event';
      const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
      const eventZone = eventData.zone || 'TBD';
      
      const { attendees: manualAttendees, mentionUserIds: manualMentions } = await getRsvpedUsers(eventId);

      if (manualAttendees.length === 0) {
        res.json({ success: true, message: 'No RSVPs found' });
        return;
      }

      const manualMentionStr = manualMentions.map(formatUserMention).join(' ');
      const manualAttendeeList = formatAttendeeList(manualAttendees);

      let title, description, color, fields;
      if (notificationType === 'day_of') {
        title = '📅 Event Today!';
        description = `**${eventTitle}** starts today!\n\nThe following characters are registered to attend:`;
        color = 0x00d9b5;
        fields = [
          { name: '⏰ Start Time', value: formatEventTime(eventStart), inline: false },
          { name: `Attendees (${manualAttendees.length})`, value: manualAttendeeList, inline: false }
        ];
      } else if (notificationType === 'thirty_min') {
        title = '⏰ Event Starting in 30 Minutes!';
        description = `**${eventTitle}** is starting soon!\n\nThe following characters are registered to attend:`;
        color = 0xFFA500;
        fields = [
          { name: '⏰ Start Time', value: formatEventTime(eventStart), inline: false },
          { name: `Attendees (${manualAttendees.length})`, value: manualAttendeeList, inline: false }
        ];
      } else {
        title = '🎬 Event Starting NOW!';
        description = `**${eventTitle}** is starting right now!\n\nJoin the ${eventZone} to participate:`;
        color = 0xFF0000;
        fields = [
          { name: `Attendees (${manualAttendees.length})`, value: manualAttendeeList, inline: false }
        ];
      }

      const payload = {
        content: manualMentionStr || undefined,
        allowed_mentions: buildAllowedMentions({ userIds: manualMentions }),
        embeds: [{
          title,
          description,
          color,
          fields,
          footer: { text: 'Site-89 Events [MANUAL TEST]' },
          url: 'https://site89.org/events/'
        }]
      };

      await sendDiscordNotification(webhookUrl, payload);
      res.json({
        success: true,
        message: `Sent notification to ${manualAttendees.length} attendees (${manualMentions.length} Discord ping(s))`,
        attendees: manualAttendees.map(a => ({ name: a.characterName, pinged: !!a.discordUserId }))
      });
    } else {
      res.status(400).json({ success: false, message: 'Invalid notification type' });
    }
  } catch (error) {
    console.error('Error in manual trigger:', error);
    res.status(500).json({ success: false, message: 'Error: ' + error.message });
  }
});

async function fetchPrintifyJson(pathname, apiKey) {
  const url = `https://api.printify.com/v1${pathname}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Printify request failed (${response.status}): ${body.substring(0, 280)}`);
  }

  return response.json();
}

function resolvePrintifyPriceCents(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (!variants.length) return null;

  const preferred = variants.find(v => v.is_enabled && typeof v.price === 'number') ||
    variants.find(v => typeof v.price === 'number');

  return preferred ? preferred.price : null;
}

function resolvePrintifyImageUrl(product) {
  if (typeof product?.image === 'string' && product.image.trim()) return product.image;
  if (typeof product?.image_url === 'string' && product.image_url.trim()) return product.image_url;

  const images = Array.isArray(product?.images) ? product.images : [];
  const candidate = images.find(img => typeof img?.src === 'string' && img.src.trim());
  return candidate ? candidate.src : '';
}

exports.getMerchProducts = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, message: 'Method not allowed' });
    return;
  }

  const envApiKey = String(process.env.PRINTIFY_API_KEY || '').trim();
  let configApiKey = '';
  try {
    const cfg = functions.config();
    configApiKey = String((cfg && cfg.printify && cfg.printify.api_key) || '').trim();
  } catch (_error) {
    configApiKey = '';
  }

  const apiKey = envApiKey || configApiKey;
  if (!apiKey) {
    res.status(500).json({
      success: false,
      message: 'Printify API key is not configured. Set PRINTIFY_API_KEY or functions config printify.api_key.'
    });
    return;
  }

  const limitRaw = Number.parseInt(String(req.query.limit || '12'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 24) : 12;

  const envShopId = String(process.env.PRINTIFY_SHOP_ID || '').trim();
  let configShopId = '';
  let storefrontUrl = String(process.env.PRINTIFY_STOREFRONT_URL || '').trim();
  try {
    const cfg = functions.config();
    configShopId = String((cfg && cfg.printify && cfg.printify.shop_id) || '').trim();
    if (!storefrontUrl) {
      storefrontUrl = String((cfg && cfg.printify && cfg.printify.storefront_url) || '').trim();
    }
  } catch (_error) {
    configShopId = '';
  }

  try {
    let shopId = envShopId || configShopId;
    if (!shopId) {
      const shopsPayload = await fetchPrintifyJson('/shops.json', apiKey);
      const shops = Array.isArray(shopsPayload) ? shopsPayload : [];
      if (!shops.length || !shops[0]?.id) {
        res.status(500).json({ success: false, message: 'No Printify shops found for this API key.' });
        return;
      }
      shopId = String(shops[0].id);
    }

    const productsPayload = await fetchPrintifyJson(`/shops/${shopId}/products.json?limit=${limit}`, apiKey);
    const productsRaw = Array.isArray(productsPayload?.data) ? productsPayload.data : [];

    const products = productsRaw
      .filter(product => product && product.visible !== false)
      .map(product => {
        const cents = resolvePrintifyPriceCents(product);
        const externalCandidate = product?.external;
        const externalUrl = (typeof externalCandidate?.url === 'string' && externalCandidate.url.trim())
          ? externalCandidate.url.trim()
          : storefrontUrl;

        return {
          id: String(product.id || ''),
          title: String(product.title || 'Untitled Product'),
          description: String(product.description || ''),
          imageUrl: resolvePrintifyImageUrl(product),
          priceCents: Number.isFinite(cents) ? cents : null,
          price: Number.isFinite(cents) ? Number((cents / 100).toFixed(2)) : null,
          externalUrl
        };
      })
      .filter(product => product.id && product.title);

    res.set('Cache-Control', 'public, max-age=300, s-maxage=900');
    res.status(200).json({
      success: true,
      shopId,
      storefrontUrl: storefrontUrl || 'https://site89.org/merch/',
      count: products.length,
      products
    });
  } catch (error) {
    console.error('Printify merch fetch error:', error);
    res.status(500).json({ success: false, message: 'Failed to load merch products.' });
  }
});
