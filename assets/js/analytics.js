/**
 * Site-89 Analytics Dashboard
 * Fetches and visualizes data from multiple Google Sheets
 */

// Configuration
const CONFIG = {
    SPREADSHEET_ID: '1vrG2zt_MSuz3PaOyigeXPrPgBPGjOjSHtsNAcWJNo78',
    API_KEY: 'AIzaSyBjXG2673UmsqepdNywAeRInyOBoaiTUD4', // Replace with actual API key
    REFRESH_INTERVAL: 60000, // 60 seconds
    API_BASE: 'https://sheets.googleapis.com/v4/spreadsheets'
};

// Global state
let allSheetsData = {};
let chartInstances = {};

/**
 * Fetch list of all sheet names from the spreadsheet
 */
async function fetchSheetNames() {
    try {
        const url = `${CONFIG.API_BASE}/${CONFIG.SPREADSHEET_ID}?key=${CONFIG.API_KEY}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        return data.sheets.map(sheet => sheet.properties.title);
    } catch (error) {
        console.error('Error fetching sheet names:', error);
        throw error;
    }
}

/**
 * Fetch data from a specific sheet
 */
async function fetchSheetData(sheetName) {
    try {
        const range = encodeURIComponent(`${sheetName}!A1:Z1000`);
        const url = `${CONFIG.API_BASE}/${CONFIG.SPREADSHEET_ID}/values/${range}?key=${CONFIG.API_KEY}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        return parseSheetData(data.values);
    } catch (error) {
        console.error(`Error fetching sheet "${sheetName}":`, error);
        return null;
    }
}

/**
 * Parse raw sheet data into structured objects
 */
function parseSheetData(values) {
    if (!values || values.length === 0) {
        return { headers: [], rows: [] };
    }
    
    const headers = values[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const rows = [];
    
    for (let i = 1; i < values.length; i++) {
        const row = {};
        let hasData = false;
        
        for (let j = 0; j < headers.length; j++) {
            const value = values[i][j] || '';
            row[headers[j]] = value;
            if (value) hasData = true;
        }
        
        if (hasData) {
            rows.push(row);
        }
    }
    
    return { headers, rows };
}

/**
 * Load all sheets in parallel
 */
async function loadAllSheets() {
    showLoading(true);
    hideError();
    
    try {
        const sheetNames = await fetchSheetNames();
        console.log('Found sheets:', sheetNames);
        
        // Fetch all sheets in parallel
        const promises = sheetNames.map(async (name) => {
            const data = await fetchSheetData(name);
            return { name, data };
        });
        
        const results = await Promise.all(promises);
        
        // Store results
        allSheetsData = {};
        results.forEach(({ name, data }) => {
            if (data && data.rows.length > 0) {
                allSheetsData[name] = data;
            }
        });
        
        if (Object.keys(allSheetsData).length === 0) {
            throw new Error('No data found in any sheets');
        }
        
        // Render the dashboard
        renderDashboard();
        
    } catch (error) {
        showError(error.message);
        console.error('Error loading sheets:', error);
    } finally {
        showLoading(false);
    }
}

/**
 * Analyze data for a specific sheet
 */
function analyzeSheet(sheetName, data) {
    const insights = {
        name: sheetName,
        totalRecords: data.rows.length,
        fields: data.headers,
        distributions: {},
        trends: {},
        anomalies: []
    };
    
    // Analyze each field
    data.headers.forEach(field => {
        const values = data.rows.map(row => row[field]).filter(v => v);
        
        if (values.length === 0) return;
        
        // Compute distribution
        const distribution = {};
        values.forEach(value => {
            distribution[value] = (distribution[value] || 0) + 1;
        });
        
        insights.distributions[field] = distribution;
        
        // Check if it's a date field
        if (field.includes('date') || field.includes('expire')) {
            insights.trends[field] = analyzeDateField(values);
        }
        
        // Check for numeric fields
        if (values.every(v => !isNaN(parseFloat(v)))) {
            const numbers = values.map(v => parseFloat(v));
            insights.distributions[field + '_stats'] = {
                min: Math.min(...numbers),
                max: Math.max(...numbers),
                avg: numbers.reduce((a, b) => a + b, 0) / numbers.length
            };
        }
    });
    
    // Special analysis for expired IDs
    if (sheetName.toLowerCase().includes('expired') || sheetName.toLowerCase().includes('id')) {
        insights.expiryAnalysis = analyzeExpiredIDs(data);
    }
    
    return insights;
}

/**
 * Analyze date field for trends
 */
function analyzeDateField(dateStrings) {
    const dates = dateStrings
        .map(str => new Date(str))
        .filter(date => !isNaN(date));
    
    if (dates.length === 0) return null;
    
    const now = new Date();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const sixtyDays = 60 * 24 * 60 * 60 * 1000;
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    
    return {
        earliest: new Date(Math.min(...dates)),
        latest: new Date(Math.max(...dates)),
        within30Days: dates.filter(d => d - now < thirtyDays && d > now).length,
        within60Days: dates.filter(d => d - now < sixtyDays && d > now).length,
        within90Days: dates.filter(d => d - now < ninetyDays && d > now).length,
        expired: dates.filter(d => d < now).length
    };
}

/**
 * Analyze expired IDs specifically
 */
function analyzeExpiredIDs(data) {
    const now = new Date();
    const result = {
        total: data.rows.length,
        expired: 0,
        expiringSoon: { '30': 0, '60': 0, '90': 0 }
    };
    
    data.rows.forEach(row => {
        // Look for date fields
        Object.keys(row).forEach(key => {
            if (key.includes('date') || key.includes('expire')) {
                const date = new Date(row[key]);
                if (!isNaN(date)) {
                    const diff = date - now;
                    const days = diff / (24 * 60 * 60 * 1000);
                    
                    if (days < 0) {
                        result.expired++;
                    } else if (days <= 30) {
                        result.expiringSoon['30']++;
                    } else if (days <= 60) {
                        result.expiringSoon['60']++;
                    } else if (days <= 90) {
                        result.expiringSoon['90']++;
                    }
                }
            }
        });
    });
    
    return result;
}

/**
 * Analyze combined data from all sheets
 */
function analyzeCombined(allData) {
    const insights = {
        totalSheets: Object.keys(allData).length,
        totalRecords: 0,
        correlations: [],
        mismatches: []
    };
    
    // Calculate total records
    Object.values(allData).forEach(sheet => {
        insights.totalRecords += sheet.rows.length;
    });
    
    // Look for gender and class correlation
    const genderSheet = Object.keys(allData).find(name => 
        name.toLowerCase().includes('gender')
    );
    const classSheet = Object.keys(allData).find(name => 
        name.toLowerCase().includes('class')
    );
    
    if (genderSheet && classSheet) {
        insights.correlations.push({
            type: 'gender_class',
            description: 'Gender and Class data available for correlation',
            genderCount: allData[genderSheet].rows.length,
            classCount: allData[classSheet].rows.length
        });
        
        // Check for count mismatches
        if (allData[genderSheet].rows.length !== allData[classSheet].rows.length) {
            insights.mismatches.push({
                sheets: [genderSheet, classSheet],
                description: 'Record count mismatch between Gender and Class sheets',
                counts: {
                    [genderSheet]: allData[genderSheet].rows.length,
                    [classSheet]: allData[classSheet].rows.length
                }
            });
        }
    }
    
    return insights;
}

/**
 * Render the entire dashboard
 */
function renderDashboard() {
    // Clear existing chart instances
    Object.values(chartInstances).forEach(chart => {
        if (chart && typeof chart.destroy === 'function') {
            chart.destroy();
        }
    });
    chartInstances = {};
    
    // Analyze all sheets
    const analyses = {};
    Object.keys(allSheetsData).forEach(sheetName => {
        analyses[sheetName] = analyzeSheet(sheetName, allSheetsData[sheetName]);
    });
    
    // Analyze combined data
    const combinedInsights = analyzeCombined(allSheetsData);
    
    // Render components
    renderSummaryCards(analyses, combinedInsights);
    renderTabs(Object.keys(allSheetsData));
    renderSheetCharts(analyses);
    renderCombinedInsights(combinedInsights);
}

/**
 * Render summary cards at the top
 */
function renderSummaryCards(analyses, combinedInsights) {
    const container = document.getElementById('summary-cards');
    container.innerHTML = '';
    
    // Total sheets card
    container.innerHTML += `
        <div class="card">
            <div class="card-title">Total Sheets</div>
            <div class="card-value">${combinedInsights.totalSheets}</div>
            <div class="card-subtitle">Data sources</div>
        </div>
    `;
    
    // Total records card
    container.innerHTML += `
        <div class="card">
            <div class="card-title">Total Records</div>
            <div class="card-value">${combinedInsights.totalRecords}</div>
            <div class="card-subtitle">Across all sheets</div>
        </div>
    `;
    
    // Find largest sheet
    let largestSheet = { name: '', count: 0 };
    Object.entries(analyses).forEach(([name, analysis]) => {
        if (analysis.totalRecords > largestSheet.count) {
            largestSheet = { name, count: analysis.totalRecords };
        }
    });
    
    container.innerHTML += `
        <div class="card">
            <div class="card-title">Largest Dataset</div>
            <div class="card-value">${largestSheet.count}</div>
            <div class="card-subtitle">${largestSheet.name}</div>
        </div>
    `;
    
    // Last updated
    const now = new Date();
    container.innerHTML += `
        <div class="card">
            <div class="card-title">Last Updated</div>
            <div class="card-value">${now.toLocaleTimeString()}</div>
            <div class="card-subtitle">${now.toLocaleDateString()}</div>
        </div>
    `;
}

/**
 * Render tab buttons for each sheet
 */
function renderTabs(sheetNames) {
    const tabsContainer = document.getElementById('tabs');
    const contentsContainer = document.getElementById('tab-contents');
    
    tabsContainer.innerHTML = '';
    contentsContainer.innerHTML = '';
    
    sheetNames.forEach((sheetName, index) => {
        // Create tab button
        const button = document.createElement('button');
        button.className = `tab-button ${index === 0 ? 'active' : ''}`;
        button.textContent = sheetName;
        button.onclick = () => switchTab(sheetName);
        tabsContainer.appendChild(button);
        
        // Create tab content
        const content = document.createElement('div');
        content.id = `tab-${sheetName}`;
        content.className = `tab-content ${index === 0 ? 'active' : ''}`;
        content.innerHTML = `
            <section>
                <h2>📋 ${sheetName}</h2>
                <div class="chart-grid" id="charts-${sheetName}">
                    <!-- Charts will be inserted here -->
                </div>
            </section>
        `;
        contentsContainer.appendChild(content);
    });
}

/**
 * Switch active tab
 */
function switchTab(sheetName) {
    // Update buttons
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent === sheetName) {
            btn.classList.add('active');
        }
    });
    
    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
        if (content.id === `tab-${sheetName}`) {
            content.classList.add('active');
        }
    });
}

/**
 * Render charts for all sheets
 */
function renderSheetCharts(analyses) {
    Object.entries(analyses).forEach(([sheetName, analysis]) => {
        const container = document.getElementById(`charts-${sheetName}`);
        if (!container) return;
        
        container.innerHTML = '';
        
        // Create charts for each distribution
        Object.entries(analysis.distributions).forEach(([field, distribution]) => {
            // Skip stats objects
            if (field.endsWith('_stats')) return;
            
            // Limit to top 10 categories for readability
            const entries = Object.entries(distribution);
            const topEntries = entries
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10);
            
            if (topEntries.length === 0) return;
            
            const chartContainer = document.createElement('div');
            chartContainer.className = 'chart-container';
            
            const chartType = topEntries.length <= 6 ? 'pie' : 'bar';
            const canvasId = `chart-${sheetName}-${field}`.replace(/\s+/g, '-');
            
            chartContainer.innerHTML = `
                <div class="chart-title">${formatFieldName(field)}</div>
                <canvas id="${canvasId}"></canvas>
            `;
            
            container.appendChild(chartContainer);
            
            // Create chart after DOM update
            setTimeout(() => {
                const ctx = document.getElementById(canvasId);
                if (ctx) {
                    chartInstances[canvasId] = createChart(ctx, chartType, topEntries, field);
                }
            }, 0);
        });
        
        // Add expiry analysis if available
        if (analysis.expiryAnalysis) {
            renderExpiryChart(sheetName, analysis.expiryAnalysis, container);
        }
    });
}

/**
 * Create a Chart.js chart
 */
function createChart(ctx, type, data, label) {
    const labels = data.map(([key]) => key);
    const values = data.map(([, value]) => value);
    
    const colors = generateColors(labels.length);
    
    return new Chart(ctx, {
        type: type,
        data: {
            labels: labels,
            datasets: [{
                label: label,
                data: values,
                backgroundColor: colors,
                borderColor: colors.map(c => c.replace('0.7', '1')),
                borderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    display: type === 'pie',
                    position: 'bottom',
                    labels: {
                        color: '#e0e0e0',
                        font: { size: 11 }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: '#00d4ff',
                    bodyColor: '#ffffff'
                }
            },
            scales: type === 'bar' ? {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#a0a0a0' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                x: {
                    ticks: { color: '#a0a0a0' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            } : {}
        }
    });
}

/**
 * Render expiry analysis chart
 */
function renderExpiryChart(sheetName, expiryData, container) {
    const chartContainer = document.createElement('div');
    chartContainer.className = 'chart-container';
    const canvasId = `chart-${sheetName}-expiry`.replace(/\s+/g, '-');
    
    chartContainer.innerHTML = `
        <div class="chart-title">ID Expiration Status</div>
        <canvas id="${canvasId}"></canvas>
    `;
    
    container.appendChild(chartContainer);
    
    setTimeout(() => {
        const ctx = document.getElementById(canvasId);
        if (ctx) {
            chartInstances[canvasId] = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['Expired', 'Within 30 Days', 'Within 60 Days', 'Within 90 Days'],
                    datasets: [{
                        data: [
                            expiryData.expired,
                            expiryData.expiringSoon['30'],
                            expiryData.expiringSoon['60'],
                            expiryData.expiringSoon['90']
                        ],
                        backgroundColor: [
                            'rgba(255, 50, 50, 0.7)',
                            'rgba(255, 150, 50, 0.7)',
                            'rgba(255, 200, 50, 0.7)',
                            'rgba(50, 200, 255, 0.7)'
                        ],
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: {
                            display: true,
                            position: 'bottom',
                            labels: {
                                color: '#e0e0e0',
                                font: { size: 11 }
                            }
                        }
                    }
                }
            });
        }
    }, 0);
}

/**
 * Render combined insights section
 */
function renderCombinedInsights(insights) {
    const chartsContainer = document.getElementById('combined-charts');
    const insightsList = document.getElementById('insights-list');
    
    chartsContainer.innerHTML = '';
    insightsList.innerHTML = '';
    
    // Create comparison chart
    const chartContainer = document.createElement('div');
    chartContainer.className = 'chart-container';
    chartContainer.innerHTML = `
        <div class="chart-title">Records per Sheet</div>
        <canvas id="chart-combined-comparison"></canvas>
    `;
    chartsContainer.appendChild(chartContainer);
    
    setTimeout(() => {
        const ctx = document.getElementById('chart-combined-comparison');
        if (ctx) {
            const sheetNames = Object.keys(allSheetsData);
            const counts = sheetNames.map(name => allSheetsData[name].rows.length);
            
            chartInstances['chart-combined-comparison'] = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: sheetNames,
                    datasets: [{
                        label: 'Number of Records',
                        data: counts,
                        backgroundColor: 'rgba(0, 212, 255, 0.7)',
                        borderColor: 'rgba(0, 212, 255, 1)',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: true,
                    plugins: {
                        legend: {
                            display: false
                        }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: { color: '#a0a0a0' },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' }
                        },
                        x: {
                            ticks: { color: '#a0a0a0' },
                            grid: { color: 'rgba(255, 255, 255, 0.1)' }
                        }
                    }
                }
            });
        }
    }, 0);
    
    // Add text insights
    insightsList.innerHTML += `
        <li class="insight-item">
            📊 Total of ${insights.totalSheets} sheets with ${insights.totalRecords} combined records
        </li>
    `;
    
    if (insights.correlations.length > 0) {
        insights.correlations.forEach(corr => {
            insightsList.innerHTML += `
                <li class="insight-item">
                    🔗 ${corr.description} (${corr.genderCount} gender records, ${corr.classCount} class records)
                </li>
            `;
        });
    }
    
    if (insights.mismatches.length > 0) {
        insights.mismatches.forEach(mismatch => {
            const counts = Object.entries(mismatch.counts)
                .map(([sheet, count]) => `${sheet}: ${count}`)
                .join(', ');
            insightsList.innerHTML += `
                <li class="insight-item">
                    ⚠️ ${mismatch.description} (${counts})
                </li>
            `;
        });
    }
}

/**
 * Generate color palette
 */
function generateColors(count) {
    const colors = [];
    const hueStep = 360 / count;
    
    for (let i = 0; i < count; i++) {
        const hue = i * hueStep;
        colors.push(`hsla(${hue}, 70%, 60%, 0.7)`);
    }
    
    return colors;
}

/**
 * Format field name for display
 */
function formatFieldName(field) {
    return field
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Show/hide loading indicator
 */
function showLoading(show) {
    const loading = document.getElementById('loading');
    if (show) {
        loading.classList.add('active');
    } else {
        loading.classList.remove('active');
    }
}

/**
 * Show error message
 */
function showError(message) {
    const errorDiv = document.getElementById('error');
    const errorText = document.getElementById('error-text');
    errorText.textContent = message;
    errorDiv.classList.add('active');
}

/**
 * Hide error message
 */
function hideError() {
    const errorDiv = document.getElementById('error');
    errorDiv.classList.remove('active');
}

/**
 * Refresh all analytics data
 */
async function refreshAnalytics() {
    await loadAllSheets();
}

/**
 * Initialize the dashboard
 */
function init() {
    // Load data on page load
    refreshAnalytics();
    
    // Set up auto-refresh
    setInterval(refreshAnalytics, CONFIG.REFRESH_INTERVAL);
}

// Start when page loads
window.addEventListener('DOMContentLoaded', init);
