# Role-Based Access Control System

## Overview

The Site-89 platform now uses a role-based access control system instead of hardcoded email addresses. This provides better scalability, security, and management of administrative privileges.

## User Roles

### 1. **User** (Default)
- Normal users with limited access
- Can view public content
- Can create and manage their own characters
- Can create their own anomalies, research logs, etc.
- No administrative privileges

### 2. **RAISA** (Internal Affairs/Research)
- Enhanced permissions for content review and management
- Can delete anomalies and research logs
- Can manage archived characters
- Can manage Groups of Interest (GOI) and Persons of Interest (POI)
- Can moderate forum content
- Can manage bank operations
- Can access internal affairs portals

### 3. **Admin**
- Full administrative access to the entire site
- Can manage all user roles and privileges
- Has access to a special "System Admin" character with unrestricted access
- Can delete user accounts
- Can modify any user's privilege level
- Can access all admin panels

## System Admin Character

When a user is promoted to **Admin** role, they automatically receive a special hidden character called "System Admin" that:

- Provides unrestricted access to all site features
- Does not appear in character selection lists
- Does not appear in personnel files or character listings
- Cannot be manually deleted or edited
- Is automatically created when a user is promoted to admin
- Is automatically removed when a user's admin status is revoked

## User Management

### Admin Panel
The admin panel at `/admin/` allows admins to:

1. **View all users** with their:
   - Email address
   - User ID (UID)
   - Assigned characters
   - Current privilege level

2. **Manage privilege levels** via dropdown:
   - Change user between User, RAISA, and Admin roles
   - Changes take effect immediately
   - System Admin character is automatically managed

3. **Delete users**:
   - Remove user accounts completely
   - Automatically cleans up associated System Admin character

4. **Search and filter**:
   - Search by email, UID, or character name
   - Filter by privilege level

### User Initialization

When users first authenticate, their user document is automatically created in Firestore with:
- Email address
- Default "User" role (with one important exception)
- Creation timestamp

**Special Case: Default Admin Account**  
The email address `jedi21132@gmail.com` is a protected account that:
- Automatically receives Admin role on first login
- **Cannot be downgraded** to lower privilege levels
- **Cannot be deleted** through the admin panel
- Shows as "(Default)" in the admin UI with a gold highlight
- Has a "Protected" status instead of a delete button
- Any attempts to modify this account are silently blocked for safety

This ensures the platform always has at least one administrative account that cannot be accidentally or maliciously removed.

Admins can manually initialize users from existing character data using the "Initialize Users" button.

## Firestore Structure

### Users Collection
```
users/
  {uid}/
    email: string
    role: "user" | "raisa" | "admin"
    createdAt: timestamp
    updatedAt: timestamp (optional)
```

### Character Document (with System Admin)
Characters for admin users now include a hidden System Admin character:
```
characters/
  system-admin-unrestricted/
    id: "system-admin-unrestricted"
    name: "System Admin"
    linkedUID: "{admin-user-uid}"
    clearance: 5
    isSystemAdmin: true
    hidden: true
    createdAt: timestamp
```

## Security Rules

### Helper Functions
The Firestore rules use helper functions to check user roles:

- `getUserRole()` - Fetches the user's role from the users collection
- `isRAISAOrHigher()` - Checks if user is RAISA or Admin
- `isAdmin()` - Checks if user is Admin
- `isADIOPersonnel()` - Alias for RAISA or higher

### Replace Checks
All hardcoded email checks have been replaced with role-based checks:

**Before:**
```javascript
function isAdmin() {
  return request.auth.token.email == 'jedi21132@gmail.com';
}
```

**After:**
```javascript
function isAdmin() {
  return request.auth != null && 
         getUserRole() == 'admin';
}
```

## Migration from Email-Based System

If you had a previous email-based system, the migration process is:

1. **Backup** existing Firestore data
2. **Deploy** new Firestore rules
3. **Deploy** new JavaScript files
4. **Access admin panel** at `/admin/`
5. **Click "Initialize Users"** to create user records from existing characters
6. **Assign privilege levels** to appropriate users via dropdown
7. **Verify access** for each privilege level

## Frontend Integration

### Checking User Role

In frontend code, you can check user role like this:

```javascript
import { getFirestore, doc, getDoc } from 'firebase-firestore';
import { getAuth } from 'firebase-auth';

async function checkUserRole() {
  const auth = getAuth();
  const db = getFirestore();
  const user = auth.currentUser;
  
  if (!user) return null;
  
  const userDoc = await getDoc(doc(db, 'users', user.uid));
  return userDoc.data()?.role; // Returns 'user', 'raisa', or 'admin'
}
```

### Filtering System Admin Character

When displaying character lists, exclude the System Admin character:

```javascript
const characters = snap.docs
  .map(doc => ({ id: doc.id, ...doc.data() }))
  .filter(char => !char.hidden); // This filters out System Admin
```

## Best Practices

1. **Don't hardcode emails** - Always use the role system
2. **Filter hidden characters** - Never show System Admin in UI
3. **Use helper functions** - Leverage Firestore rule helpers
4. **Test thoroughly** - Verify access levels after changes
5. **Audit regularly** - Review admin user list periodically
6. **Principle of least privilege** - Only grant RAISA/Admin when needed

## Troubleshooting

### User can't access resources
**Solution:** Check their role in the admin panel. They may have "User" role instead of RAISA/Admin.

### Access rules not working
**Solution:** 
1. Verify the `users/{uid}` document exists in Firestore
2. Check that the `role` field is set correctly
3. Verify Firestore rules have been deployed
4. Check browser console for error messages

### System Admin character showing in lists
**Solution:** 
1. Verify characters have `hidden: true` field set
2. Update character queries to filter: `.filter(char => !char.hidden)`

## Migration Checklist

- [ ] Backup Firestore data
- [ ] Deploy updated Firestore rules
- [ ] Deploy new JavaScript files
- [ ] Verify Firebase config is correct
- [ ] Access admin panel
- [ ] Run "Initialize Users"
- [ ] Assign RAISA roles to appropriate users
- [ ] Assign Admin role to trusted admins
- [ ] Test RAISA access
- [ ] Test Admin access
- [ ] Test User-level access
- [ ] Remove any old hardcoded email checks from code
- [ ] Update any scripts referencing old system
- [ ] Document any custom access control requirements

---

For questions or issues, contact system administrators via the admin panel.
