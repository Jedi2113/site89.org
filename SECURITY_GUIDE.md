# Security Best Practices Guide

Quick reference for development on Site-89

---

## DO ✅

### Content Security
- **Always verify clearance server-side** - Never trust localStorage for authorization
- **Use `textContent` for user data** - When setting element text from user input
- **Create elements safely** - Use `createElement()` + `appendChild()` instead of `innerHTML`
- **Validate image URLs** - Use `isValidImageUrl()` from `sanitize.js`
- **Fetch fresh data from Firebase** - Don't pass user data through DOM attributes

### Authentication
- **Verify user ownership** - Check `linkedUID === auth.currentUser.uid`
- **Check roles in database** - Don't trust client-side email/role claims
- **Fail securely** - Redirect to 403 on auth errors, never allow access
- **Block page until verified** - Use `secure-access.js` pattern for restricted content

### Code Examples

**Safe Character Rendering:**
```javascript
const card = document.createElement('div');
const nameEl = document.createElement('h3');
nameEl.textContent = character.name;  // ✅ Safe - no HTML parsing
card.appendChild(nameEl);
```

**Unsafe (DON'T DO THIS):**
```javascript
const card = document.createElement('div');
card.innerHTML = `<h3>${character.name}</h3>`;  // ❌ XSS Risk!
```

**Safe Character Selection:**
```javascript
// ✅ Fetch from Firebase, verify ownership
const charRef = doc(db, 'characters', charId);
const charSnap = await getDoc(charRef);
if (charSnap.data().linkedUID !== user.uid) {
  alert("Not your character");
  return;
}
localStorage.setItem('selectedCharacter', JSON.stringify(charSnap.data()));
```

**Unsafe (DON'T DO THIS):**
```javascript
// ❌ Trust DOM attributes
const charData = JSON.parse(button.getAttribute('data-char-data'));
localStorage.setItem('selectedCharacter', JSON.stringify(charData));
```

---

## DON'T ❌

### Content Security
- ❌ Don't use `innerHTML` with user data
- ❌ Don't trust localStorage for authorization decisions
- ❌ Don't allow data in DOM attributes (can be modified)
- ❌ Don't skip verification of user ownership
- ❌ Don't use only email/client-side checks for roles

### Authentication
- ❌ Don't check only `user.email` for admin status
- ❌ Don't trust clearance from localStorage for page access
- ❌ Don't fail open (allow access when verification fails)
- ❌ Don't render page before clearance verified

### Code Examples

**❌ Bad: Trust HTML Data Attributes**
```javascript
const data = JSON.parse(element.dataset.userData);  // User could modify!
useThisData(data);
```

**✅ Good: Fetch from Firebase**
```javascript
const snap = await getDoc(doc(db, 'collection', id));
const data = snap.data();  // From database, authoritative
useThisData(data);
```

**❌ Bad: Use innerHTML with Variables**
```javascript
element.innerHTML = `<p>${userInput}</p>`;  // Enables XSS!
```

**✅ Good: Use textContent**
```javascript
element.textContent = userInput;  // Safe - text only
```

---

## Adding Clearance Protection to New Pages

To protect a new page with clearance requirements:

### 1. Add Meta Tag
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script src="/assets/js/secure-access.js"></script>
  <!-- ↑ This MUST come right after charset -->
  
  <meta name="required-clearance" content="1">
  <!-- Set to: 0 (none), 1 (low), 2, 3, 4, 5 (max) -->
```

### 2. How It Works
1. **secure-access.js** runs IMMEDIATELY (before content renders)
2. Page is hidden (`opacity: 0, pointerEvents: none`)
3. Script fetches clearance from Firebase database
4. If user has sufficient clearance → page shown
5. If not → redirected to /403/

### 3. No Additional Code Needed
The script handles everything automatically. Just add the meta tag!

---

## Sanitizing User Input for Display

Use these utilities from `/assets/js/sanitize.js`:

```javascript
import { 
  escapeHtml, 
  setSafeText, 
  createSafeElement,
  isValidImageUrl,
  setSafeImageSrc 
} from '/assets/js/sanitize.js';

// Display user name safely
setSafeText(nameElement, userData.name);

// Create safe element with text
const card = createSafeElement('div', userData.name, 'user-card');

// Set image safely (prevent data:// and javascript: URLs)
if (isValidImageUrl(userData.photoUrl)) {
  setSafeImageSrc(imgElement, userData.photoUrl, '/default.png');
}
```

---

## Verifying Character Ownership

Every operation that uses a character should verify ownership:

```javascript
// User selecting a character
const char = (await getDoc(doc(db, 'characters', charId))).data();
if (char.linkedUID !== auth.currentUser.uid) {
  return;  // Deny - character belongs to someone else
}

// User editing their profile
const myChars = await getDocs(
  query(collection(db, 'characters'), where('linkedUID', '==', user.uid))
);
// User can only edit chars from this list
```

---

## Firestore Best Practices

### Document Structure
```
/characters/{charId}
  - id: string (doc ID)
  - linkedUID: string (CRITICAL: who owns this character)
  - name: string
  - clearance: number
  - department: string
  - profileImage: string (URL)
  - bio: string

/personnel/{pid}
  - name: string
  - clearance: number
  - department: string
  - rank: string
  - class: string

/admins/{userId}
  - email: string
  - role: "admin"
  - addedAt: timestamp
```

### Query Safely
```javascript
// ✅ Only get current user's characters
const q = query(
  collection(db, 'characters'),
  where('linkedUID', '==', auth.currentUser.uid)
);

// ❌ DON'T do this - gets everyone's characters
const all = await getDocs(collection(db, 'characters'));
```

---

## Common Vulnerabilities

### 1. "Flash of Content"
**Problem:** Restricted content visible during page load  
**Solution:** Use `secure-access.js` - blocks rendering until verified

### 2. "Clearance Spoofing"
**Problem:** User modifies localStorage.selectedCharacter.clearance  
**Solution:** Always fetch clearance from Firebase, ignore localStorage

### 3. "Character Hijacking"
**Problem:** User modifies data attributes to select someone else's character  
**Solution:** Fetch fresh from Firebase + verify linkedUID ownership

### 4. "XSS via Character Name"
**Problem:** Character named `<img src=x onerror=alert('xss')>`  
**Solution:** Use `textContent`, never `innerHTML` with user data

### 5. "Admin Bypass"
**Problem:** User changes their email in client-side code  
**Solution:** Always verify admin status in Firebase database

---

## Security Checklist for Code Review

Before merging new code:

- [ ] No `innerHTML` assignments with user data?
- [ ] Clearance verified server-side (Firebase)?
- [ ] Character ownership checked (`linkedUID`)?
- [ ] Admin status verified in database?
- [ ] Image URLs validated with `isValidImageUrl()`?
- [ ] Data attributes don't contain sensitive data?
- [ ] Restricted pages have `secure-access.js` loaded?
- [ ] Error states don't leak information?
- [ ] Form submissions validated before sending?

---

## Emergency Security Issues

### If You Suspect an Attack:
1. Check browser console for errors
2. Check Firebase auth logs
3. Review recent admin changes
4. Check character ownership (linkedUID)
5. Review Firestore security rules
6. Check for modified DOM attributes

### Reporting
Contact: [ADMIN EMAIL]

---

**Last Updated:** January 2, 2026  
**Version:** 1.0
