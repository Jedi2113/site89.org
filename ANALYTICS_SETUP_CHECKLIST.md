# Analytics Firebase Setup Checklist

Use this checklist to ensure everything is properly configured.

## Pre-Setup Requirements

- [ ] Firebase project is created and configured
- [ ] Firebase Auth is set up on your site
- [ ] Users can successfully authenticate
- [ ] You have Firebase Console access
- [ ] Browser supports ES6 modules (Chrome 61+, Firefox 67+, Safari 11+)

## Setup Steps

### Step 1: Firebase Console Configuration

- [ ] Open [Firebase Console](https://console.firebase.google.com)
- [ ] Select your project (Site-89)
- [ ] Go to **Firestore Database**
- [ ] Database is in "Locked Mode" or has security rules

### Step 2: Create Admin User

- [ ] In Firestore, navigate to `users` collection
- [ ] Click **Add Document**
- [ ] Set Document ID to admin user's UID (from Firebase Auth)
- [ ] Add fields:
  - [ ] `email`: (string) admin user's email
  - [ ] `isAdmin`: (boolean) `true`
- [ ] Click **Save**
- [ ] Verify the document was created

### Step 3: Update Firestore Security Rules

- [ ] Go to **Firestore** → **Rules** tab in Firebase Console
- [ ] Copy the rules from [FIREBASE_QUICK_START.md](FIREBASE_QUICK_START.md)
- [ ] Paste into the rules editor
- [ ] Click **Publish**
- [ ] Wait for deployment (usually < 30 seconds)
- [ ] See "Rules updated successfully" message

### Step 4: Verify File Structure

Check that these files exist in your repository:

**Core Files**
- [ ] `/analytics/index.html` - Dashboard page
- [ ] `/admin/analytics/index.html` - Editor page
- [ ] `/assets/js/analytics.js` - Dashboard logic
- [ ] `/assets/js/analytics-editor.js` - Editor logic
- [ ] `/assets/css/analytics.css` - Styling

**Documentation**
- [ ] `FIREBASE_QUICK_START.md`
- [ ] `FIREBASE_ANALYTICS_SETUP.md`
- [ ] `ANALYTICS_FIREBASE_README.md`
- [ ] `firestore.rules` (updated with analytics rules)

**Fallback Data** (optional)
- [ ] `/data/analytics.json` - Legacy JSON data (can be deleted)
- [ ] `/data/analytics-template.json` - Empty template

### Step 5: Test the Setup

#### Test Public Dashboard
- [ ] Open `/analytics/` in browser
- [ ] Page loads without errors
- [ ] Can see "Analytics Dashboard" heading
- [ ] Tab buttons are visible (Members, Events, Finance, Growth)
- [ ] Open browser console (F12) - no critical errors
- [ ] Check Network tab - Firebase calls are successful

#### Test Admin Authentication
- [ ] Log in with admin user account
- [ ] Open `/analytics/`
- [ ] Look for **"Edit Analytics"** button
- [ ] Button is visible (not hidden)
- [ ] Click button - redirects to `/admin/analytics/`

#### Test Editor Interface
- [ ] Editor page loads successfully
- [ ] See admin warning banner
- [ ] Tab buttons work (switch between sections)
- [ ] Forms are visible and functional
- [ ] Can fill out form fields

#### Test Data Entry
- [ ] Try adding a member entry (Members tab)
- [ ] Try adding an event (Events tab)
- [ ] Try adding an expense (Finance tab)
- [ ] See success messages after each action
- [ ] Items appear in the lists below

#### Test Firebase Save
- [ ] Click "Save to Firebase" button
- [ ] See loading animation
- [ ] Get "saved successfully" message
- [ ] Go back to `/analytics/`
- [ ] Verify data persists after page refresh
- [ ] Check Firestore in Firebase Console
- [ ] Verify `settings/analytics` document was created/updated

### Step 6: Verify Data in Firestore

- [ ] Open Firebase Console
- [ ] Go to **Firestore Database**
- [ ] Look for `settings` collection
- [ ] Inside, look for `analytics` document
- [ ] Document contains your analytics data
- [ ] Structure looks correct:
  ```
  analytics
  ├── members {...}
  ├── events {...}
  ├── finance {...}
  ├── statistics {...}
  ├── lastUpdated
  └── lastUpdatedBy
  ```

### Step 7: Add More Admin Users (Optional)

For each additional admin:
- [ ] Get their Firebase UID from Firebase Auth console
- [ ] Create new document in `users` collection
- [ ] Set Document ID to their UID
- [ ] Add `email` and `isAdmin: true` fields
- [ ] They can now access the editor

## Troubleshooting Checklist

### Analytics Dashboard Not Loading Data

- [ ] Check browser console for errors (F12)
- [ ] Verify network request to `/data/analytics.json` or Firestore
- [ ] Check that `settings/analytics` document exists in Firestore
- [ ] Verify Firestore read rules allow public access
- [ ] Check Firebase SDK is loaded (search for "firebasejs" in console)

### Can't See "Edit Analytics" Button

- [ ] Verify you're logged in (check navbar for user info)
- [ ] Confirm user is marked as admin in Firestore (`isAdmin: true`)
- [ ] Check browser console for JavaScript errors
- [ ] Try logging out and logging back in
- [ ] Check that Firestore rules are published

### "Permission Denied" Error When Saving

- [ ] Verify Firestore security rules are updated
- [ ] Check that `isAdmin` field is `true` (not string "true")
- [ ] Verify user document exists in `users` collection
- [ ] Check that you're authenticated (not logged out)
- [ ] Try hard refresh page (Ctrl+Shift+R or Cmd+Shift+R)

### Saved Data Not Appearing on Dashboard

- [ ] Verify "Save to Firebase" button shows success message
- [ ] Check Firestore document has the data
- [ ] Refresh analytics page (F5)
- [ ] Check browser console for errors
- [ ] Clear browser cache if data still doesn't appear

### Forms Not Working / Buttons Unresponsive

- [ ] Check JavaScript console for errors
- [ ] Verify `/assets/js/analytics-editor.js` is loaded
- [ ] Check that Firebase SDK is initialized
- [ ] Try hard refresh of the page
- [ ] Check browser compatibility (needs ES6 support)

### Firebase Rules Won't Deploy

- [ ] Check for syntax errors in rules
- [ ] Verify you copied rules correctly from documentation
- [ ] Look for red error message at bottom of editor
- [ ] Ensure you're in the Rules tab, not the Data tab
- [ ] Try clicking Publish again

## Post-Setup Verification

After completing all steps:

- [ ] Dashboard page accessible at `/analytics/`
- [ ] Editor page accessible at `/admin/analytics/` (admin only)
- [ ] Can view analytics without login
- [ ] Can access editor with admin login
- [ ] Can add data in editor forms
- [ ] Can save to Firebase successfully
- [ ] Saved data appears on dashboard
- [ ] Data persists after page refresh
- [ ] No critical errors in browser console
- [ ] Firestore document `settings/analytics` exists and is updated

## Performance Checklist

- [ ] Page loads in < 2 seconds
- [ ] Charts render smoothly
- [ ] No console warnings about unminified files
- [ ] Firebase API calls complete successfully
- [ ] Data saves in < 1 second
- [ ] Mobile view responsive and usable
- [ ] Tablet view properly formatted
- [ ] Browser supports ES6 modules

## Security Checklist

- [ ] Only admin users can see editor button
- [ ] Only admin users can save to Firebase
- [ ] Firestore rules prevent unauthorized writes
- [ ] Public can read analytics (transparent)
- [ ] User document has `isAdmin` field (not custom claims)
- [ ] No credentials stored in client code
- [ ] Firebase configuration is in auth.js (not hardcoded)
- [ ] Admin users are recorded in audit trail

## Backup & Maintenance Checklist

- [ ] Firestore backup created (in Firebase Console)
- [ ] Local JSON backup of analytics data (optional)
- [ ] Documentation reviewed by team
- [ ] Admin users trained on using editor
- [ ] Scheduled regular data exports
- [ ] Firestore monitoring enabled
- [ ] Firebase usage quotas reviewed
- [ ] Plan for scaling if data grows large

## Support Resources

If you encounter issues:

1. **Quick Start**: [FIREBASE_QUICK_START.md](FIREBASE_QUICK_START.md)
2. **Detailed Setup**: [FIREBASE_ANALYTICS_SETUP.md](FIREBASE_ANALYTICS_SETUP.md)
3. **Main README**: [ANALYTICS_FIREBASE_README.md](ANALYTICS_FIREBASE_README.md)
4. **Firebase Docs**: https://firebase.google.com/docs
5. **Firestore Rules**: https://firebase.google.com/docs/firestore/security/get-started

---

**Checklist Version**: 1.0  
**Last Updated**: January 19, 2026  
**Firebase SDK**: 12.6.0

## Completion Status

Total Items: 100+  
Completed: _____ / _____

✅ When you've completed all items, your analytics system is ready for production!
