# Analytics - Firebase Setup Instructions

## Overview
The analytics dashboard is fully configured and ready to use. This guide covers the Firebase setup that's already been done and how to manage it going forward.

## ✅ Already Configured

### Firestore Security Rules
The `firestore.rules` file has been updated with the following analytics rules:

```
// Analytics settings with event markers
match /settings/analytics {
  allow read: if true;  // Public read
  allow write: if request.auth.token.email == 'jedi21132@gmail.com';
  
  match /markers/{markerId} {
    allow read: if true;
    allow create, update, delete: if request.auth.token.email == 'jedi21132@gmail.com';
  }
}

// Finance settings
match /settings/finance {
  allow read: if true;  // Public read
  allow write: if request.auth.token.email == 'jedi21132@gmail.com';
}
```

### Collections Used

1. **characters** (existing)
   - Used for: Member count tracking
   - Fields tracked: `createdAt`, `linkedUID`
   - Data: Auto-populated by character creation

2. **forum-threads** (existing)
   - Used for: Event attendance, events hosted
   - Fields tracked: `title`, `createdAt`, `replyCount`
   - Data: Auto-populated by forum posts

3. **settings** (document)
   - Sub-documents:
     - `settings/analytics` - Event markers and analytics settings
     - `settings/finance` - Budget and finance data

## 📋 Initial Data Setup

### Option 1: Automatic (Recommended)
The analytics page will automatically use default data if `settings/finance` doesn't exist:

```json
{
  "monthlyUpkeep": [
    { "month": "Jan", "amount": 150 },
    { "month": "Feb", "amount": 155 },
    { "month": "Mar", "amount": 160 }
  ],
  "founderContributions": [
    { "name": "Founder 1", "amount": 100 },
    { "name": "Founder 2", "amount": 80 }
  ],
  "totalMonthlyBudget": 230,
  "notes": ""
}
```

### Option 2: Manual Setup
If you want to pre-populate custom data:

1. Go to Firebase Console → Firestore Database
2. Create document: `settings` → `finance`
3. Add the fields above with your custom data
4. Dashboard will load this data immediately

## 🔐 Authorization

### Who Can Edit?
Only `jedi21132@gmail.com` can:
- Add/edit event markers
- Edit finance data
- Modify analytics settings

### How to Add Another Admin
To allow another email to manage analytics:

1. **Option A (Easy):** Update both places
   - Modify the email check in `/assets/js/analytics.js` (search for AUTHORIZED_EMAIL)
   - Modify the email check in `/assets/js/analytics-editor.js`
   - Update the Firestore rule to include the new email

2. **Option B (Proper):** Use Firestore rules
   ```
   // In firestore.rules, modify the condition:
   let analyticsAdmins = [
     'jedi21132@gmail.com',
     'newemail@example.com'
   ];
   
   allow write: if request.auth.token.email in analyticsAdmins;
   ```

## 📊 Data Structure Reference

### Event Markers Document
```
/settings/analytics/markers/{markerId}
├── date: "2024-07-15" (string, YYYY-MM-DD)
├── title: "Trailer Release" (string)
├── description: "Official YouTube trailer launched" (string)
└── createdAt: Timestamp (2024-07-15T.....)
```

### Finance Document
```
/settings/finance
├── monthlyUpkeep: [
│   ├── month: "Jan" (string)
│   └── amount: 150 (number)
│   ├── month: "Feb"
│   └── amount: 155
│   └── ...
├── founderContributions: [
│   ├── name: "Founder 1" (string)
│   └── amount: 100 (number)
│   ├── name: "Founder 2"
│   └── amount: 80
│   └── ...
├── totalMonthlyBudget: 230 (number)
└── notes: "Additional finance notes..." (string)
```

## 🔄 Data Management

### Adding Event Markers
**Method 1: Web Interface (Recommended)**
1. Go to `/analytics/`
2. Click "Add Event Marker" button
3. Fill form and submit
4. Data auto-saved to Firestore

**Method 2: Firebase Console**
1. Go to Firebase Console → Firestore
2. Create doc in `settings/analytics/markers/{uniqueId}`
3. Add fields: `date`, `title`, `description`, `createdAt`

### Updating Finance Data
**Method 1: Web Interface (Recommended)**
1. Go to `/admin/analytics/`
2. Edit upkeep costs, founder contributions
3. Click "Save All Changes"
4. Data auto-saved to Firestore

**Method 2: Firebase Console**
1. Go to Firestore → `settings` → `finance`
2. Edit fields directly
3. Changes appear on dashboard instantly

## 🚨 Important Notes

### Backup Considerations
- All analytics data is stored in Firestore
- Firestore has built-in versioning/recovery
- Regular exports recommended for critical data
- Use Firebase backup features if available in your plan

### Data Consistency
- Member count: Auto-calculated from `characters` collection
- Event attendance: Auto-calculated from `forum-threads`
- Finance data: Manual entry only
- Markers: Manual entry only

### Performance
- All reads are public (optimized for caching)
- Writes are restricted to one admin
- Minimal write operations required
- Data fetched fresh on each page load

## 🛠️ Maintenance Tasks

### Monthly
- Update finance data if costs change
- Review member growth metrics
- Check event attendance trends

### Quarterly
- Review/update founder contributions
- Ensure event markers are current
- Archive old financial data if needed

### As Needed
- Add event markers for important milestones
- Adjust budget forecasts
- Update finance notes with context

## 📈 Scaling Considerations

If you need to expand analytics:

### Add Real-Time Updates
Currently: One-time fetch per page load
To change: Add Firebase real-time listeners
```javascript
// Example (would need to be added)
const q = query(collection(db, 'characters'));
onSnapshot(q, (snapshot) => {
  // Update member count in real-time
});
```

### Add More Metrics
- Department-specific statistics
- User engagement metrics
- Anomaly creation trends
- Research log activity

### Add Export Functionality
- CSV export for spreadsheet analysis
- PDF reports for presentations
- Email scheduling for reports

## 🔍 Troubleshooting Firebase Issues

### Collections Not Appearing
1. Check Firestore Console for data
2. Ensure documents exist in collections
3. Verify field names match exactly
4. Check read permissions in rules

### Markers Not Saving
1. Verify email is exactly `jedi21132@gmail.com`
2. Check Firestore rules allow writes
3. Look for errors in browser console (F12)
4. Check network tab for failed requests

### Finance Data Not Loading
1. Ensure `settings/finance` document exists
2. Check field structure matches expected format
3. Verify read permissions are set to public
4. Reload page and try again

### Authorization Issues
1. Log out completely
2. Clear browser cookies
3. Log back in
4. Verify email matches authorized email

## 📚 Related Files

- **Dashboard:** `/analytics/index.html`
- **Editor:** `/admin/analytics/index.html`
- **Styles:** `/assets/css/analytics.css`
- **Logic:** `/assets/js/analytics.js`, `analytics-editor.js`
- **Rules:** `/firestore.rules`
- **Docs:** `/ANALYTICS_GUIDE.md`, `/ANALYTICS_QUICKSTART.md`

## 🚀 Deployment

The analytics system is already deployed:
1. All files are in the repository
2. Firestore rules are configured
3. No additional deployment steps needed
4. Changes to data will appear immediately

To redeploy Firebase rules:
```bash
firebase deploy --only firestore:rules
```

## 📞 Support

For Firebase-specific issues:
- Check Firebase Console → Firestore
- Review browser console (F12) for errors
- Check network tab for connection issues
- Verify Firestore rules in Console

---

**Last Updated:** January 2026
**Firebase Status:** ✅ Configured and Ready
